import 'dotenv/config';
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { DeliveriesService } from '../src/deliveries/deliveries.service.js';
import { PaymentProcessorService } from '../src/payments/payment-processor.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const API_URL = (process.env.TEST_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

const CONCURRENCY = 50;

const prisma = new PrismaService();

// В этом тесте зависимости передаём вручную.
// Nest-приложение и его планировщик здесь не запускаем.
const deliveries = new DeliveriesService(prisma);
const processor = new PaymentProcessorService(prisma, deliveries);

type OrderResponse = {
  id: string;
  amount: number;
  currency: string;
};

type WebhookResponse = {
  accepted: boolean;
  duplicate: boolean;
};

async function post<T>(
  path: string,
  body: unknown,
  expectedStatus: number,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();

  assert.equal(
    response.status,
    expectedStatus,
    `${path}: HTTP ${response.status}\n${text}`,
  );

  return JSON.parse(text) as T;
}

// Дожидаемся всех запросов, даже если один завершился ошибкой.
async function parallel<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);

  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Завершились ошибкой ${errors.length} параллельных операций`,
    );
  }

  return results.map((result) => {
    if (result.status === 'rejected') {
      throw result.reason;
    }

    return result.value;
  });
}

async function freeKeyCount(productId: string) {
  return prisma.productKey.count({
    where: {
      productId,
      delivery: {
        is: null,
      },
    },
  });
}

async function waitForProcessing(eventIds: string[]) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const processedCount = await prisma.paymentEvent.count({
      where: {
        eventId: {
          in: eventIds,
        },
        processedAt: {
          not: null,
        },
      },
    });

    if (processedCount === eventIds.length) {
      return;
    }

    await delay(250);
  }

  throw new Error(
    'События не обработаны за 60 секунд. Проверь логи API и планировщик.',
  );
}

async function verifyDelivery(
  productId: string,
  orderId: string,
  freeBefore: number,
) {
  const order = await prisma.order.findUniqueOrThrow({
    where: {
      id: orderId,
    },
  });

  assert.equal(order.status, 'delivered');

  const orderDeliveries = await prisma.delivery.findMany({
    where: {
      orderId,
    },
    include: {
      productKey: true,
    },
  });

  assert.equal(
    orderDeliveries.length,
    1,
    'У заказа должна быть ровно одна выдача',
  );

  const delivery = orderDeliveries[0]!;

  assert.equal(
    delivery.productKey.productId,
    productId,
    'Выдан ключ другого товара',
  );

  assert.equal(
    await freeKeyCount(productId),
    freeBefore - 1,
    'Из пула должен быть использован ровно один ключ',
  );

  return delivery;
}

async function runScenario(
  productId: string,
  mode: 'same-event' | 'different-events' | 'parallel-processor',
) {
  console.log(`\nЗапуск: ${mode}`);

  const idempotencyKey = randomUUID();
  const freeBefore = await freeKeyCount(productId);

  assert.ok(freeBefore > 0, 'В тестовом пуле нет ключей');

  const createRequestCount = mode === 'parallel-processor' ? 1 : CONCURRENCY;

  const orders = await parallel(
    Array.from({ length: createRequestCount }, () =>
      post<OrderResponse>(
        '/orders',
        {
          productId,
          idempotencyKey,
        },
        201,
      ),
    ),
  );

  const order = orders[0]!;

  assert.equal(
    new Set(orders.map((item) => item.id)).size,
    1,
    'Повторные запросы создали разные заказы',
  );

  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyKey,
      },
    }),
    1,
    'В БД должен существовать один заказ',
  );

  const eventCount = mode === 'same-event' ? 1 : CONCURRENCY;

  const eventIds = Array.from(
    { length: eventCount },
    () => `evt_${randomUUID()}`,
  );

  const createdAt = new Date().toISOString();

  const payloads = eventIds.map((eventId) => ({
    event_id: eventId,
    order_id: order.id,
    status: 'paid' as const,
    amount: order.amount / 100,
    currency: order.currency,
    created_at: createdAt,
  }));

  if (mode === 'parallel-processor') {
    // Подготавливаем события напрямую, чтобы отдельно проверить
    // одновременный запуск транзакционных обработчиков.
    await prisma.paymentEvent.createMany({
      data: payloads.map((payload) => ({
        eventId: payload.event_id,
        orderId: payload.order_id,
        status: payload.status,
        amount: payload.amount,
        currency: payload.currency,
        occurredAt: new Date(payload.created_at),
      })),
    });

    await parallel(eventIds.map((eventId) => processor.processOne(eventId)));
  } else {
    const requests = Array.from({ length: CONCURRENCY }, (_, index) =>
      post<WebhookResponse>(
        '/webhook/payment',
        payloads[mode === 'same-event' ? 0 : index]!,
        200,
      ),
    );

    const responses = await parallel(requests);

    assert.ok(
      responses.every((response) => response.accepted === true),
      'Все webhook должны быть приняты',
    );

    const expectedDuplicates = mode === 'same-event' ? CONCURRENCY - 1 : 0;

    assert.equal(
      responses.filter((response) => response.duplicate).length,
      expectedDuplicates,
      'Неожиданное количество дубликатов',
    );
  }

  await waitForProcessing(eventIds);

  assert.equal(
    await prisma.paymentEvent.count({
      where: {
        orderId: order.id,
      },
    }),
    eventCount,
    'Неожиданное количество событий в БД',
  );

  const firstDelivery = await verifyDelivery(productId, order.id, freeBefore);

  // Повторяем событие уже после завершённой выдачи.
  const repeatedResponse = await post<WebhookResponse>(
    '/webhook/payment',
    payloads[0]!,
    200,
  );

  assert.equal(repeatedResponse.duplicate, true);

  // Проверяем также повторный непосредственный вызов обработчика.
  await processor.processOne(eventIds[0]!);

  const repeatedDelivery = await verifyDelivery(
    productId,
    order.id,
    freeBefore,
  );

  assert.equal(repeatedDelivery.id, firstDelivery.id);
  assert.equal(repeatedDelivery.productKeyId, firstDelivery.productKeyId);

  console.log(`OK: ${mode}; заказ ${order.id}; одна выдача, один ключ`);
}

async function main() {
  await prisma.$connect();

  // Отдельный товар при каждом запуске:
  // старые заказы и остатки не влияют на результат.
  const runId = randomUUID();

  const product = await prisma.product.create({
    data: {
      sku: `TEST-CONCURRENCY-${runId}`,
      name: 'Тест параллельной выдачи',
      type: 'key',
      price: 129000,
      currency: 'RUB',
      isActive: true,
      productKeys: {
        create: Array.from({ length: 10 }, (_, index) => ({
          code: `TEST-${runId}-${index}`,
        })),
      },
    },
  });

  console.log(`Тестовый товар: ${product.id}`);

  await runScenario(product.id, 'same-event');
  await runScenario(product.id, 'different-events');
  await runScenario(product.id, 'parallel-processor');

  await runEdgeCases(product.id);

  assert.equal(
    await freeKeyCount(product.id),
    5,
    'После всех сценариев должно остаться пять свободных ключей',
  );

  // Убираем тестовый товар из витрины, сохраняя результаты в БД.
  await prisma.product.update({
    where: {
      id: product.id,
    },
    data: {
      isActive: false,
    },
  });

  console.log('\nВсе проверки пройдены.');
}

async function runEdgeCases(productId: string) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });

  // Создание обычного заказа через API.
  const createOrder = () =>
    post<OrderResponse>(
      '/orders',
      {
        productId,
        idempotencyKey: randomUUID(),
      },
      201,
    );

  // Каждый вызов создаёт новое событие.
  const makePayment = (
    orderId: string,
    status: 'paid' | 'failed' = 'paid',
    amount = product.price / 100,
    currency = product.currency,
  ) => ({
    event_id: `evt_${randomUUID()}`,
    order_id: orderId,
    status,
    amount,
    currency,
    created_at: new Date().toISOString(),
  });

  // Отправить событие и дождаться его фоновой обработки.
  const sendAndWait = async (payload: ReturnType<typeof makePayment>) => {
    const response = await post<WebhookResponse>(
      '/webhook/payment',
      payload,
      200,
    );

    assert.equal(response.accepted, true);

    await waitForProcessing([payload.event_id]);

    return prisma.paymentEvent.findUniqueOrThrow({
      where: {
        eventId: payload.event_id,
      },
    });
  };

  // ---------------------------------------------------------
  // 1. Webhook пришёл раньше создания заказа.
  // ---------------------------------------------------------

  console.log('\nЗапуск: webhook-before-order');

  const futureOrderId = randomUUID();
  const earlyPayment = makePayment(futureOrderId);
  const freeBeforeEarly = await freeKeyCount(productId);

  await post<WebhookResponse>('/webhook/payment', earlyPayment, 200);

  // Пробуем обработать событие, когда заказа ещё нет.
  await processor.processOne(earlyPayment.event_id);

  const pendingEvent = await prisma.paymentEvent.findUniqueOrThrow({
    where: {
      eventId: earlyPayment.event_id,
    },
  });

  assert.equal(
    pendingEvent.processedAt,
    null,
    'Событие без заказа должно остаться ожидающим',
  );

  assert.equal(await freeKeyCount(productId), freeBeforeEarly);

  // Повтор раннего webhook не должен создать второе событие.
  const earlyDuplicate = await post<WebhookResponse>(
    '/webhook/payment',
    earlyPayment,
    200,
  );

  assert.equal(earlyDuplicate.duplicate, true);

  // В тесте задаём ID вручную, чтобы воспроизвести появление
  // именно того заказа, который указан в раннем webhook.
  await prisma.order.create({
    data: {
      id: futureOrderId,
      idempotencyKey: randomUUID(),
      productId,
      productName: product.name,
      amount: product.price,
      currency: product.currency,
    },
  });

  // Здесь ждём настоящий фоновый обработчик работающего API.
  await waitForProcessing([earlyPayment.event_id]);

  await verifyDelivery(productId, futureOrderId, freeBeforeEarly);

  console.log('OK: раннее событие дождалось заказа; выдан один ключ');

  // ---------------------------------------------------------
  // 2. Неверная сумма и неверная валюта.
  // ---------------------------------------------------------

  console.log('\nЗапуск: wrong-amount-and-currency');

  const mismatchOrder = await createOrder();
  const freeBeforeMismatch = await freeKeyCount(productId);

  const wrongAmount = await sendAndWait(
    makePayment(mismatchOrder.id, 'paid', product.price / 100 + 1),
  );

  assert.equal(wrongAmount.processingResult, 'amount_or_currency_mismatch');

  const wrongCurrency = await sendAndWait(
    makePayment(mismatchOrder.id, 'paid', product.price / 100, 'USD'),
  );

  assert.equal(wrongCurrency.processingResult, 'amount_or_currency_mismatch');

  const unpaidOrder = await prisma.order.findUniqueOrThrow({
    where: {
      id: mismatchOrder.id,
    },
  });

  assert.equal(unpaidOrder.status, 'created');

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: mismatchOrder.id,
      },
    }),
    0,
  );

  assert.equal(
    await freeKeyCount(productId),
    freeBeforeMismatch,
    'Ошибочные платежи не должны расходовать ключи',
  );

  // Корректное НОВОЕ событие должно успешно оплатить заказ.
  await sendAndWait(makePayment(mismatchOrder.id));

  const validDelivery = await verifyDelivery(
    productId,
    mismatchOrder.id,
    freeBeforeMismatch,
  );

  console.log('OK: неверные платежи отклонены; корректный принят');

  // ---------------------------------------------------------
  // 3. Поздний failed после успешной выдачи.
  // ---------------------------------------------------------

  console.log('\nЗапуск: failed-after-delivered');

  const lateFailure = await sendAndWait(
    makePayment(mismatchOrder.id, 'failed'),
  );

  assert.equal(lateFailure.processingResult, 'ignored_final_order');

  const unchangedDelivery = await verifyDelivery(
    productId,
    mismatchOrder.id,
    freeBeforeMismatch,
  );

  assert.equal(unchangedDelivery.id, validDelivery.id);
  assert.equal(unchangedDelivery.productKeyId, validDelivery.productKeyId);

  console.log('OK: поздний failed не изменил выданный заказ');

  // ---------------------------------------------------------
  // 4. Неуспешная оплата и последующий paid.
  // ---------------------------------------------------------

  console.log('\nЗапуск: failed-payment');

  const failedOrder = await createOrder();
  const freeBeforeFailure = await freeKeyCount(productId);

  const failureEvent = await sendAndWait(makePayment(failedOrder.id, 'failed'));

  assert.equal(failureEvent.processingResult, 'payment_failed');

  const failedState = await prisma.order.findUniqueOrThrow({
    where: {
      id: failedOrder.id,
    },
  });

  assert.equal(failedState.status, 'payment_failed');

  // По принятому правилу payment_failed — финальный статус.
  const lateSuccess = await sendAndWait(makePayment(failedOrder.id, 'paid'));

  assert.equal(lateSuccess.processingResult, 'ignored_final_order');

  const finalFailedState = await prisma.order.findUniqueOrThrow({
    where: {
      id: failedOrder.id,
    },
  });

  assert.equal(finalFailedState.status, 'payment_failed');

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: failedOrder.id,
      },
    }),
    0,
  );

  assert.equal(await freeKeyCount(productId), freeBeforeFailure);

  console.log('OK: неуспешная оплата не выдала ключ');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
