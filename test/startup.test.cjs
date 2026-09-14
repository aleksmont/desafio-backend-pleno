const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { tempDatabase } = require('./helpers.cjs');

function launch(t, env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const ended = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await ended;
    }
  });
  return { child, ended, output: () => output };
}

test('invalid startup configuration exits with the setting name', { timeout: 5000 }, async (t) => {
  const process = launch(t, { PORT: 'invalid', DATABASE_PATH: tempDatabase(t) });
  assert.equal((await process.ended)[0], 1);
  assert.match(process.output(), /Invalid configuration: PORT/);
});

test('occupied port closes the worker and exits without hanging', { timeout: 5000 }, async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const process = launch(t, {
    PORT: String(server.address().port),
    DATABASE_PATH: tempDatabase(t),
  });
  assert.equal((await process.ended)[0], 1);
  assert.match(process.output(), /EADDRINUSE/);
});

test(
  'application starts through its real entrypoint and handles SIGTERM',
  { timeout: 5000 },
  async (t) => {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const process = launch(t, { PORT: String(port), DATABASE_PATH: tempDatabase(t) });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ready, true, process.output());
    process.child.kill('SIGTERM');
    const [code, signal] = await process.ended;
    assert.ok(code === 0 || signal === 'SIGTERM');
  },
);
