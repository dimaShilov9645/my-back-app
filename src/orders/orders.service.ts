import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}

  create(dto: CreateOrderDto) {
    return this.reservationsService.reserveProduct({
      productId: dto.productId.toLowerCase(),
      idempotencyKey: dto.idempotencyKey.toLowerCase(),
      expectedPrice: dto.expectedPrice,
    });
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
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
      },
    });

    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    return {
      ...order,
      serverTime: new Date().toISOString(),
    };
  }
}
