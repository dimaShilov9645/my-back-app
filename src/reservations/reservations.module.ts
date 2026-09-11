import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationExpirationService } from './reservation-expiration/reservation-expiration.service.js';

@Module({
  imports: [PrismaModule, CatalogModule],
  providers: [ReservationsService, ReservationExpirationService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
