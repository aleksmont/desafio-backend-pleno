const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Logger } = require('@nestjs/common');
const { QueueWorker } = require('../dist/queue/queue.worker');
const { RetryPolicy } = require('../dist/queue/retry.policy');
const { ExchangeError } = require('../dist/exchange/exchange.error');
const { setup, payload, enrichment } = require('./helpers.cjs');
Logger.overrideLogger(false);
function worker(context, exchange, enabled = false) {
  return new QueueWorker(
    context.repository,
    exchange,
    new RetryPolicy(context.config, () => 0.5),
    context.config,
    enabled,
  );
}

test('empty queue performs no network work', async (t) => {
  const ctx = setup(t);
  const queue = worker(ctx, { enrich: () => assert.fail('unexpected call') });
  assert.equal(await queue.processNext(), false);
  await queue.onModuleDestroy();
  assert.equal(await queue.processNext(), false);
});

test('worker converts and persists a successful order', async (t) => {
  const ctx = setup(t);
  const { order } = ctx.repository.receive(payload());
  const queue = worker(ctx, {
    enrich: async (input, target) => {
      assert.equal(input.order_id, 'order-1');
      assert.equal(target, 'BRL');
      return enrichment;
    },
  });
  assert.equal(await queue.processNext(), true);
  assert.deepEqual(ctx.repository.find(order.id).enrichment, enrichment);
  assert.equal(ctx.repository.find(order.id).status, 'COMPLETED');
});

test('worker retries transient errors then succeeds and clears the last error', async (t) => {
  const ctx = setup(t);
  const { order } = ctx.repository.receive(payload());
  let calls = 0;
  const queue = worker(ctx, {
    enrich: async () => {
      if (++calls === 1) throw new ExchangeError('EXCHANGE_TIMEOUT', true, 5000);
      return enrichment;
    },
  });
  await queue.processNext();
  assert.equal(ctx.repository.find(order.id).queueState, 'RETRY');
  ctx.clock.advance(4999);
  assert.equal(await queue.processNext(), false);
  ctx.clock.advance(1);
  await queue.processNext();
  assert.equal(calls, 2);
  assert.equal(ctx.repository.find(order.id).lastError, null);
});

test('worker exhausts the attempt budget and stops processing the DLQ', async (t) => {
  const ctx = setup(t, { attempts: 2 });
  const { order } = ctx.repository.receive(payload());
  const queue = worker(ctx, {
    enrich: async () => {
      throw new ExchangeError('EXCHANGE_HTTP_503', true);
    },
  });
  await queue.processNext();
  ctx.clock.advance(1000);
  await queue.processNext();
  assert.equal(ctx.repository.find(order.id).status, 'FAILED_ENRICHMENT');
  ctx.clock.advance(10000);
  assert.equal(await queue.processNext(), false);
});

test('worker sanitizes unexpected enrichment errors', async (t) => {
  const ctx = setup(t);
  const { order } = ctx.repository.receive(payload());
  await worker(ctx, {
    enrich: async () => {
      throw new Error('customer personal information');
    },
  }).processNext();
  assert.equal(ctx.repository.find(order.id).lastError, 'ENRICHMENT_INTERNAL_ERROR');
});

test('overlapping polls share one job and shutdown waits for its completion', async (t) => {
  const ctx = setup(t);
  const { order } = ctx.repository.receive(payload());
  let resolve;
  const queue = worker(ctx, {
    enrich: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const first = queue.processNext();
  const second = queue.processNext();
  assert.equal(first, second);
  let stopped = false;
  const closing = queue.onModuleDestroy().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  resolve(enrichment);
  await closing;
  await first;
  assert.equal(ctx.repository.find(order.id).status, 'COMPLETED');
  assert.equal(stopped, true);
});

for (const fail of [false, true]) {
  test(`worker ignores expired ownership on ${fail ? 'failure' : 'success'}`, async (t) => {
    const ctx = setup(t);
    ctx.repository.receive(payload());
    const queue = worker(ctx, {
      enrich: async () => {
        ctx.clock.advance(ctx.config.leaseMs);
        if (fail) throw new ExchangeError('TIMEOUT', true);
        return enrichment;
      },
    });
    await queue.processNext();
    assert.equal(ctx.repository.metrics().counts.ACTIVE, 1);
    assert.equal(ctx.repository.claim(), undefined);
    assert.equal(ctx.repository.metrics().counts.RETRY, 1);
  });
}

test('polling recovers from storage errors and shuts down without another claim', async (t) => {
  const ctx = setup(t, { poll: 5 });
  let calls = 0;
  let observed;
  const recovered = new Promise((resolve) => {
    observed = resolve;
  });
  const repository = {
    claim: () => {
      calls++;
      if (calls === 1) throw new Error('busy');
      observed();
      return undefined;
    },
  };
  const queue = new QueueWorker(
    repository,
    {},
    new RetryPolicy(ctx.config, () => 0.5),
    ctx.config,
    true,
  );
  t.after(() => queue.onModuleDestroy());
  queue.onModuleInit();
  await recovered;
  await queue.onModuleDestroy();
  const count = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, count);
  assert.ok(calls >= 2);
});

test('persistence failure preserves the lease and does not block shutdown', async (t) => {
  const ctx = setup(t);
  const { order } = ctx.repository.receive(payload());
  let resolve;
  ctx.repository.complete = () => {
    throw new Error('disk full');
  };
  const queue = worker(ctx, {
    enrich: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const processing = assert.rejects(queue.processNext(), /disk full/);
  const stopping = queue.onModuleDestroy();
  resolve(enrichment);
  await Promise.all([processing, stopping]);
  assert.equal(ctx.repository.find(order.id).queueState, 'ACTIVE');
  assert.equal(ctx.repository.find(order.id).lastError, null);
});
