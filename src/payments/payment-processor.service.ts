import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { DeliveriesService } from '../deliveries/deliveries.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class PaymentProcessorService {
  private readonly logger = new Logger(PaymentProcessorService.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveriesService: DeliveriesService,
  ) {}

  @Interval(2_000)
  async processPending() {
    // Не запускаем новый проход, пока предыдущий ещё работает.
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const events = await this.prisma.$queryRaw<Array<{ eventId: string }>>`
        SELECT e."eventId"
        FROM payment_events AS e
        JOIN orders AS o ON o.id = e."orderId"
        WHERE e."processedAt" IS NULL
        ORDER BY e."receivedAt", e."eventId"
        LIMIT 100
      `;

      for (const event of events) {
        try {
          await this.processOne(event.eventId);
        } catch (error: unknown) {
          this.logger.error(
            `Не удалось обработать событие ${event.eventId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        'Не удалось прочитать очередь событий',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  async processOne(eventId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const initialEvent = await tx.paymentEvent.findUnique({
          where: { eventId },
        });

        if (!initialEvent || initialEvent.processedAt) {
          return;
        }

        // Все изменения одного заказа выполняем по очереди.
        const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM orders
          WHERE id = ${initialEvent.orderId}::uuid
          FOR UPDATE
        `;

        if (lockedOrders.length === 0) {
          // Заказ ещё не появился — событие остаётся ожидающим.
          return;
        }

        // Пока мы ждали блокировку, событие могли обработать.
        const event = await tx.paymentEvent.findUniqueOrThrow({
          where: { eventId },
        });

        if (event.processedAt) {
          return;
        }

        const order = await tx.order.findUniqueOrThrow({
          where: { id: event.orderId },
        });

        const finish = (processingResult: string) =>
          tx.paymentEvent.update({
            where: { eventId },
            data: {
              processedAt: new Date(),
              processingResult,
            },
          });

        // В webhook — рубли, в заказе — копейки.
        const receivedAmountInKopecks = event.amount.mul(100);

        if (
          event.currency !== order.currency ||
          !receivedAmountInKopecks.equals(order.amount)
        ) {
          await finish('amount_or_currency_mismatch');
          return;
        }

        // По ТЗ финальные заказы не меняем.
        if (order.status === 'delivered' || order.status === 'payment_failed') {
          await finish('ignored_final_order');
          return;
        }

        if (event.status === 'failed') {
          if (order.status === 'created') {
            await tx.order.update({
              where: { id: order.id },
              data: {
                status: 'payment_failed',
              },
            });

            await finish('payment_failed');
          } else {
            // Подтверждённую оплату поздним failed не отменяем.
            await finish('ignored_payment_already_confirmed');
          }

          return;
        }

        if (order.status === 'created') {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'paid',
            },
          });
        }

        const delivery = await this.deliveriesService.deliverInTransaction(
          tx,
          order.id,
        );

        await finish(delivery ? 'delivered' : 'out_of_stock');
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
  }
}
