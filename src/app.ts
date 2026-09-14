import 'reflect-metadata';
import { LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, RuntimeOptions } from './app.module';
import { AppConfig, loadConfig } from './config';

export interface AppOptions extends RuntimeOptions {
  config?: AppConfig;
  logger?: LoggerService | LogLevel[] | false;
}

export async function createApp(options: AppOptions = {}) {
  const app = await NestFactory.create(
    AppModule.register(options.config ?? loadConfig(), options),
    {
      logger: options.logger,
      abortOnError: false,
    },
  );
  app.enableShutdownHooks();
  return app;
}
