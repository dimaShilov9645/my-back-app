import { IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  idempotencyKey!: string;
}
