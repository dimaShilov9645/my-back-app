import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class CreateOrderDto {
  @IsUUID()
  productId!: string;
  @IsUUID()
  idempotencyKey!: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedPrice?: number;
}
