import {
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';

import { CatalogEventsService } from '../catalog/catalog-events/catalog-events.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type ReserveProductInput = {
  productId: string;
  idempotencyKey: string;
  expectedPrice?: number;
};

type LockedProductKey = {
  id: string;
};

const orderSelect = {
  id: true,
  idempotencyKey: true,
  productId: true,
  productName: true,
  amount: true,
  currency: true,
  status: true,
  createdAt: true,
  updatedAt: true,

  reservation: {
    select: {
      expiresAt: true,
    },
  },

  delivery: {
    select: {
      createdAt: true,
      productKey: {
        select: {
          code: true,
        },
      },
    },
  },
} as const;

type OrderWithReservation = Prisma.OrderGetPayload<{
  select: typeof orderSelect;
}>;

type ReserveProductResult = OrderWithReservation & {
  serverTime: string;
  idempotentReplay: boolean;
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogEventsService: CatalogEventsService,
  ) {}

  async reserveProduct(
    input: ReserveProductInput,
  ): Promise<ReserveProductResult> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const existingOrder = await tx.order.findUnique({
            where: {
              idempotencyKey: input.idempotencyKey,
            },
            select: orderSelect,
          });

          if (existingOrder) {
            this.ensureSameProduct(existingOrder.productId, input.productId);

            return {
              order: existingOrder,
              idempotentReplay: true,
            };
          }

          const product = await tx.product.findUnique({
            where: {
              id: input.productId,
            },
          });

          if (!product) {
            throw new NotFoundException({
              code: 'PRODUCT_NOT_FOUND',
              message: 'Товар не найден',
            });
          }

          if (!product.isActive) {
            throw new ConflictException({
              code: 'PRODUCT_INACTIVE',
              message: 'Товар временно недоступен',
            });
          }
          if (
            input.expectedPrice !== undefined &&
            input.expectedPrice !== product.price
          ) {
            throw new ConflictException({
              code: 'PRICE_CHANGED',
              message: 'Цена товара изменилась',
              previousPrice: input.expectedPrice,
              currentPrice: product.price,
              productVersion: product.version,
            });
          }

          const createdOrder = await tx.order.create({
            data: {
              idempotencyKey: input.idempotencyKey,
              productId: product.id,
              productName: product.name,
              amount: product.price,
              currency: product.currency,
            },
            select: {
              id: true,
            },
          });

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
            throw new ConflictException({
              code: 'OUT_OF_STOCK',
              message: 'Товар только что раскупили',
            });
          }

          const expiresAt = new Date(
            Date.now() + this.getReservationTtlMilliseconds(),
          );

          await tx.reservation.create({
            data: {
              orderId: createdOrder.id,
              productKeyId: productKey.id,
              expiresAt,
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

          const order = await tx.order.findUniqueOrThrow({
            where: {
              id: createdOrder.id,
            },
            select: orderSelect,
          });

          return {
            order,
            idempotentReplay: false,
          };
        },
        {
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
      if (!result.idempotentReplay) {
        await this.notifyProductChanged(input.productId);
      }
      return this.buildResponse(result.order, result.idempotentReplay);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existingOrder = await this.prisma.order.findUnique({
          where: {
            idempotencyKey: input.idempotencyKey,
          },
          select: orderSelect,
        });

        if (existingOrder) {
          this.ensureSameProduct(existingOrder.productId, input.productId);

          return this.buildResponse(existingOrder, true);
        }
      }

      throw error;
    }
  }

  private buildResponse(
    order: OrderWithReservation,
    idempotentReplay: boolean,
  ): ReserveProductResult {
    return {
      ...order,
      serverTime: new Date().toISOString(),
      idempotentReplay,
    };
  }

  private ensureSameProduct(
    existingProductId: string,
    requestedProductId: string,
  ): void {
    if (existingProductId !== requestedProductId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Этот idempotencyKey уже использован для другого товара',
      });
    }
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

  private getReservationTtlMilliseconds(): number {
    const defaultTtlSeconds = 5 * 60;
    const configuredTtlSeconds = Number(
      process.env.RESERVATION_TTL_SECONDS ?? defaultTtlSeconds,
    );

    if (!Number.isFinite(configuredTtlSeconds) || configuredTtlSeconds <= 0) {
      return defaultTtlSeconds * 1_000;
    }

    return configuredTtlSeconds * 1_000;
  }
}
