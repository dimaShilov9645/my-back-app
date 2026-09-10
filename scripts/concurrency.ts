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

type ApiErrorResponse = {
  statusCode?: number;
  code?: string;
  message?: string | string[];
};

type HttpResult<T> = {
  status: number;
  body: T;
};

async function post<T>(
  path: string,
  body: unknown,
  expectedStatus: number,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error: unknown) {
    const cause =
      error instanceof Error && 'cause' in error ? error.cause : undefined;

    const causeMessage =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause ?? '');

    const causeCode =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String(cause.code)
        : 'unknown';

    throw new Error(
      `${path}: запрос не дошёл до API; ` +
        `code=${causeCode}; cause=${causeMessage}`,
      {
        cause: error,
      },
    );
  }

  const text = await response.text();

  assert.equal(
    response.status,
    expectedStatus,
    `${path}: HTTP ${response.status}\n${text}`,
  );

  return JSON.parse(text) as T;
}

async function postResult<T>(
  path: string,
  body: unknown,
): Promise<HttpResult<T>> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();

  let parsedBody: unknown = null;

  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = {
        message: text,
      };
    }
  }

  return {
    status: response.status,
    body: parsedBody as T,
  };
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
      reservation: {
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
  expectedFreeKeyCount: number,
) {
  const order = await prisma.order.findUniqueOrThrow({
    where: {
      id: orderId,
    },
  });

  assert.equal(order.status, 'delivered');

  const deliveries = await prisma.delivery.findMany({
    where: {
      orderId,
    },
  });

  assert.equal(deliveries.length, 1, 'У заказа должна быть ровно одна выдача');

  assert.equal(
    await freeKeyCount(productId),
    expectedFreeKeyCount,
    'Количество доступных ключей не совпадает',
  );

  return deliveries[0]!;
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

  const freeAfterReservation = await freeKeyCount(productId);

  assert.equal(
    freeAfterReservation,
    freeBefore - 1,
    'Создание заказа должно забронировать ровно один ключ',
  );

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

  const firstDelivery = await verifyDelivery(
    productId,
    order.id,
    freeAfterReservation,
  );

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
    freeAfterReservation,
  );

  assert.equal(repeatedDelivery.id, firstDelivery.id);
  assert.equal(repeatedDelivery.productKeyId, firstDelivery.productKeyId);

  console.log(`OK: ${mode}; заказ ${order.id}; одна выдача, один ключ`);
}


type TestProduct = {
  id: string;
  name: string;
  price: number;
  currency: string;
};

type LockedProductKey = {
  id: string;
};

async function createReservedOrderWithId(params: {
  orderId: string;
  idempotencyKey: string;
  product: TestProduct;
}) {
  const { orderId, idempotencyKey, product } = params;

  return prisma.$transaction(async (tx) => {
    const productKeys = await tx.$queryRaw<LockedProductKey[]>`
      SELECT pk."id"
      FROM "product_keys" AS pk
      WHERE pk."productId" = ${product.id}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM "reservations" AS r
          WHERE r."productKeyId" = pk."id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "deliveries" AS d
          WHERE d."productKeyId" = pk."id"
        )
      ORDER BY pk."createdAt" ASC
      FOR UPDATE OF pk SKIP LOCKED
      LIMIT 1
    `;

    const productKey = productKeys[0];

    if (!productKey) {
      throw new Error(
        `Нет свободного ключа для тестового товара ${product.id}`,
      );
    }

    const order = await tx.order.create({
      data: {
        id: orderId,
        idempotencyKey,
        productId: product.id,
        productName: product.name,
        amount: product.price,
        currency: product.currency,
      },
    });

    await tx.reservation.create({
      data: {
        orderId: order.id,
        productKeyId: productKey.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      },
    });

    await tx.product.update({
      where: {
        id: product.id,
      },
      data: {
        version: {
          increment: 1,
        },
      },
    });

    return order;
  });
}

