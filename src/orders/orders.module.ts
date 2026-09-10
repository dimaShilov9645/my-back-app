import { Module } from '@nestjs/common';

import { ReservationsModule } from '../reservations/reservations.module.js';
import { OrdersService } from './orders.service.js';
import { OrdersController } from './orders.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule, ReservationsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
