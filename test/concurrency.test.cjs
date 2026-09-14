const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { tempDatabase, setup, payload } = require('./helpers.cjs');

test('independent workers racing on the same SQLite database insert and claim once', async (t) => {
  const filename = tempDatabase(t);
  const context = setup(t, { database: filename });
  const barrier = new SharedArrayBuffer(4);
  const workers = [];
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  const script = `
    const {parentPort,workerData}=require('node:worker_threads');
    const {Database}=require(workerData.root+'/dist/database/database');
    const {OrdersRepository}=require(workerData.root+'/dist/orders/orders.repository');
    const {loadConfig}=require(workerData.root+'/dist/config');
    const config={...loadConfig({}),database:workerData.filename};
    const db=new Database(config);
    const repo=new OrdersRepository(db,config,{now:()=>workerData.now});
    parentPort.postMessage({ready:true});
    Atomics.wait(new Int32Array(workerData.barrier),0,0);
    const received=repo.receive(workerData.payload);
    const job=repo.claim();
    parentPort.postMessage({id:received.order.id,duplicate:received.duplicate,claimed:job?.id});
    db.beforeApplicationShutdown();
  `;
  const promises = Array.from(
    { length: 4 },
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(script, {
          eval: true,
          workerData: {
            root: process.cwd(),
            filename,
            barrier,
            payload: payload(),
            now: context.clock.now(),
          },
        });
        workers.push(worker);
        worker.on('error', reject);
        let finished = false;
        worker.on('message', (message) => {
          if (message.ready) {
            worker.ready = true;
            if (workers.length === 4 && workers.every((w) => w.ready)) {
              Atomics.store(new Int32Array(barrier), 0, 1);
              Atomics.notify(new Int32Array(barrier), 0);
            }
          } else {
            finished = true;
            resolve(message);
          }
        });
        worker.on('exit', (code) => {
          if (!finished) reject(new Error('Worker exited without a result: ' + code));
        });
      }),
  );
  const results = await Promise.all(promises);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(results.filter((r) => r.claimed).length, 1);
  assert.equal(context.repository.metrics().total, 1);
});
