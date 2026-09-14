import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { config } from './config';
import { OrderInput } from './order.schema';
import { OrdersService } from './orders.service';
@Injectable()
export class QueueWorker implements OnModuleInit, OnModuleDestroy {
  private timer?:NodeJS.Timeout;
  private running?:Promise<void>;
  private readonly logger = new Logger(QueueWorker.name);
  constructor(private readonly orders:OrdersService) {}
  onModuleInit() { this.timer = setInterval(() => {
    if (!this.running) this.running = this.tick().catch(error => this.logger.error(error)).finally(() => { this.running = undefined; });
  }, config.poll); }
  async onModuleDestroy() { clearInterval(this.timer); await this.running; }
  private async tick() {
    const row = this.orders.claim(); if (!row) return;
    try {
      const input = JSON.parse(row.payload) as OrderInput;
      const url = new URL(config.api);
      url.searchParams.set('base', input.currency);
      url.searchParams.set('symbols', config.target);
      let rate = 1; let date = new Date().toISOString().slice(0,10);
      if (input.currency !== config.target) {
        const response = await fetch(url, {signal:AbortSignal.timeout(config.timeout)});
        if (!response.ok) throw new Error(`Exchange API HTTP ${response.status}`);
        const data = await response.json() as {rates?:Record<string,number>;date?:string};
        rate = data.rates?.[config.target] as number;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || typeof data.date !== 'string') throw new Error('Invalid exchange API response');
        date = data.date;
      }
      const cents = input.items.reduce((sum, item) => sum + Math.round(item.unit_price * 100) * item.qty, 0);
      const converted = Math.round(cents * rate);
      if (!Number.isSafeInteger(converted)) throw new Error('Converted amount exceeds supported range');
      this.orders.complete(row, {source:input.currency === config.target ? 'identity' : 'frankfurter', currency:config.target, rate, rate_date:date, converted_total:converted / 100});
    } catch (error) { this.orders.fail(row, error); this.logger.warn(`Order ${row.id}, attempt ${row.attempts}: ${error instanceof Error ? error.message : 'failed'}`); }
  }
}
