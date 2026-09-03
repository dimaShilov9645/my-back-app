import { Module } from '@nestjs/common';

import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentProcessorService } from './payment-processor.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [PrismaModule, DeliveriesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentProcessorService],
})
export class PaymentsModule {}
