import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { ExchangeClient } from '../exchange/exchange.client';
import { ExchangeError } from '../exchange/exchange.error';
import { OrdersRepository } from '../orders/orders.repository';
import { Enrichment } from '../orders/order';
import { RetryPolicy } from './retry.policy';

export const WORKER_ENABLED = Symbol('WORKER_ENABLED');

@Injectable()
export class QueueWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<boolean>;
  private stopping = false;
  private readonly logger = new Logger(QueueWorker.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly exchange: ExchangeClient,
    private readonly retry: RetryPolicy,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WORKER_ENABLED) private readonly enabled: boolean,
  ) {}

  onModuleInit(): void {
    if (this.enabled) this.schedule();
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.processNext()
        .catch(() => {
          this.logger.error({ event: 'queue_poll_failed' });
        })
        .finally(() => this.schedule());
    }, this.config.poll);
  }

  /** Also usable without timers by a deterministic worker test or a job runner. */
  processNext(): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    if (this.running) return this.running;
    this.running = this.process().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async process(): Promise<boolean> {
    const job = this.orders.claim();
    if (!job) return false;
    let enrichment: Enrichment;
    try {
      enrichment = await this.exchange.enrich(job.input, job.targetCurrency);
    } catch (error) {
      const failure =
        error instanceof ExchangeError
          ? error
          : new ExchangeError('ENRICHMENT_INTERNAL_ERROR', true);
      const accepted = this.orders.fail(
        job,
        failure.code,
        failure.retryable,
        this.retry.delay(job.attempts, failure.retryAfterMs),
      );
      this.logger.warn({
        event: accepted ? 'order_attempt_failed' : 'stale_lease_ignored',
        order_id: job.id,
        attempt: job.attempts,
        code: failure.code,
      });
      return true;
    }
    const accepted = this.orders.complete(job, enrichment);
    this.logger.log({
      event: accepted ? 'order_completed' : 'stale_lease_ignored',
      order_id: job.id,
      attempt: job.attempts,
    });
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    try {
      await this.running;
    } catch {
      // Failed persistence leaves an ACTIVE lease for recovery after restart.
      this.logger.error({ event: 'queue_drain_failed' });
    }
  }
}
