const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { loadConfig } = require('../dist/config');
const { Database } = require('../dist/database/database');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { OrdersService } = require('../dist/orders/orders.service');

function payload(key = 'order-1', currency = 'USD') {
  return {
    order_id: key,
    customer: { email: 'ana@example.com', name: 'Ana' },
    items: [{ sku: 'ABC', qty: 2, unit_price: 59.9 }],
    currency,
    idempotency_key: key,
  };
}

function setup(t, overrides = {}) {
  const config = Object.freeze({ ...loadConfig({}), database: ':memory:', ...overrides });
  let now = Date.parse('2026-09-14T12:00:00Z');
  const clock = {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
  const database = new Database(config);
  t.after(() => database.beforeApplicationShutdown());
  const repository = new OrdersRepository(database, config, clock);
  return { config, clock, database, repository, service: new OrdersService(repository) };
}

function tempDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'orders.sqlite');
}

const rateBody = { base: 'USD', rates: { BRL: 5 }, date: '2026-09-14' };
const enrichment = {
  source: 'frankfurter',
  currency: 'BRL',
  rate: 5,
  rate_date: '2026-09-14',
  converted_total: 599,
};
module.exports = { payload, setup, tempDatabase, rateBody, enrichment };
