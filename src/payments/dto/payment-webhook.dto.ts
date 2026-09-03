import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PaymentWebhookDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  event_id!: string;
  @IsUUID()
  order_id!: string;
  @IsIn(['paid', 'failed'])
  status!: 'paid' | 'failed';
  @IsNumber({
    maxDecimalPlaces: 2,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount!: number;
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  created_at!: string;
}
