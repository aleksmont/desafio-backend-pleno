import { BadRequestException, ConflictException, Injectable, NotFoundException, BeforeApplicationShutdown } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';
import { OrderInput, statuses } from './order.schema';
type Row = {id:string; payload:string; status:string; job_state:string; attempts:number; available_at:number; lease_until:number|null; enrichment:string|null; last_error:string|null; created_at:string; updated_at:string};
@Injectable()
export class OrdersService implements BeforeApplicationShutdown {
  private readonly db: DatabaseSync;
  constructor() {
    if (config.database !== ':memory:') mkdirSync(dirname(config.database), {recursive:true});
    this.db = new DatabaseSync(config.database, {timeout:5000});
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, idem_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL, status TEXT NOT NULL, job_state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER,
      enrichment TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS queue_due ON orders(job_state, available_at);`);
  }
  beforeApplicationShutdown() { this.db.close(); }
  private view(row: Row) {
    const input = JSON.parse(row.payload) as OrderInput;
    return {id:row.id, ...input, total:input.items.reduce((sum, item) => sum + Math.round(item.unit_price * 100) * item.qty, 0) / 100, status:row.status, attempts:row.attempts, queue_state:row.job_state, enrichment:row.enrichment ? JSON.parse(row.enrichment) : null, last_error:row.last_error, created_at:row.created_at, updated_at:row.updated_at};
  }
  receive(input: OrderInput) {
    const payload = JSON.stringify(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM orders WHERE idem_key = ? OR external_id = ?').all(input.idempotency_key, input.order_id) as unknown as Row[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0].payload !== payload) throw new ConflictException('Order ID or idempotency key already used with a different payload');
        this.db.exec('COMMIT');
        return {...this.view(existing[0]), duplicate:true};
      }
      const id = randomUUID(); const now = new Date().toISOString();
      // One durable record atomically represents both the order and its queued job.
      this.db.prepare(`INSERT INTO orders (id, external_id, idem_key, payload, status, job_state, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'RECEIVED', 'WAITING', ?, ?, ?)`).run(id, input.order_id, input.idempotency_key, payload, Date.now(), now, now);
      this.db.exec('COMMIT');
      return {...this.get(id), duplicate:false};
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  get(id:string) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundException('Order not found');
    return this.view(row);
  }
  list(status?:string, limit = '50', offset = '0') {
    if (status && !statuses.includes(status as typeof statuses[number])) throw new BadRequestException('Invalid status');
    if (!/^\d+$/.test(limit) || !/^\d+$/.test(offset) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(Number(offset))) throw new BadRequestException('Invalid pagination: limit 1–100, offset >= 0');
    const rows = status ? this.db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(status, Number(limit), Number(offset)) : this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(Number(limit), Number(offset));
    return (rows as unknown as Row[]).map(row => this.view(row));
  }
  metrics() {
    const counts:Record<string,number> = {WAITING:0, ACTIVE:0, RETRY:0, COMPLETED:0, DLQ:0};
    for (const row of this.db.prepare('SELECT job_state, COUNT(*) AS count FROM orders GROUP BY job_state').all()) counts[String(row.job_state)] = Number(row.count);
    return {counts, total:Object.values(counts).reduce((a,b) => a+b,0), max_attempts:config.attempts};
  }
  claim():Row | undefined {
    const now = Date.now();
    // Expired leases recover interrupted processes, including their final attempt.
    this.db.prepare(`UPDATE orders SET job_state = CASE WHEN attempts >= ? THEN 'DLQ' ELSE 'RETRY' END, status = CASE WHEN attempts >= ? THEN 'FAILED_ENRICHMENT' ELSE 'RECEIVED' END, available_at = ?, lease_until = NULL, last_error = 'Worker lease expired', updated_at = ? WHERE job_state = 'ACTIVE' AND lease_until <= ?`).run(config.attempts, config.attempts, now, new Date().toISOString(), now);
    return this.db.prepare(`UPDATE orders SET job_state = 'ACTIVE', status = 'PROCESSING', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = (SELECT id FROM orders WHERE job_state IN ('WAITING', 'RETRY') AND available_at <= ? ORDER BY available_at LIMIT 1) RETURNING *`).get(now + config.timeout + 30000, new Date().toISOString(), now) as Row | undefined;
  }
  complete(row:Row, enrichment:unknown) {
    this.db.prepare(`UPDATE orders SET status='COMPLETED', job_state='COMPLETED', enrichment=?, lease_until=NULL, last_error=NULL, updated_at=? WHERE id=? AND job_state='ACTIVE' AND attempts=?`).run(JSON.stringify(enrichment), new Date().toISOString(), row.id, row.attempts);
  }
  fail(row:Row, error:unknown) {
    const terminal = row.attempts >= config.attempts;
    this.db.prepare(`UPDATE orders SET status=?, job_state=?, available_at=?, lease_until=NULL, last_error=?, updated_at=? WHERE id=? AND job_state='ACTIVE' AND attempts=?`).run(terminal ? 'FAILED_ENRICHMENT' : 'RECEIVED', terminal ? 'DLQ' : 'RETRY', Date.now() + config.backoff * 2 ** (row.attempts-1), error instanceof Error ? error.message.slice(0,500) : 'Enrichment failed', new Date().toISOString(), row.id, row.attempts);
  }
}
