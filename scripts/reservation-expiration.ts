import 'dotenv/config';
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { DeliveriesService } from '../src/deliveries/deliveries.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { PaymentProcessorService } from '../src/payments/payment-processor.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReservationExpirationService } from '../src/reservations/reservation-expiration/reservation-expiration.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';

const prisma = new PrismaService();

const deliveriesService = new DeliveriesService(prisma);

const paymentProcessor = new PaymentProcessorService(prisma, deliveriesService);

const reservationsService = new ReservationsService(prisma);

const expirationService = new ReservationExpirationService(prisma);

async function availableKeyCount(productId: string) {
  return prisma.productKey.count({
    where: {
      productId,

      delivery: {
        is: null,
      },

      reservation: {
        is: null,
      },
    },
  });
}

async function createSingleKeyProduct(prefix: string) {
  const runId = randomUUID();

  return prisma.product.create({
    data: {
      sku: `TEST-${prefix}-${runId}`,
      name: `Тест ${prefix}`,
      type: 'key',
      price: 149000,
      currency: 'RUB',
      isActive: true,

      productKeys: {
        create: {
          code: `TEST-KEY-${prefix}-${runId}`,
        },
      },
    },
  });
}

/*
 * Проверяем:
 *
 * RESERVED → AVAILABLE
 *
 * а также возможность повторно забронировать тот же ключ.
 */
async function runExpirationScenario() {
  console.log('\nЗапуск: reservation-expiration');

  const product = await createSingleKeyProduct('EXPIRATION');

  assert.equal(
    await availableKeyCount(product.id),
    1,
    'Изначально должен быть один свободный ключ',
  );

  const firstOrder = await reservationsService.reserveProduct({
    productId: product.id,
    idempotencyKey: randomUUID(),
    expectedPrice: product.price,
  });

  const firstReservation = await prisma.reservation.findUniqueOrThrow({
    where: {
      orderId: firstOrder.id,
    },
  });

  assert.equal(
    await availableKeyCount(product.id),
    0,
    'После оформления ключ должен быть забронирован',
  );

  /*
   * Не ждём пять минут — искусственно делаем бронь
   * просроченной.
   */
  await prisma.reservation.update({
    where: {
      id: firstReservation.id,
    },
    data: {
      expiresAt: new Date(Date.now() - 1_000),
    },
  });

  const expirationResult = await expirationService.expireOne(
    firstReservation.id,
  );

  assert.equal(
    expirationResult?.status,
    'expired',
    'Worker должен снять просроченную бронь',
  );

  const expiredOrder = await prisma.order.findUniqueOrThrow({
    where: {
      id: firstOrder.id,
    },
  });

  assert.equal(expiredOrder.status, 'expired');

  assert.equal(
    await prisma.reservation.count({
      where: {
        orderId: firstOrder.id,
      },
    }),
    0,
    'Просроченная бронь должна быть удалена',
  );

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: firstOrder.id,
      },
    }),
    0,
    'Просроченный заказ не должен получить ключ',
  );

  assert.equal(
    await availableKeyCount(product.id),
    1,
    'После истечения ключ должен вернуться в продажу',
  );

  /*
   * Проверяем, что освобождённый ключ действительно
   * можно забронировать повторно.
   */
  const secondOrder = await reservationsService.reserveProduct({
    productId: product.id,
    idempotencyKey: randomUUID(),
    expectedPrice: product.price,
  });

  const secondReservation = await prisma.reservation.findUniqueOrThrow({
    where: {
      orderId: secondOrder.id,
    },
  });

  assert.equal(
    secondReservation.productKeyId,
    firstReservation.productKeyId,
    'Повторный заказ должен забронировать освобождённый ключ',
  );

  /*
   * Поздняя оплата старого заказа не должна забрать ключ
   * у нового покупателя.
   */
  const lateEventId = `evt-late-${randomUUID()}`;

  await prisma.paymentEvent.create({
    data: {
      eventId: lateEventId,
      orderId: firstOrder.id,
      status: 'paid',
      amount: new Prisma.Decimal(firstOrder.amount).div(100),
      currency: firstOrder.currency,
      occurredAt: new Date(),
    },
  });

  await paymentProcessor.processOne(lateEventId);

  const lateEvent = await prisma.paymentEvent.findUniqueOrThrow({
    where: {
      eventId: lateEventId,
    },
  });

  assert.equal(lateEvent.processingResult, 'ignored_expired_order');

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: firstOrder.id,
      },
    }),
    0,
    'Поздняя оплата не должна выдать ключ просроченному заказу',
  );

  const survivingReservation = await prisma.reservation.findUniqueOrThrow({
    where: {
      orderId: secondOrder.id,
    },
  });

  assert.equal(
    survivingReservation.productKeyId,
    firstReservation.productKeyId,
    'Поздняя оплата не должна удалить новую бронь',
  );

  /*
   * Освобождаем вторую тестовую бронь.
   */
  await prisma.reservation.update({
    where: {
      id: secondReservation.id,
    },
    data: {
      expiresAt: new Date(Date.now() - 1_000),
    },
  });

  await expirationService.expireOne(secondReservation.id);

  await prisma.product.update({
    where: {
      id: product.id,
    },
    data: {
      isActive: false,
    },
  });

  console.log('OK: просроченная бронь снята, ключ повторно доступен');
}

