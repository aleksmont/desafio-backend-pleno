const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { ExchangeClient } = require('../dist/exchange/exchange.client');
const { loadConfig } = require('../dist/config');
const { payload, rateBody } = require('./helpers.cjs');
const clock = { now: () => Date.parse('2026-09-14T12:00:00Z') };
const client = (httpFetch, overrides = {}) =>
  new ExchangeClient({ ...loadConfig({}), ...overrides }, httpFetch, clock);
const matches = (code, retryable) => (error) =>
  error.code === code && error.retryable === retryable;

test('exchange requests the configured currencies and converts the total', async () => {
  const service = client(async (url, options) => {
    assert.equal(url.searchParams.get('base'), 'USD');
    assert.equal(url.searchParams.get('symbols'), 'BRL');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(options.headers.Accept, 'application/json');
    return Response.json(rateBody);
  });
  const result = await service.enrich(payload(), 'BRL');
  assert.equal(result.converted_total, 599);
  assert.equal(result.source, 'frankfurter');
  assert.equal(result.rate_date, '2026-09-14');
});

test('identity conversion does not call the provider', async () => {
  const service = client(() => {
    throw new Error('unexpected HTTP call');
  });
  const result = await service.enrich(payload('same', 'BRL'), 'BRL');
  assert.equal(result.converted_total, 119.8);
  assert.equal(result.source, 'identity');
  assert.equal(result.rate, 1);
});

for (const status of [400, 401, 404, 422, 408, 429, 500, 503]) {
  test(`classifies HTTP ${status} correctly`, async () => {
    await assert.rejects(
      client(async () => new Response('private provider details', { status })).enrich(
        payload(),
        'BRL',
      ),
      matches(`EXCHANGE_HTTP_${status}`, [408, 429].includes(status) || status >= 500),
    );
  });
}

for (const [name, body] of [
  ['missing rate', { ...rateBody, rates: { EUR: 5 } }],
  ['negative rate', { ...rateBody, rates: { BRL: -1 } }],
  ['zero rate', { ...rateBody, rates: { BRL: 0 } }],
  ['string rate', { ...rateBody, rates: { BRL: '5' } }],
  ['wrong base', { ...rateBody, base: 'EUR' }],
  ['invalid date', { ...rateBody, date: '2026-02-30' }],
  ['missing base', { rates: { BRL: 5 }, date: '2026-09-14' }],
]) {
  test(`rejects ${name} in external response`, async () => {
    await assert.rejects(
      client(async () => Response.json(body)).enrich(payload(), 'BRL'),
      matches('EXCHANGE_INVALID_RESPONSE', true),
    );
  });
}

test('malformed JSON and empty responses are retried', async () => {
  for (const response of [new Response('{broken'), new Response(null)]) {
    await assert.rejects(
      client(async () => response).enrich(payload(), 'BRL'),
      matches('EXCHANGE_INVALID_RESPONSE', true),
    );
  }
});

test('large response streams are cancelled before parsing', async () => {
  await assert.rejects(
    client(async () => new Response('x'.repeat(65537))).enrich(payload(), 'BRL'),
    matches('EXCHANGE_RESPONSE_TOO_LARGE', false),
  );
});

test('network errors are sanitized and retryable', async () => {
  await assert.rejects(
    client(async () => {
      throw new Error('private secret URL');
    }).enrich(payload(), 'BRL'),
    matches('EXCHANGE_NETWORK_ERROR', true),
  );
});

test('unsafe converted amounts fail permanently', async () => {
  await assert.rejects(
    client(async () => Response.json({ ...rateBody, rates: { BRL: 1e20 } })).enrich(
      payload(),
      'BRL',
    ),
    matches('AMOUNT_OUT_OF_RANGE', false),
  );
});

for (const [header, expected] of [
  ['3', 3000],
  ['999999', 60000],
  ['garbage', 0],
  ['Mon, 14 Sep 2026 12:00:05 GMT', 5000],
  ['Mon, 14 Sep 2026 11:00:00 GMT', 0],
]) {
  test(`handles Retry-After ${header}`, async () => {
    await assert.rejects(
      client(
        async () => new Response(null, { status: 429, headers: { 'Retry-After': header } }),
      ).enrich(payload(), 'BRL'),
      (error) => error.retryAfterMs === expected,
    );
  });
}

test('real HTTP timeout includes a stalled response body', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const service = client(fetch, {
    api: `http://127.0.0.1:${server.address().port}/rates`,
    timeout: 50,
  });
  await assert.rejects(service.enrich(payload(), 'BRL'), matches('EXCHANGE_TIMEOUT', true));
});
