import { Controller, Sse } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';

import { CatalogEventsService } from './catalog-events.service.js';

@Controller('catalog')
export class CatalogEventsController {
  constructor(private readonly catalogEventsService: CatalogEventsService) {}

  @Sse('events')
  events(): Observable<MessageEvent> {
    return this.catalogEventsService.stream();
  }
}
