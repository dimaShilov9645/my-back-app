import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateProductDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  price?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
