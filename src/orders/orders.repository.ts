import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { CLOCK, Clock } from '../common/runtime';
import { Database } from '../database/database';
import { canonicalPayload, ClaimedOrder, Enrichment, OrderRecord } from './order';
import { ListOrders, OrderInput, OrderStatus, QueueState, queueStates } from './order.schema';

interface OrderRow {
  id: string;
  payload: string;
  status: OrderStatus;
  job_state: QueueState;
  attempts: number;
  available_at: number;
  lease_token: string | null;
  max_attempts: number;
  target_currency: string;
  enrichment: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class IdempotencyConflict extends Error {
  constructor() {
    super('Order ID or idempotency key already used with a different payload');
  }
}

@Injectable()
export class OrdersRepository {
  constructor(
    private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.connection;
  }

  private map(row: OrderRow): OrderRecord {
    return {
      id: row.id,
      input: JSON.parse(row.payload) as OrderInput,
      status: row.status,
      queueState: row.job_state,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      targetCurrency: row.target_currency,
      availableAt: row.available_at,
      leaseToken: row.lease_token,
      enrichment: row.enrichment ? (JSON.parse(row.enrichment) as Enrichment) : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  receive(input: OrderInput): { order: OrderRecord; duplicate: boolean } {
    return this.database.transaction(() => {
      const payload = canonicalPayload(input);
      const existing = this.db
        .prepare('SELECT * FROM orders WHERE idem_key=? OR external_id=?')
        .all(input.idempotency_key, input.order_id) as unknown as OrderRow[];
      if (existing.length > 0) {
        const row = existing[0]!;
        if (
          existing.length !== 1 ||
          canonicalPayload(JSON.parse(row.payload) as OrderInput) !== payload
        ) {
          throw new IdempotencyConflict();
        }
        return { order: this.map(row), duplicate: true };
      }
      const now = this.clock.now();
      const row = this.db
        .prepare(
          `INSERT INTO orders
        (id, external_id, idem_key, payload, status, job_state, available_at, created_at, updated_at, max_attempts, target_currency)
        VALUES (?, ?, ?, ?, 'RECEIVED', 'WAITING', ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.order_id,
          input.idempotency_key,
          payload,
          now,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
          this.config.attempts,
          this.config.target,
        ) as unknown as OrderRow;
      return { order: this.map(row), duplicate: false };
    });
  }

  find(id: string): OrderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as unknown as
      OrderRow | undefined;
    return row ? this.map(row) : undefined;
  }

  list(query: ListOrders): OrderRecord[] {
    const rows = query.status
      ? this.db
          .prepare(
            'SELECT * FROM orders WHERE status=? ORDER BY created_at DESC, id LIMIT ? OFFSET ?',
          )
          .all(query.status, query.limit, query.offset)
      : this.db
          .prepare('SELECT * FROM orders ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
          .all(query.limit, query.offset);
    return (rows as unknown as OrderRow[]).map((row) => this.map(row));
  }

  metrics() {
    const counts = Object.fromEntries(queueStates.map((state) => [state, 0])) as Record<
      QueueState,
      number
    >;
    for (const row of this.db
      .prepare('SELECT job_state, COUNT(*) AS count FROM orders GROUP BY job_state')
      .all()) {
      counts[row.job_state as QueueState] = Number(row.count);
    }
    return {
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      max_attempts: this.config.attempts,
    };
  }

  claim(): ClaimedOrder | undefined {
    return this.database.transaction(() => {
      const now = this.clock.now();
      const timestamp = new Date(now).toISOString();
      // A unique lease token fences callbacks from a previous owner. Recoveries count as attempts.
      this.db
        .prepare(
          `UPDATE orders SET
        job_state=CASE WHEN attempts>=max_attempts THEN 'DLQ' ELSE 'RETRY' END,
        status=CASE WHEN attempts>=max_attempts THEN 'FAILED_ENRICHMENT' ELSE 'RECEIVED' END,
        available_at=?, lease_until=NULL, lease_token=NULL,
        last_error='WORKER_LEASE_EXPIRED', updated_at=?
        WHERE job_state='ACTIVE' AND lease_until<=?`,
        )
        .run(now + this.config.backoff, timestamp, now);
      const row = this.db
        .prepare(
          `UPDATE orders SET job_state='ACTIVE', status='PROCESSING',
        attempts=attempts+1, lease_until=?, lease_token=?, updated_at=?
        WHERE id=(SELECT id FROM orders WHERE job_state IN ('WAITING','RETRY')
          AND available_at<=? AND attempts<max_attempts ORDER BY available_at, id LIMIT 1)
        RETURNING *`,
        )
        .get(now + this.config.leaseMs, randomUUID(), timestamp, now) as unknown as
        OrderRow | undefined;
      return row ? (this.map(row) as ClaimedOrder) : undefined;
    });
  }

  complete(job: ClaimedOrder, enrichment: Enrichment): boolean {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `UPDATE orders SET status='COMPLETED', job_state='COMPLETED',
      enrichment=?, lease_until=NULL, lease_token=NULL, last_error=NULL, updated_at=?
      WHERE id=? AND job_state='ACTIVE' AND lease_token=? AND lease_until>?`,
      )
      .run(JSON.stringify(enrichment), new Date(now).toISOString(), job.id, job.leaseToken, now);
    return result.changes === 1;
  }

  fail(job: ClaimedOrder, code: string, retryable: boolean, delayMs: number): boolean {
    const now = this.clock.now();
    const terminal = !retryable || job.attempts >= job.maxAttempts;
    const result = this.db
      .prepare(
        `UPDATE orders SET status=?, job_state=?, available_at=?,
      lease_until=NULL, lease_token=NULL, last_error=?, updated_at=?
      WHERE id=? AND job_state='ACTIVE' AND lease_token=? AND lease_until>?`,
      )
      .run(
        terminal ? 'FAILED_ENRICHMENT' : 'RECEIVED',
        terminal ? 'DLQ' : 'RETRY',
        now + delayMs,
        code,
        new Date(now).toISOString(),
        job.id,
        job.leaseToken,
        now,
      );
    return result.changes === 1;
  }
}
