import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationService } from './reservation-expiration/reservation-expiration.service.js';

@Module({
  imports: [PrismaModule],
  providers: [ReservationsService, ReservationExpirationService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
