const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
test('HTTP validation, durable queue, idempotency, retries, DLQ and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(),'orders-test-'));
  let calls = 0;
  const external = createServer((req,res) => {
    calls++;
    const base = new URL(req.url,'http://localhost').searchParams.get('base');
    if (base === 'GBP' || (base === 'EUR' && calls === 2)) { res.writeHead(503); res.end(); }
    else { res.setHeader('content-type','application/json'); res.end(JSON.stringify({rates:{BRL:5},date:'2026-09-14'})); }
  });
  await new Promise(resolve => external.listen(0,'127.0.0.1',resolve));
  Object.assign(process.env,{DATABASE_PATH:join(dir,'orders.sqlite'), EXCHANGE_API_URL:`http://127.0.0.1:${external.address().port}/rates`, POLL_MS:'10', RETRY_BASE_MS:'20', HTTP_TIMEOUT_MS:'500'});
  const {createApp} = require('../dist/main');
  let app;
  try {
    app = await createApp(); await app.listen(0,'127.0.0.1');
    let base = await app.getUrl();
    const request = async (path,body) => {
      const response = await fetch(base+path, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json()};
    };
    const payload = (key,currency='USD') => ({order_id:key,idempotency_key:key,customer:{email:'user@example.com',name:'Ana'},items:[{sku:'ABC',qty:2,unit_price:59.9}],currency});
    async function waitFor(id,status) {
      const deadline = Date.now()+5000;
      while (Date.now()<deadline) {
        const response = await request('/orders/'+id);
        if (response.body.status===status) return response.body;
        await new Promise(resolve=>setTimeout(resolve,15));
      }
      throw new Error('Timed out waiting for '+status);
    }
    assert.equal((await request('/webhooks/orders',{})).status,400);
    assert.equal((await request('/webhooks/orders',{...payload('bad'),items:[{sku:'A',qty:-1,unit_price:2}]})).status,400);
    const results = await Promise.all(Array.from({length:8},()=>request('/webhooks/orders',payload('one'))));
    assert.ok(results.every(r=>r.status===202));
    assert.equal(new Set(results.map(r=>r.body.id)).size,1);
    assert.equal(results.filter(r=>!r.body.duplicate).length,1);
    const id = results[0].body.id;
    const done = await waitFor(id,'COMPLETED');
    assert.equal(done.enrichment.converted_total,599);
    assert.equal(done.total,119.8); assert.equal(calls,1);
    assert.equal((await request('/webhooks/orders',{...payload('one'),currency:'EUR'})).status,409);
    const retry = await request('/webhooks/orders',payload('retry','EUR'));
    assert.equal((await waitFor(retry.body.id,'COMPLETED')).attempts,2);
    const fail = await request('/webhooks/orders',payload('fail','GBP'));
    const failed = await waitFor(fail.body.id,'FAILED_ENRICHMENT');
    assert.equal(failed.attempts,3); assert.equal(failed.queue_state,'DLQ');
    assert.equal((await request('/orders?status=FAILED_ENRICHMENT')).body.length,1);
    assert.equal((await request('/orders?status=invalid')).status,400);
    assert.equal((await request('/orders/missing')).status,404);
    assert.deepEqual((await request('/queue/metrics')).body.counts,{WAITING:0,ACTIVE:0,RETRY:0,COMPLETED:2,DLQ:1});
    await app.close(); app = undefined;
    // Simulate a process dying after claiming a persisted job.
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(process.env.DATABASE_PATH);
    db.prepare("UPDATE orders SET status='PROCESSING', job_state='ACTIVE', attempts=1, lease_until=0 WHERE id=?").run(id);
    db.close();
    app = await createApp(); await app.listen(0,'127.0.0.1'); base = await app.getUrl();
    assert.equal((await waitFor(id,'COMPLETED')).attempts,2);
    assert.equal((await request('/webhooks/orders',payload('one'))).body.duplicate,true);
    assert.equal((await request('/queue/metrics')).body.total,3);
  } finally {
    if(app) await app.close();
    await new Promise(resolve=>external.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
