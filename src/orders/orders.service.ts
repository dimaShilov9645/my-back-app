import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import type { Order } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrderDto): Promise<Order> {
    const productId = dto.productId.toLowerCase();
    const idempotencyKey = dto.idempotencyKey.toLowerCase();

    const existingOrder = await this.prisma.order.findUnique({
      where: { idempotencyKey },
    });

    if (existingOrder) {
      return this.checkSameProduct(existingOrder, productId);
    }

    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        isActive: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Товар не найден или недоступен');
    }

    try {
      return await this.prisma.order.create({
        data: {
          idempotencyKey,
          productId: product.id,
          productName: product.name,
          amount: product.price,
          currency: product.currency,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrentOrder = await this.prisma.order.findUnique({
          where: { idempotencyKey },
        });

        if (concurrentOrder) {
          return this.checkSameProduct(concurrentOrder, productId);
        }
      }

      throw error;
    }
  }

  private checkSameProduct(order: Order, productId: string): Order {
    if (order.productId !== productId) {
      throw new ConflictException(
        'Этот idempotencyKey уже использован для другого товара',
      );
    }

    return order;
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        productId: true,
        productName: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        updatedAt: true,

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
      },
    });

    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }

    return order;
  }
}
