const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Database } = require('../dist/database/database');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { loadConfig } = require('../dist/config');
const { payload, setup, tempDatabase, enrichment } = require('./helpers.cjs');

test('receive atomically persists the order and exactly one waiting job', (t) => {
  const { repository, service } = setup(t);
  const created = service.receive(payload());
  assert.equal(created.status, 'RECEIVED');
  assert.equal(created.queue_state, 'WAITING');
  assert.equal(created.duplicate, false);
  assert.equal(created.total, 119.8);
  assert.equal(repository.metrics().total, 1);
  assert.equal(repository.metrics().counts.WAITING, 1);
  const duplicate = service.receive(payload());
  assert.equal(duplicate.id, created.id);
  assert.equal(duplicate.duplicate, true);
});

for (const field of ['currency', 'idempotency_key', 'order_id']) {
  test(`conflicting ${field} rolls back without losing existing orders`, (t) => {
    const { service, repository } = setup(t);
    const first = service.receive(payload());
    assert.throws(
      () => service.receive({ ...payload(), [field]: 'other' }),
      (e) => e.getStatus() === 409,
    );
    assert.equal(service.get(first.id).status, 'RECEIVED');
    assert.equal(repository.metrics().total, 1);
    assert.equal(service.receive(payload('second')).duplicate, false);
  });
}

