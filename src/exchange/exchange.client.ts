import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { CLOCK, Clock, HTTP_FETCH, HttpFetch } from '../common/runtime';
import { convertTotal, Enrichment } from '../orders/order';
import { OrderInput } from '../orders/order.schema';
import { ExchangeError } from './exchange.error';

const rateResponse = z.object({
  base: z.string(),
  date: z.iso.date(),
  rates: z.record(z.string(), z.number().positive()),
});
const MAX_RESPONSE_BYTES = 65536;

@Injectable()
export class ExchangeClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly httpFetch: HttpFetch,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async enrich(input: OrderInput, target: string): Promise<Enrichment> {
    const sameCurrency = input.currency === target;
    // Frankfurter omits the base from its rates. Validate it against another currency
    // even for identity conversions, so every order depends on external enrichment.
    const quotedCurrency = sameCurrency ? (input.currency === 'USD' ? 'EUR' : 'USD') : target;
    const url = new URL(this.config.api);
    url.searchParams.set('base', input.currency);
    url.searchParams.set('symbols', quotedCurrency);
    const signal = AbortSignal.timeout(this.config.timeout);
    try {
      const response = await this.httpFetch(url, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ExchangeError(
          `EXCHANGE_HTTP_${response.status}`,
          this.retryAfter(response.headers.get('retry-after')),
        );
      }
      const parsed = rateResponse.safeParse(await this.readJson(response));
      if (
        !parsed.success ||
        parsed.data.base !== input.currency ||
        !parsed.data.rates[quotedCurrency]
      ) {
        throw new ExchangeError('EXCHANGE_INVALID_RESPONSE');
      }
      const rate = sameCurrency ? 1 : parsed.data.rates[quotedCurrency];
      return {
        source: 'frankfurter',
        currency: target,
        rate,
        rate_date: parsed.data.date,
        converted_total: convertTotal(input, rate),
      };
    } catch (error) {
      if (error instanceof ExchangeError) throw error;
      if (signal.aborted) throw new ExchangeError('EXCHANGE_TIMEOUT');
      if (error instanceof RangeError) throw new ExchangeError('AMOUNT_OUT_OF_RANGE');
      throw new ExchangeError('EXCHANGE_NETWORK_ERROR');
    }
  }

  private retryAfter(value: string | null): number {
    if (!value) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.clock.now();
    return Number.isFinite(delay) ? Math.min(60000, Math.max(0, delay)) : 0;
  }

  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new ExchangeError('EXCHANGE_INVALID_RESPONSE');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ExchangeError('EXCHANGE_RESPONSE_TOO_LARGE');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ExchangeError('EXCHANGE_INVALID_RESPONSE');
    }
  }
}
