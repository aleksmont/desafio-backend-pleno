const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { loadConfig } = require('../dist/config');
const { QueueWorker } = require('../dist/queue/queue.worker');
const { payload, rateBody } = require('./helpers.cjs');

async function api(t, options = {}) {
  const app = await createApp({
    config: { ...loadConfig({}), database: ':memory:', poll: 5 },
    workerEnabled: false,
    logger: false,
    httpFetch: async () => Response.json(rateBody),
    ...options,
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  async function request(path, body) {
    const response = await fetch(
      base + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, body: await response.json() };
  }
  return { app, base, request };
}

test('HTTP route contract: health, receipt, processing, detail, filtering and metrics', async (t) => {
  const { app, request } = await api(t);
  assert.equal((await request('/health')).body.status, 'ok');
  assert.ok((await request('/')).body.endpoints.includes('GET /orders'));
  const created = await request('/webhooks/orders', payload());
  assert.equal(created.status, 202);
  assert.equal(created.body.status, 'RECEIVED');
  await app.get(QueueWorker).processNext();
  const detail = await request('/orders/' + created.body.id);
  assert.equal(detail.body.status, 'COMPLETED');
  assert.equal(detail.body.enrichment.converted_total, 599);
  assert.equal((await request('/orders?status=COMPLETED&limit=1&offset=0')).body.length, 1);
  assert.equal((await request('/orders?status=RECEIVED')).body.length, 0);
  assert.equal((await request('/queue/metrics')).body.counts.COMPLETED, 1);
  assert.equal((await request('/orders/missing')).status, 404);
});

test('parallel webhook requests create only one durable order', async (t) => {
  const { request } = await api(t);
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => request('/webhooks/orders', payload())),
  );
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
  assert.equal(responses.filter((r) => !r.body.duplicate).length, 1);
  assert.equal((await request('/queue/metrics')).body.total, 1);
  assert.equal((await request('/webhooks/orders', { ...payload(), currency: 'EUR' })).status, 409);
});

test('HTTP rejects malformed bodies and ambiguous query parameters', async (t) => {
  const { request, base } = await api(t);
  for (const body of [{}, null, [], { ...payload(), extra: true }])
    assert.equal((await request('/webhooks/orders', body)).status, 400);
  for (const query of [
    'limit=1&limit=2',
    'status=COMPLETED&status=RECEIVED',
    'limit=101',
    'offset=-1',
    'status=bad',
  ]) {
    assert.equal((await request('/orders?' + query)).status, 400);
  }
  const malformed = await fetch(base + '/webhooks/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const large = await fetch(base + '/webhooks/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ large: 'a'.repeat(110000) }),
  });
  assert.equal(large.status, 413);
});

test('two app instances have isolated injected configuration and databases', async (t) => {
  const first = await api(t);
  const second = await api(t);
  await first.request('/webhooks/orders', payload());
  assert.equal((await first.request('/queue/metrics')).body.total, 1);
  assert.equal((await second.request('/queue/metrics')).body.total, 0);
});

test('automatic background processing reaches completion over HTTP', async (t) => {
  const { request } = await api(t, { workerEnabled: true });
  const created = await request('/webhooks/orders', payload());
  const deadline = Date.now() + 3000;
  let state;
  while (Date.now() < deadline) {
    state = (await request('/orders/' + created.body.id)).body.status;
    if (state === 'COMPLETED') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state, 'COMPLETED');
});
