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
          where: {
            eventId,
          },
        });

        if (!initialEvent || initialEvent.processedAt) {
          return;
        }

        const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM orders
          WHERE id = ${initialEvent.orderId}::uuid
          FOR UPDATE
        `;

        if (lockedOrders.length === 0) {
          return;
        }

        const event = await tx.paymentEvent.findUniqueOrThrow({
          where: {
            eventId,
          },
        });

        if (event.processedAt) {
          return;
        }

        const order = await tx.order.findUniqueOrThrow({
          where: {
            id: event.orderId,
          },
        });

        const finish = (processingResult: string) =>
          tx.paymentEvent.update({
            where: {
              eventId,
            },
            data: {
              processedAt: new Date(),
              processingResult,
            },
          });

        const receivedAmountInKopecks = event.amount;

        if (
          event.currency !== order.currency ||
          receivedAmountInKopecks !== order.amount
        ) {
          await finish('amount_or_currency_mismatch');
          return;
        }

        if (order.status === 'delivered') {
          await finish('ignored_already_delivered');
          return;
        }

        if (order.status === 'expired') {
          await finish('ignored_expired_order');
          return;
        }

        if (event.status === 'failed') {
          if (order.status === 'created' || order.status === 'payment_failed') {
            await tx.order.update({
              where: {
                id: order.id,
              },
              data: {
                status: 'payment_failed',
              },
            });

            await finish('payment_failed');
          } else {
            await finish('ignored_payment_already_confirmed');
          }

          return;
        }

        const canProcessPaid =
          order.status === 'created' ||
          order.status === 'payment_failed' ||
          order.status === 'paid';

        if (!canProcessPaid) {
          await finish(`ignored_order_status:${order.status}`);
          return;
        }

        const reservation = await tx.reservation.findUnique({
          where: {
            orderId: order.id,
          },
        });

        if (!reservation) {
          await tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              status: 'delivery_failed',
            },
          });

          await finish('reservation_missing');
          return;
        }

        const paymentArrivedTooLate =
          event.receivedAt.getTime() >= reservation.expiresAt.getTime();

        if (paymentArrivedTooLate) {
          await tx.reservation.delete({
            where: {
              id: reservation.id,
            },
          });

          await tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              status: 'expired',
            },
          });

          await tx.product.update({
            where: {
              id: order.productId,
            },
            data: {
              version: {
                increment: 1,
              },
            },
          });

          await finish('reservation_expired');
          return;
        }

        if (order.status !== 'paid') {
          await tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              status: 'paid',
            },
          });
        }

        const delivery = await this.deliveriesService.deliverInTransaction(
          tx,
          order.id,
        );

        await finish(delivery ? 'delivered' : 'delivery_failed');
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
  }
}
