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

  // Самостоятельная выдача — например, для повторной попытки.
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

  // Выдача как часть уже открытой транзакции.
  async deliverInTransaction(tx: Prisma.TransactionClient, orderId: string) {
    await tx.$queryRaw`
      SELECT id
      FROM orders
      WHERE id = ${orderId}::uuid
      FOR UPDATE
    `;

    const order = await tx.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    const existingDelivery = await tx.delivery.findUnique({
      where: { orderId },
    });

    if (existingDelivery) {
      return existingDelivery;
    }

    if (order.status !== 'paid' && order.status !== 'out_of_stock') {
      throw new ConflictException('Заказ не находится в состоянии для выдачи');
    }

    await tx.$queryRaw`
      SELECT id
      FROM products
      WHERE id = ${order.productId}::uuid
      FOR UPDATE
    `;

    const key = await tx.productKey.findFirst({
      where: {
        productId: order.productId,
        delivery: {
          is: null,
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (!key) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'out_of_stock',
        },
      });

      return null;
    }

    const delivery = await tx.delivery.create({
      data: {
        orderId,
        productKeyId: key.id,
      },
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'delivered',
      },
    });

    return delivery;
  }
}
