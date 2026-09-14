const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../dist/config');
const { orderSchema, listOrdersSchema } = require('../dist/orders/order.schema');
const { canonicalPayload, totalCents, convertTotal } = require('../dist/orders/order');
const { ValidationPipe } = require('../dist/common/validation.pipe');
const { RetryPolicy } = require('../dist/queue/retry.policy');
const { payload } = require('./helpers.cjs');

test('configuration has immutable defaults and is independent between loads', () => {
  assert.equal(loadConfig({}).port, 3000);
  assert.equal(loadConfig({ PORT: '4000' }).port, 4000);
  assert.equal(loadConfig({}).port, 3000);
  assert.ok(Object.isFrozen(loadConfig({})));
  assert.equal(loadConfig({ HTTP_TIMEOUT_MS: '2000' }).leaseMs, 32000);
});
for (const [name, value] of [
  ['PORT', ''],
  ['PORT', '1.5'],
  ['PORT', '-1'],
  ['PORT', '65536'],
  ['PORT', 'Infinity'],
  ['MAX_ATTEMPTS', '11'],
  ['HTTP_TIMEOUT_MS', '0'],
  ['RETRY_BASE_MS', '60001'],
  ['POLL_MS', 'abc'],
  ['TARGET_CURRENCY', 'brl'],
  ['DATABASE_PATH', ' '],
  ['HOST', ''],
  ['EXCHANGE_API_URL', 'file:///tmp/test'],
  ['EXCHANGE_API_URL', 'http://user:secret@example.com'],
  ['EXCHANGE_API_URL', 'invalid'],
]) {
  test(`configuration rejects invalid ${name} (${value.split('@').pop()})`, () => {
    assert.throws(() => loadConfig({ [name]: value }), new RegExp(name));
  });
}

test('validation normalizes whitespace and accepts zero-priced items', () => {
  const input = payload();
  input.customer.name = ' Ana ';
  input.items[0].unit_price = 0;
  assert.equal(orderSchema.parse(input).customer.name, 'Ana');
  assert.equal(totalCents(orderSchema.parse(input)), 0);
});
const invalidInputs = [
  [
    'missing customer',
    (p) => {
      delete p.customer;
    },
  ],
  [
    'invalid email',
    (p) => {
      p.customer.email = 'bad';
    },
  ],
  [
    'empty items',
    (p) => {
      p.items = [];
    },
  ],
  [
    'too many items',
    (p) => {
      p.items = Array(101).fill(p.items[0]);
    },
  ],
  [
    'negative quantity',
    (p) => {
      p.items[0].qty = -1;
    },
  ],
  [
    'fractional quantity',
    (p) => {
      p.items[0].qty = 1.5;
    },
  ],
  [
    'numeric strings',
    (p) => {
      p.items[0].qty = '2';
    },
  ],
  [
    'negative price',
    (p) => {
      p.items[0].unit_price = -1;
    },
  ],
  [
    'excess precision',
    (p) => {
      p.items[0].unit_price = 1.001;
    },
  ],
  [
    'near-cent precision',
    (p) => {
      p.items[0].unit_price = 1.000000001;
    },
  ],
  [
    'nonfinite price',
    (p) => {
      p.items[0].unit_price = Infinity;
    },
  ],
  [
    'extra field',
    (p) => {
      p.admin = true;
    },
  ],
  [
    'extra nested field',
    (p) => {
      p.customer.admin = true;
    },
  ],
  [
    'blank ID',
    (p) => {
      p.order_id = ' ';
    },
  ],
  [
    'long key',
    (p) => {
      p.idempotency_key = 'a'.repeat(201);
    },
  ],
  [
    'invalid currency',
    (p) => {
      p.currency = 'usd';
    },
  ],
];
for (const [name, mutate] of invalidInputs) {
  test(`order validation rejects ${name}`, () => {
    const input = payload();
    mutate(input);
    assert.equal(orderSchema.safeParse(input).success, false);
  });
}

test('canonical identity ignores object property order, preserves item order', () => {
  const first = payload();
  const second = {
    ...first,
    customer: { name: 'Ana', email: 'ana@example.com' },
    items: [{ unit_price: 59.9, qty: 2, sku: 'ABC' }],
  };
  assert.equal(canonicalPayload(first), canonicalPayload(second));
  first.items.push({ sku: 'XYZ', qty: 1, unit_price: 1 });
  const reversed = { ...first, items: [...first.items].reverse() };
  assert.notEqual(canonicalPayload(first), canonicalPayload(reversed));
});

test('money totals and half-cent FX rounding use decimal arithmetic', () => {
  const input = payload();
  input.items = [
    { sku: 'A', qty: 3, unit_price: 0.1 },
    { sku: 'B', qty: 1, unit_price: 0.2 },
  ];
  assert.equal(totalCents(input), 50);
  assert.equal(convertTotal(input, 2.01), 1.01);
  assert.throws(() => convertTotal(input, 1e20), RangeError);
});

test('pagination defaults, bounds and repeated query arguments', () => {
  assert.deepEqual(listOrdersSchema.parse({}), { limit: 50, offset: 0 });
  assert.deepEqual(listOrdersSchema.parse({ status: 'COMPLETED', limit: '1', offset: '2' }), {
    status: 'COMPLETED',
    limit: 1,
    offset: 2,
  });
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { offset: '-1' },
    { offset: '9007199254740992' },
    { limit: ['1', '2'] },
    { status: ['RECEIVED', 'COMPLETED'] },
    { status: '' },
    { offset: '2.5' },
    { other: 'x' },
  ]) {
    assert.equal(listOrdersSchema.safeParse(query).success, false);
  }
});

test('validation errors identify fields without echoing private input', () => {
  const pipe = new ValidationPipe(orderSchema);
  assert.deepEqual(pipe.transform(payload()), payload());
  assert.throws(
    () =>
      pipe.transform({ ...payload(), customer: { email: 'private-invalid-address', name: 'Ana' } }),
    (error) => {
      assert.equal(error.getStatus(), 400);
      const body = error.getResponse();
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(body.errors[0].field, 'customer.email');
      assert.ok(!JSON.stringify(body).includes('private-invalid-address'));
      return true;
    },
  );
});

test('retry backoff is exponential, jittered, capped and honors Retry-After', () => {
  const config = loadConfig({});
  const middle = new RetryPolicy(config, () => 0.5);
  assert.equal(middle.delay(1), 1000);
  assert.equal(middle.delay(2), 2000);
  assert.equal(middle.delay(10), 60000);
  assert.equal(middle.delay(1, 5000), 5000);
  assert.equal(new RetryPolicy(config, () => 0).delay(1), 800);
  assert.equal(new RetryPolicy(config, () => 1).delay(1), 1200);
});
