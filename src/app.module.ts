import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { DeliveriesModule } from './deliveries/deliveries.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { ScheduleModule } from '@nestjs/schedule';
import { ReservationsModule } from './reservations/reservations.module.js';
import { CatalogModule } from './catalog/catalog.module.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    ProductsModule,
    OrdersModule,
    DeliveriesModule,
    PaymentsModule,
    ReservationsModule,
    CatalogModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