/*
 * Проверяем одновременный запуск:
 *
 * - PaymentProcessor;
 * - ReservationExpirationService.
 */
async function runPaymentVsExpirationScenario() {
  console.log('\nЗапуск: payment-vs-expiration');

  const product = await createSingleKeyProduct('PAYMENT-RACE');

  const order = await reservationsService.reserveProduct({
    productId: product.id,
    idempotencyKey: randomUUID(),
    expectedPrice: product.price,
  });

  const reservation = await prisma.reservation.findUniqueOrThrow({
    where: {
      orderId: order.id,
    },
  });

  const receivedAt = new Date();

  /*
   * Платёж считается полученным до окончания брони.
   */
  const expiresAt = new Date(receivedAt.getTime() + 100);

  const eventId = `evt-payment-race-${randomUUID()}`;

  /*
   * Сохраняем новый deadline и платёж атомарно.
   */
  await prisma.$transaction([
    prisma.reservation.update({
      where: {
        id: reservation.id,
      },
      data: {
        expiresAt,
      },
    }),

    prisma.paymentEvent.create({
      data: {
        eventId,
        orderId: order.id,
        status: 'paid',
        amount: new Prisma.Decimal(order.amount).div(100),
        currency: order.currency,
        occurredAt: receivedAt,
        receivedAt,
      },
    }),
  ]);

  /*
   * Дожидаемся, чтобы бронь формально стала просроченной.
   */
  await delay(150);

  /*
   * Запускаем оплату и истечение одновременно.
   */
  await Promise.all([
    expirationService.expireOne(reservation.id),
    paymentProcessor.processOne(eventId),
  ]);

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: {
      id: order.id,
    },
  });

  const finalEvent = await prisma.paymentEvent.findUniqueOrThrow({
    where: {
      eventId,
    },
  });

  const delivery = await prisma.delivery.findUnique({
    where: {
      orderId: order.id,
    },
  });

  assert.equal(
    finalOrder.status,
    'delivered',
    'Вовремя полученная оплата должна победить истечение',
  );

  assert.equal(finalEvent.processingResult, 'delivered');

  assert.ok(delivery, 'Должна существовать выдача');

  assert.equal(
    delivery.productKeyId,
    reservation.productKeyId,
    'Должен быть выдан именно забронированный ключ',
  );

  assert.equal(
    await prisma.reservation.count({
      where: {
        orderId: order.id,
      },
    }),
    0,
    'После выдачи бронь должна быть удалена',
  );

  assert.equal(
    await availableKeyCount(product.id),
    0,
    'Выданный ключ не должен вернуться в продажу',
  );

  await prisma.product.update({
    where: {
      id: product.id,
    },
    data: {
      isActive: false,
    },
  });

  console.log('OK: своевременная оплата победила истечение брони');
}

async function main() {
  await prisma.$connect();

  await runExpirationScenario();
  await runPaymentVsExpirationScenario();

  console.log('\nВсе проверки бронирования пройдены.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
