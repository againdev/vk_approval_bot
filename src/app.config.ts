import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsString,
  validateSync,
} from 'class-validator';
import { Transform, plainToInstance } from 'class-transformer';

export class AppConfig {
  @IsString()
  readonly NODE_ENV: string;

  @IsString()
  readonly APP_ADDRESS: string;

  @IsNumber()
  readonly APP_PORT: number;

  @IsArray()
  @Transform(({ value }) => value.split(','))
  readonly CORS_ALLOWED_HEADERS: string[];

  @IsBoolean()
  readonly CORS_CREDENTIALS: boolean;

  @IsArray()
  @Transform(({ value }) => value.split(','))
  readonly CORS_METHODS: string[];

  @IsString()
  readonly CORS_ORIGIN: string;

  @IsString()
  readonly DATABASE_URL: string;

  @IsString()
  readonly VK_BOT_TOKEN: string;
}

export function validateAppConfig(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(AppConfig, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validatedConfig;
}
