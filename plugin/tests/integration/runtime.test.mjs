// End to end on the mini-shop stack (Docker): start + seed, a real login → cart → checkout flow captured by
// db-snapshot, the planted "served without a session" defect confirmed at runtime, db-reset back to the seed, stop.
// One file, sequential steps: the steps share one compose project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tempProject } from '../helpers.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { phpErrorLog, classifyPhpLog } from '../../lib/runtime.mjs';
import { counts, execSql } from '../../lib/db.mjs';
import { compose } from '../../lib/docker.mjs';
import { listWritableFiles, cleanupTestData } from '../../lib/cleanup.mjs';
import { runScenario } from '../../skills/run-perf/perf.mjs';
import { spawnSync } from 'node:child_process';
import { start, stop } from '../../skills/run-target-app/run.mjs';
import { resetDatabase } from '../../skills/db-reset/reset.mjs';
import { takeSnapshot, compare } from '../../skills/db-snapshot/snapshot.mjs';
import crypto from 'node:crypto';
import { containerFile } from '../../skills/run-mutation/mutate.mjs';
import { buildMutants, applyMutant } from '../../lib/mutation.mjs';

const skip = !dockerAvailable() && 'Docker engine not running';
const BASE = 'http://localhost:8090/';
let target;

before(() => {
  if (skip) return;
  const { root } = tempProject();
  target = loadTarget(root, 'mini-shop');
});

after(() => {
  if (target) stop(target);
});

