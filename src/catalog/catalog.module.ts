import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { CatalogEventsController } from './catalog-events/catalog-events.controller.js';
import { CatalogEventsService } from './catalog-events/catalog-events.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [CatalogEventsController],
  providers: [CatalogEventsService],
  exports: [CatalogEventsService],
})
export class CatalogModule {}
