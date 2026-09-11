import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';


import { CatalogEventsService } from '../catalog/catalog-events/catalog-events.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogEventsService: CatalogEventsService,
  ) {}

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

  async update(id: string, dto: UpdateProductDto) {
    if (dto.price === undefined && dto.isActive === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'Не переданы данные для изменения товара',
      });
    }

    const existingProduct = await this.prisma.product.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
      },
    });

    if (!existingProduct) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Товар не найден',
      });
    }

    const product = await this.prisma.product.update({
      where: {
        id,
      },
      data: {
        ...(dto.price !== undefined
          ? {
              price: dto.price,
            }
          : {}),

        ...(dto.isActive !== undefined
          ? {
              isActive: dto.isActive,
            }
          : {}),

        version: {
          increment: 1,
        },
      },
    });

    await this.notifyProductChanged(product.id);

    return product;
  }

  private async notifyProductChanged(productId: string): Promise<void> {
    try {
      await this.catalogEventsService.publishProductChanged(productId);
    } catch (error: unknown) {
      // Изменение уже записано в БД, поэтому SSE не должен приводить к 500.
      this.logger.error(
        `Не удалось отправить обновление товара ${productId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