test('crossed external ID and idempotency key cannot merge two orders', (t) => {
  const { service, repository } = setup(t);
  service.receive(payload('a'));
  service.receive(payload('b'));
  assert.throws(
    () => service.receive({ ...payload('a'), idempotency_key: 'b' }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(repository.metrics().total, 2);
});

test('stable pagination, filters, missing IDs and SQL parameter binding', (t) => {
  const { service, clock, repository } = setup(t);
  const first = service.receive(payload("'; DROP TABLE orders; --"));
  clock.advance(1);
  const second = service.receive(payload('second'));
  assert.equal(service.list({ limit: 1, offset: 0 })[0].id, second.id);
  assert.equal(service.list({ limit: 1, offset: 1 })[0].id, first.id);
  assert.deepEqual(service.list({ status: 'COMPLETED', limit: 50, offset: 0 }), []);
  assert.equal(repository.find('missing'), undefined);
  assert.throws(
    () => service.get('missing'),
    (e) => e.getStatus() === 404,
  );
});

test('jobs are leased exclusively and completed only by the current owner', (t) => {
  const { repository } = setup(t);
  const created = repository.receive(payload());
  const job = repository.claim();
  assert.equal(job.id, created.order.id);
  assert.equal(job.attempts, 1);
  assert.equal(repository.claim(), undefined);
  assert.equal(repository.complete({ ...job, leaseToken: 'wrong-token' }, enrichment), false);
  assert.equal(repository.complete(job, enrichment), true);
  assert.equal(repository.complete(job, enrichment), false);
  assert.equal(repository.fail(job, 'late-error', true, 1000), false);
  assert.deepEqual(repository.find(job.id).enrichment, enrichment);
});

test('transient failure respects due time and eventually reaches DLQ', (t) => {
  const { repository, clock } = setup(t, { attempts: 2 });
  const { order } = repository.receive(payload());
  let job = repository.claim();
  assert.equal(repository.fail(job, 'EXCHANGE_TIMEOUT', true, 1000), true);
  assert.equal(repository.metrics().counts.RETRY, 1);
  clock.advance(999);
  assert.equal(repository.claim(), undefined);
  clock.advance(1);
  job = repository.claim();
  assert.equal(job.attempts, 2);
  repository.fail(job, 'EXCHANGE_TIMEOUT', true, 1000);
  assert.equal(repository.find(order.id).status, 'FAILED_ENRICHMENT');
  assert.equal(repository.metrics().counts.DLQ, 1);
  clock.advance(10000);
  assert.equal(repository.claim(), undefined);
});

test('permanent failure goes directly to DLQ', (t) => {
  const { repository } = setup(t);
  repository.receive(payload());
  const job = repository.claim();
  repository.fail(job, 'EXCHANGE_HTTP_422', false, 0);
  assert.equal(repository.find(job.id).queueState, 'DLQ');
  assert.equal(repository.find(job.id).attempts, 1);
});

test('expired leases reject late writes before and after reassignment', (t) => {
  const { repository, clock, config } = setup(t);
  repository.receive(payload());
  const old = repository.claim();
  clock.advance(config.leaseMs);
  assert.equal(repository.complete(old, enrichment), false);
  assert.equal(repository.fail(old, 'late', true, 0), false);
  assert.equal(repository.claim(), undefined);
  assert.equal(repository.find(old.id).lastError, 'WORKER_LEASE_EXPIRED');
  clock.advance(config.backoff);
  const next = repository.claim();
  assert.notEqual(next.leaseToken, old.leaseToken);
  assert.equal(next.attempts, 2);
  assert.equal(repository.complete(old, enrichment), false);
  assert.equal(repository.complete(next, enrichment), true);
});

test('expired final attempt becomes DLQ instead of exceeding its budget', (t) => {
  const { repository, clock, config } = setup(t, { attempts: 1 });
  repository.receive(payload());
  const job = repository.claim();
  clock.advance(config.leaseMs + 1);
  assert.equal(repository.claim(), undefined);
  assert.equal(repository.find(job.id).status, 'FAILED_ENRICHMENT');
  assert.equal(repository.find(job.id).attempts, 1);
});

test('separate database connections cannot claim the same job', (t) => {
  const filename = tempDatabase(t);
  const first = setup(t, { database: filename });
  const second = setup(t, { database: filename });
  first.repository.receive(payload());
  const job = first.repository.claim();
  assert.ok(job);
  assert.equal(second.repository.claim(), undefined);
  assert.equal(second.repository.complete({ ...job, leaseToken: 'forged' }, enrichment), false);
});

test('restart preserves pending jobs, idempotency and per-order configuration', (t) => {
  const filename = tempDatabase(t);
  const first = setup(t, { database: filename, target: 'EUR', attempts: 2 });
  const created = first.repository.receive(payload());
  first.database.beforeApplicationShutdown();
  const second = setup(t, { database: filename, target: 'BRL', attempts: 5 });
  assert.equal(second.repository.receive(payload()).duplicate, true);
  const job = second.repository.claim();
  assert.equal(job.id, created.order.id);
  assert.equal(job.targetCurrency, 'EUR');
  assert.equal(job.maxAttempts, 2);
});

test('migration upgrades the original database without deleting orders', (t) => {
  const filename = tempDatabase(t);
  const legacy = new DatabaseSync(filename);
  legacy.exec(
    `CREATE TABLE orders (id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, idem_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL, job_state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER, enrichment TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  );
  legacy
    .prepare(
      "INSERT INTO orders(id,external_id,idem_key,payload,status,job_state,available_at,created_at,updated_at) VALUES('legacy','order-1','order-1',?,'RECEIVED','WAITING',0,'2026-09-14','2026-09-14')",
    )
    .run(JSON.stringify(payload()));
  legacy.close();
  const { repository, database } = setup(t, { database: filename });
  assert.equal(repository.find('legacy').input.order_id, 'order-1');
  assert.equal(repository.receive(payload()).duplicate, true);
  assert.equal(database.connection.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(repository.claim().id, 'legacy');
});

test('migration rejects newer schema and transaction failures roll back', (t) => {
  const filename = tempDatabase(t);
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA user_version=2');
  db.close();
  assert.throws(() => new Database({ ...loadConfig({}), database: filename }), /newer/);
  const { database } = setup(t);
  assert.throws(
    () =>
      database.transaction(() => {
        database.connection.exec('CREATE TABLE rollback_test(id)');
        throw new Error('failure');
      }),
    /failure/,
  );
  assert.equal(
    database.connection.prepare("SELECT name FROM sqlite_master WHERE name='rollback_test'").get(),
    undefined,
  );
});

test('service propagates storage failures without turning them into conflicts', () => {
  const { OrdersService } = require('../dist/orders/orders.service');
  const error = new Error('disk full');
  const service = new OrdersService({
    receive: () => {
      throw error;
    },
  });
  assert.throws(
    () => service.receive(payload()),
    (e) => e === error,
  );
});