// Every request on a socket of its own (node:http with agent: false), never a pooled one. The db and docker helpers
// block the event loop for seconds (spawnSync); past Apache's 5 s KeepAliveTimeout the server has closed an idle
// socket, but Node cannot retire it while blocked, so fetch's pool sent the next request on it: UND_ERR_SOCKET
// ("other side closed"). `connection: close` on fetch was not enough in a full run (the pool still handed one out).
function fresh(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : String(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(url, BASE), { method, agent: false, headers: { connection: 'close', ...(payload !== undefined ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const get = (name) => {
          const v = res.headers[name.toLowerCase()];
          return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
        };
        resolve({ status: res.statusCode, headers: { get }, text: async () => text });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A tiny cookie-keeping client: enough to drive a PHP session across requests. */
function client() {
  let cookie = '';
  return async (url, init = {}) => {
    const res = await fresh(url, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
}

test('mini-shop runtime: start, flow, snapshot diff, runtime defect, reset', { skip, timeout: 3_600_000 }, async (t) => {
  await t.test('start builds, seeds and answers', async () => {
    const r = await start(target, { timeoutMs: 180_000 });
    assert.equal(r.health.status, 200);
    assert.deepEqual(r.reset.mismatches, []);
    assert.deepEqual(r.reset.actual, { users: 2, products: 3, cart: 0, orders: 0 });
    const home = await (await fresh('')).text();
    assert.match(home, /Mug; large \(blue\)/, 'the page reads the seeded products through the shared socket');
  });

  await t.test('db-snapshot captures exactly what the purchase flow writes', async () => {
    takeSnapshot(target, 'before');
    const http = client();
    const login = await http('login.php', { method: 'POST', body: new URLSearchParams({ email: 'ann@example.test', password: 'secret' }) });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), 'index.php');
    const add = await http('cart.php?add=1');
    assert.equal(add.status, 302);
    const checkout = await http('checkout.php');
    assert.equal(checkout.status, 200);
    assert.match(await checkout.text(), /action="https:\/\/pay\.example\.test\/process"/);
    takeSnapshot(target, 'after');
    const d = compare(target, 'before', 'after');
    assert.deepEqual(Object.keys(d.tables), ['orders'], 'cart gets a row and loses it again; only orders changes net');
    assert.equal(d.tables.orders.added.length, 1);
    assert.deepEqual({ user_id: d.tables.orders.added[0].user_id, total: d.tables.orders.added[0].total }, { user_id: 1, total: 12 });
    assert.ok(fs.existsSync(path.join(target.dir, 'output', 'snapshots', 'before__after.diff.md')));
  });

  await t.test('the planted defect is real: admin/report.php sends a 302 but leaks the data in its body (no exit)', async () => {
    const res = await fresh('admin/report.php');
    assert.equal(res.status, 302, 'the 225 bytes of header HTML stay in the 4096-byte buffer, so the redirect is sent');
    assert.match(await res.text(), /Orders: 1 Revenue: 12/, 'the script ran on after the redirect: revenue is in the 302 body');
    const log = classifyPhpLog(phpErrorLog(target, 'web'));
    assert.ok(!log.warning.some((l) => /headers already sent/.test(l)), 'no headers-already-sent warning: this is the other variant');
    const guarded = await fresh('admin/products.php');
    assert.equal(guarded.status, 302, 'the guard that exits works');
    assert.doesNotMatch(await guarded.text(), /price|upload/i, 'and sends no page body');
  });

  await t.test('run-mutation: a defect goes into the container copy, the app behaves differently, and the file is put back exactly', async () => {
    const rel = 'admin/products.php';
    const original = fs.readFileSync(path.join(target.sourceDir, rel), 'utf8');
    const guardLine = original.split(/\r?\n/).findIndex((l) => l.includes('isset($_SESSION')) + 1;
    const [mutant] = buildMutants({ pages: [{ path: rel, includes: [], guards: [{ key: 'ADMIN', file: rel, line: guardLine }] }], sql: [] }, () => original);
    assert.equal(mutant.operator, 'guard-flip');
    assert.equal(mutant.na, undefined, 'the fixture guard is a session check the pattern knows');
    const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const file = containerFile(target, rel);
    assert.equal(file.hash(), hash(original), 'the container starts with the copy of the source');
    file.write(applyMutant(original, mutant));
    assert.equal((await fresh(rel)).status, 200, 'with the check turned around a visitor gets the admin page');
    file.write(original);
    assert.equal(file.hash(), hash(original), 'put back byte for byte');
    assert.equal((await fresh(rel)).status, 302, 'and the guard works again');
    assert.equal(fs.readFileSync(path.join(target.sourceDir, rel), 'utf8'), original, 'the source was never written');
  });

  await t.test('clean-up records the test data, removes only the files tests added, and restores the seed', () => {
    const before = listWritableFiles(target, 'web');
    compose(target, ['exec', '-T', 'web', 'sh', '-c', 'mkdir -p /var/www/html/uploads && echo x > /var/www/html/uploads/rqa-test-upload.png']);
    execSql(target, 'INSERT INTO products (name, price) VALUES (\'rqa test product\', 1);');
    const record = cleanupTestData(target, 'web', { filesBefore: before });
    assert.deepEqual(record.removed_files, ['/var/www/html/uploads/rqa-test-upload.png']);
    assert.deepEqual(record.leftover_rows, { orders: 1, products: 1 }, 'the purchase-flow order and the planted product, counted before clean-up');
    assert.deepEqual(record.reset.mismatches, []);
    assert.deepEqual(listWritableFiles(target, 'web'), before);
    assert.deepEqual(counts(target), { cart: 0, orders: 0, products: 3, users: 2 });
  });

  await t.test('run-perf: a 5-second k6 smoke on the public pages meets its thresholds and writes the summary', { skip: spawnSync('k6', ['version']).status !== 0 && 'k6 not installed' }, () => {
    const s = runScenario(target, 'smoke', ['index.php', 'login.php'], { duration: '5s' });
    assert.ok(s.requests >= 2, `${s.requests} requests`);
    assert.equal(s.error_rate_pct, 0);
    assert.equal(s.thresholds_passed, true, s.failed_thresholds.join('; '));
    assert.deepEqual(s.per_page.map((p) => p.page).sort(), ['index.php', 'login.php']);
  });

  await t.test('db-reset returns every table to the seed', () => {
    const r = resetDatabase(target);
    assert.deepEqual(r.mismatches, []);
    assert.deepEqual(counts(target), { cart: 0, orders: 0, products: 3, users: 2 });
  });
});
