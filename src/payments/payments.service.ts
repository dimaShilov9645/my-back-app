import { ConflictException, Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PaymentWebhookDto } from './dto/payment-webhook.dto.js';

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async receive(dto: PaymentWebhookDto) {
    const orderId = dto.order_id.toLowerCase();
    const amount = new Prisma.Decimal(dto.amount);
    const occurredAt = new Date(dto.created_at);

    try {
      await this.prisma.paymentEvent.create({
        data: {
          eventId: dto.event_id,
          orderId,
          status: dto.status,
          amount,
          currency: dto.currency,
          occurredAt,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentEvent.findUnique({
          where: {
            eventId: dto.event_id,
          },
        });

        if (!existing) {
          throw error;
        }

        const sameEvent =
          existing.orderId === orderId &&
          existing.status === dto.status &&
          existing.amount.equals(amount) &&
          existing.currency === dto.currency &&
          existing.occurredAt.getTime() === occurredAt.getTime();

        if (!sameEvent) {
          throw new ConflictException(
            'event_id уже существует с другими данными',
          );
        }

        return {
          accepted: true,
          duplicate: true,
        };
      }

      throw error;
    }

    return {
      accepted: true,
      duplicate: false,
    };
  }
}
