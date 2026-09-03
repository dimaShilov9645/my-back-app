import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { PaymentWebhookDto } from './dto/payment-webhook.dto.js';
import { PaymentsService } from './payments.service.js';

@Controller('webhook')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  receive(@Body() dto: PaymentWebhookDto) {
    return this.paymentsService.receive(dto);
  }
}
