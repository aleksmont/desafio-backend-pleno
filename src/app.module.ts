import { Controller, DynamicModule, Get, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from './config';
import { CLOCK, Clock, HTTP_FETCH, HttpFetch, RANDOM, Random, systemClock } from './common/runtime';
import { Database } from './database/database';
import { ExchangeClient } from './exchange/exchange.client';
import { OrdersController } from './orders/orders.controller';
import { OrdersRepository } from './orders/orders.repository';
import { OrdersService } from './orders/orders.service';
import { QueueWorker, WORKER_ENABLED } from './queue/queue.worker';
import { RetryPolicy } from './queue/retry.policy';

@Controller()
class HealthController {
  constructor(private readonly database: Database) {}

  @Get()
  index() {
    return {
      name: 'Orquestrador de Pedidos',
      endpoints: [
        'GET /health',
        'POST /webhooks/orders',
        'GET /orders',
        'GET /orders/:id',
        'GET /queue/metrics',
      ],
    };
  }

  @Get('health')
  health() {
    this.database.ping();
    return { status: 'ok' };
  }
}

export interface RuntimeOptions {
  clock?: Clock;
  random?: Random;
  httpFetch?: HttpFetch;
  workerEnabled?: boolean;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, options: RuntimeOptions = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, OrdersController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useValue: options.clock ?? systemClock },
        { provide: RANDOM, useValue: options.random ?? Math.random },
        { provide: HTTP_FETCH, useValue: options.httpFetch ?? fetch },
        { provide: WORKER_ENABLED, useValue: options.workerEnabled ?? true },
        Database,
        OrdersRepository,
        OrdersService,
        ExchangeClient,
        RetryPolicy,
        QueueWorker,
      ],
    };
  }
}
