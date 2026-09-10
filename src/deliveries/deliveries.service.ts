import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class DeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async deliver(orderId: string) {
    return this.prisma.$transaction(
      (tx) => this.deliverInTransaction(tx, orderId),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
  }

  async deliverInTransaction(tx: Prisma.TransactionClient, orderId: string) {

    await tx.$queryRaw`
        SELECT id
        FROM orders
        WHERE id = ${orderId}::uuid
      FOR UPDATE
    `;

    const order = await tx.order.findUnique({
      where: {
        id: orderId,
      },
    });

    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const existingDelivery = await tx.delivery.findUnique({
      where: {
        orderId,
      },
    });

    if (existingDelivery) {
      await tx.reservation.deleteMany({
        where: {
          orderId,
        },
      });

      if (order.status !== 'delivered') {
        await tx.order.update({
          where: {
            id: orderId,
          },
          data: {
            status: 'delivered',
          },
        });
      }

      return existingDelivery;
    }

    if (order.status !== 'paid') {
      throw new ConflictException({
        code: 'ORDER_NOT_PAID',
        message: 'Заказ ещё не оплачен',
      });
    }

    const reservation = await tx.reservation.findUnique({
      where: {
        orderId,
      },
      select: {
        id: true,
        productKeyId: true,
      },
    });

    if (!reservation) {
      await tx.order.update({
        where: {
          id: orderId,
        },
        data: {
          status: 'delivery_failed',
        },
      });

      return null;
    }

    const delivery = await tx.delivery.create({
      data: {
        orderId,
        productKeyId: reservation.productKeyId,
      },
    });

    await tx.reservation.delete({
      where: {
        id: reservation.id,
      },
    });

    await tx.order.update({
      where: {
        id: orderId,
      },
      data: {
        status: 'delivered',
      },
    });

    return delivery;
  }
}
