import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppConfig } from './app.config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const configService = app.get(ConfigService);

  const adress = configService.get<AppConfig['APP_ADDRESS']>('APP_ADDRESS')!;
  const port = configService.get<AppConfig['APP_PORT']>('APP_PORT');

  app.setGlobalPrefix('api');

  const allowedHeaders = configService.get<AppConfig['CORS_ALLOWED_HEADERS']>(
    'CORS_ALLOWED_HEADERS',
  );
  const credentials =
    configService.get<AppConfig['CORS_CREDENTIALS']>('CORS_CREDENTIALS');
  const methods = configService.get<AppConfig['CORS_METHODS']>('CORS_METHODS');
  const originString =
    configService.get<AppConfig['CORS_ORIGIN']>('CORS_ORIGIN');

  const origins = originString
    ? originString.split(',').map((o) => o.trim())
    : [];

  app.enableCors({
    origin: origins,
    credentials,
    allowedHeaders,
    methods,
  });

  await app.listen(port, adress);
}
bootstrap();
