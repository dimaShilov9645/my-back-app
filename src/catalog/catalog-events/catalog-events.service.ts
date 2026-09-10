import { Injectable } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { concat, interval, map, merge, of, Subject } from 'rxjs';
import type { Observable } from 'rxjs';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class CatalogEventsService {
  private readonly productEvents$ = new Subject<MessageEvent>();

  constructor(private readonly prisma: PrismaService) {}

  stream(): Observable<MessageEvent> {
    const connected$: Observable<MessageEvent> = of({
      type: 'connected',
      data: {
        serverTime: new Date().toISOString(),
      },
    });

    // Не даёт прокси или браузеру закрыть бездействующее соединение.
    const heartbeat$: Observable<MessageEvent> = interval(15_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: {
          serverTime: new Date().toISOString(),
        },
      })),
    );

    return concat(
      connected$,
      merge(this.productEvents$.asObservable(), heartbeat$),
    );
  }

  async publishProductChanged(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: {
        id: productId,
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

    if (!product) {
      this.productEvents$.next({
        type: 'product.removed',
        data: {
          productId,
        },
      });

      return;
    }

    const { _count, ...productData } = product;

    this.productEvents$.next({
      id: `${product.id}:${product.version}`,
      type: 'product.updated',
      data: {
        ...productData,
        updatedAt: product.updatedAt.toISOString(),
        availableCount: _count.productKeys,
      },
    });
  }
}
