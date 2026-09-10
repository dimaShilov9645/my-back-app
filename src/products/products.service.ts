import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        price: true,
        currency: true,
        image: true,
        isActive: true,
        version: true,
        createdAt: true,
        updatedAt: true,

        _count: {
          select: {
            productKeys: {
              where: {
                reservation: {
                  is: null,
                },
                delivery: {
                  is: null,
                },
              },
            },
          },
        },
      },
    });

    return products.map(({ _count, ...product }) => ({
      ...product,
      availableCount: _count.productKeys,
    }));
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        isActive: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Товар не найден');
    }

    return product;
  }
}