async function runLastUnitRace() {
  console.log('\nЗапуск: last-unit-race');

  const runId = randomUUID();

  /*
   * Для этой проверки создаём отдельный товар
   * ровно с одним ключом.
   */
  const product = await prisma.product.create({
    data: {
      sku: `TEST-LAST-UNIT-${runId}`,
      name: 'Тест покупки последней единицы',
      type: 'key',
      price: 159000,
      currency: 'RUB',
      isActive: true,

      productKeys: {
        create: {
          code: `TEST-LAST-KEY-${runId}`,
        },
      },
    },
  });

  assert.equal(
    await freeKeyCount(product.id),
    1,
    'Перед гонкой должен существовать ровно один свободный ключ',
  );

  /*
   * Это разные покупатели, поэтому idempotencyKey
   * у каждого запроса свой.
   */
  const results = await parallel(
    Array.from({ length: CONCURRENCY }, () =>
      postResult<OrderResponse | ApiErrorResponse>('/orders', {
        productId: product.id,
        idempotencyKey: randomUUID(),
        expectedPrice: product.price,
      }),
    ),
  );

  const successfulRequests = results.filter((result) => result.status === 201);

  const rejectedRequests = results.filter((result) => result.status === 409);

  const unexpectedRequests = results.filter(
    (result) => result.status !== 201 && result.status !== 409,
  );

  assert.equal(
    unexpectedRequests.length,
    0,
    `Получены неожиданные HTTP-ответы:\n${JSON.stringify(
      unexpectedRequests,
      null,
      2,
    )}`,
  );

  assert.equal(
    successfulRequests.length,
    1,
    `Последнюю единицу должен забронировать ровно один покупатель. Успешных запросов: ${successfulRequests.length}`,
  );

  assert.equal(
    rejectedRequests.length,
    CONCURRENCY - 1,
    `Ожидалось ${CONCURRENCY - 1} отказов OUT_OF_STOCK`,
  );

  assert.ok(
    rejectedRequests.every((result) => {
      const body = result.body as ApiErrorResponse;

      return body.code === 'OUT_OF_STOCK';
    }),
    `Все проигравшие должны получить OUT_OF_STOCK:\n${JSON.stringify(
      rejectedRequests,
      null,
      2,
    )}`,
  );

  const winner = successfulRequests[0]!.body as OrderResponse;

  /*
   * Транзакции проигравших должны полностью откатиться.
   * Поэтому сохраняется только заказ победителя.
   */
  assert.equal(
    await prisma.order.count({
      where: {
        productId: product.id,
      },
    }),
    1,
    'В БД должен остаться только заказ победителя',
  );

  assert.equal(
    await prisma.reservation.count({
      where: {
        orderId: winner.id,
      },
    }),
    1,
    'У победителя должна быть ровно одна бронь',
  );

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: winner.id,
      },
    }),
    0,
    'До оплаты выдачи быть не должно',
  );

  assert.equal(
    await freeKeyCount(product.id),
    0,
    'Последний ключ должен стать недоступным сразу после бронирования',
  );

  /*
   * Оплачивает только победитель.
   */
  const paymentEventId = `evt-last-unit-${randomUUID()}`;

  await post<WebhookResponse>(
    '/webhook/payment',
    {
      event_id: paymentEventId,
      order_id: winner.id,
      status: 'paid',
      amount: winner.amount / 100,
      currency: winner.currency,
      created_at: new Date().toISOString(),
    },
    200,
  );

  await waitForProcessing([paymentEventId]);

  await verifyDelivery(product.id, winner.id, 0);

  assert.equal(
    await prisma.reservation.count({
      where: {
        orderId: winner.id,
      },
    }),
    0,
    'После выдачи бронь должна быть удалена',
  );

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: winner.id,
      },
    }),
    1,
    'Победитель должен получить ровно одну выдачу',
  );

  assert.equal(
    await prisma.delivery.count({
      where: {
        productKey: {
          productId: product.id,
        },
      },
    }),
    1,
    'Последний ключ должен быть выдан ровно один раз',
  );

  await prisma.product.update({
    where: {
      id: product.id,
    },
    data: {
      isActive: false,
    },
  });

  console.log(
    `OK: last-unit-race; победитель ${winner.id}; ` +
      `1 успешный запрос, ${CONCURRENCY - 1} отказов`,
  );
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
    4,
    'После всех сценариев должно остаться четыре свободных ключа',
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

  await runLastUnitRace();

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

  await createReservedOrderWithId({
    orderId: futureOrderId,
    idempotencyKey: randomUUID(),
    product,
  });

  // Здесь ждём настоящий фоновый обработчик работающего API.
  await waitForProcessing([earlyPayment.event_id]);

  await verifyDelivery(productId, futureOrderId, freeBeforeEarly - 1);

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

  assert.equal(lateFailure.processingResult, 'ignored_already_delivered');

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

  /*
   * Пока бронь активна, после failed можно повторить оплату.
   */
  const lateSuccess = await sendAndWait(makePayment(failedOrder.id, 'paid'));

  assert.equal(lateSuccess.processingResult, 'delivered');

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: {
      id: failedOrder.id,
    },
  });

  assert.equal(finalOrder.status, 'delivered');

  assert.equal(
    await prisma.delivery.count({
      where: {
        orderId: failedOrder.id,
      },
    }),
    1,
  );

  /*
   * Ключ перестал быть доступным уже в момент бронирования,
   * поэтому успешная выдача больше не уменьшает доступный остаток.
   */
  assert.equal(await freeKeyCount(productId), freeBeforeFailure);

  console.log('OK: после failed повторная оплата выдала забронированный ключ');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
