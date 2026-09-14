import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { RANDOM, Random } from '../common/runtime';

@Injectable()
export class RetryPolicy {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RANDOM) private readonly random: Random,
  ) {}

  delay(attempt: number, retryAfterMs = 0): number {
    // Jitter spreads retries across workers; cap both exponential growth and server hints.
    const exponential = this.config.backoff * 2 ** (attempt - 1);
    const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
    return Math.min(60000, Math.max(jittered, retryAfterMs));
  }
}
