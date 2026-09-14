import Decimal from 'decimal.js';
import { OrderInput, OrderStatus, QueueState } from './order.schema';

export interface Enrichment {
  source: 'frankfurter' | 'identity';
  currency: string;
  rate: number;
  rate_date: string;
  converted_total: number;
}

export interface OrderRecord {
  id: string;
  input: OrderInput;
  status: OrderStatus;
  queueState: QueueState;
  attempts: number;
  maxAttempts: number;
  targetCurrency: string;
  availableAt: number;
  leaseToken: string | null;
  enrichment: Enrichment | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedOrder extends OrderRecord {
  leaseToken: string;
}

/** Explicit field order gives equivalent JSON objects the same idempotency identity. */
export function canonicalPayload(input: OrderInput): string {
  return JSON.stringify({
    order_id: input.order_id,
    customer: { email: input.customer.email, name: input.customer.name },
    items: input.items.map(({ sku, qty, unit_price }) => ({ sku, qty, unit_price })),
    currency: input.currency,
    idempotency_key: input.idempotency_key,
  });
}

export function totalCents(input: OrderInput): number {
  return input.items.reduce(
    (sum, item) => sum + new Decimal(item.unit_price).times(100).toNumber() * item.qty,
    0,
  );
}

export function convertTotal(input: OrderInput, rate: number): number {
  const cents = new Decimal(totalCents(input))
    .times(rate)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new RangeError('Converted amount exceeds supported range');
  return cents / 100;
}

export function presentOrder(order: OrderRecord) {
  return {
    id: order.id,
    ...order.input,
    total: totalCents(order.input) / 100,
    status: order.status,
    attempts: order.attempts,
    queue_state: order.queueState,
    enrichment: order.enrichment,
    last_error: order.lastError,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}
