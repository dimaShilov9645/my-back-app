import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogEventsService } from '../../catalog/catalog-events/catalog-events.service.js';

@Injectable()
export class ReservationExpirationService {
  private readonly logger = new Logger(ReservationExpirationService.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogEventsService: CatalogEventsService,
  ) {}

  @Interval('release-expired-reservations', 1_000)
  async releaseExpiredReservations() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const reservations = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r."id"
        FROM reservations AS r
        JOIN orders AS o ON o.id = r."orderId"
        WHERE r."expiresAt" <= NOW()
          AND o.status IN ('created', 'payment_failed')
        ORDER BY r."expiresAt", r."id"
        LIMIT 100
      `;

      for (const reservation of reservations) {
        try {
          await this.expireOne(reservation.id);
        } catch (error: unknown) {
          this.logger.error(
            `Не удалось снять бронь ${reservation.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        'Не удалось получить просроченные брони',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  async expireOne(reservationId: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        /*
         * Сначала узнаём orderId.
         * Бронь могла быть удалена обработчиком оплаты.
         */
        const initialReservation = await tx.reservation.findUnique({
          where: {
            id: reservationId,
          },
          select: {
            orderId: true,
          },
        });

        if (!initialReservation) {
          return null;
        }

        const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM orders
          WHERE id = ${initialReservation.orderId}::uuid
          FOR UPDATE
        `;

        if (lockedOrders.length === 0) {
          return null;
        }

        const reservation = await tx.reservation.findUnique({
          where: {
            id: reservationId,
          },
        });

        if (!reservation) {
          return null;
        }

        const order = await tx.order.findUniqueOrThrow({
          where: {
            id: reservation.orderId,
          },
        });

        const canExpire =
          order.status === 'created' || order.status === 'payment_failed';

        if (!canExpire) {
          return null;
        }

        if (reservation.expiresAt.getTime() > Date.now()) {
          return null;
        }

        const pendingPaidEvent = await tx.paymentEvent.findFirst({
          where: {
            orderId: order.id,
            status: 'paid',
            processedAt: null,

            receivedAt: {
              lt: reservation.expiresAt,
            },
          },
          select: {
            eventId: true,
          },
        });

        if (pendingPaidEvent) {
          return {
            status: 'waiting_for_payment' as const,
            orderId: order.id,
            eventId: pendingPaidEvent.eventId,
          };
        }

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

        const updatedProduct = await tx.product.update({
          where: {
            id: order.productId,
          },
          data: {
            version: {
              increment: 1,
            },
          },
          select: {
            id: true,
            version: true,
          },
        });

        return {
          status: 'expired' as const,
          orderId: order.id,
          productId: updatedProduct.id,
          productVersion: updatedProduct.version,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );

    if (result?.status === 'expired') {
      this.logger.log(`Бронь заказа ${result.orderId} истекла`);

      await this.notifyProductChanged(result.productId);
    }

    return result;
  }

  private async notifyProductChanged(productId: string): Promise<void> {
    try {
      await this.catalogEventsService.publishProductChanged(productId);
    } catch (error: unknown) {
      this.logger.error(
        `Не удалось отправить обновление товара ${productId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
