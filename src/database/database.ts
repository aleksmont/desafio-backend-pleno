import { BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';

@Injectable()
export class Database implements BeforeApplicationShutdown {
  readonly connection: DatabaseSync;
  private closed = false;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.database !== ':memory:') mkdirSync(dirname(config.database), { recursive: true });
    this.connection = new DatabaseSync(config.database, { timeout: 5000 });
    try {
      this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = Number(this.connection.prepare('PRAGMA user_version').get()?.user_version);
        if (version > 1) throw new Error('Database schema is newer than this application');
        if (version === 1) return;
        // Version 0 is the original release. Keep its records and indexes intact.
        this.connection.exec(`CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, idem_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL, status TEXT NOT NULL, job_state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER,
          enrichment TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        ALTER TABLE orders ADD COLUMN lease_token TEXT;
        ALTER TABLE orders ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10);
        ALTER TABLE orders ADD COLUMN target_currency TEXT NOT NULL DEFAULT 'BRL';
        CREATE INDEX IF NOT EXISTS queue_due ON orders(job_state, available_at);
        CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status, created_at DESC, id);
        CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id);
        PRAGMA user_version=1;`);
        this.connection
          .prepare('UPDATE orders SET max_attempts=?, target_currency=?')
          .run(config.attempts, config.target);
      });
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  ping(): void {
    this.connection.prepare('SELECT 1').get();
  }

  // Runs after all onModuleDestroy hooks, so the worker drains before closing SQLite.
  beforeApplicationShutdown(): void {
    if (!this.closed) {
      this.connection.close();
      this.closed = true;
    }
  }
}
