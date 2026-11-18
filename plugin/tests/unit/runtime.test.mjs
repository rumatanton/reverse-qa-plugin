// Runtime helpers without Docker: host safety, health waiting, PHP log classification, snapshot diffs, count checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { assertSafeUrls, appVariant, healthUrl, waitForHttp, classifyPhpLog, classifyServerLog, logPatterns, serverLogPath, serverErrorLabel } from '../../lib/runtime.mjs';
import { roleForPage } from '../../lib/pages.mjs';
import { parseJsonLines, dbConfig } from '../../lib/db.mjs';
import { diffSnapshots, diffMarkdown, diffSummary, safeLabel } from '../../skills/db-snapshot/snapshot.mjs';
import { compareCounts } from '../../skills/db-reset/reset.mjs';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';

const DEF = {
  runtime: { base_url: 'http://localhost/app/', upgrade_base_url: 'http://localhost:8081/app/', health_path: 'index.php', services: { app: 'web', app_upgrade: 'web-php8', db: 'db' } },
  safety: { allowed_test_hosts: ['localhost', '127.0.0.1'], never_test: ['public.example.org'] },
};

test('assertSafeUrls allows listed hosts and refuses unlisted or never_test hosts', () => {
  assert.doesNotThrow(() => assertSafeUrls(DEF, ['http://localhost/app/', 'http://127.0.0.1:8081/']));
  assert.throws(() => assertSafeUrls(DEF, ['http://public.example.org/']), /never_test/);
  assert.throws(() => assertSafeUrls(DEF, ['https://pay.example.test/']), /not in safety.allowed_test_hosts/);
});

test('appVariant picks the default or the upgrade service, URL and profile', () => {
  assert.deepEqual(appVariant(DEF), { service: 'web', baseUrl: 'http://localhost/app/', profiles: [] });
  assert.deepEqual(appVariant(DEF, { upgrade: true }), { service: 'web-php8', baseUrl: 'http://localhost:8081/app/', profiles: ['php8'] });
  assert.throws(() => appVariant({ runtime: {} }, { upgrade: true }), /app_upgrade/);
  assert.equal(healthUrl(DEF, DEF.runtime.base_url), 'http://localhost/app/index.php');
});

test('waitForHttp keeps polling through errors until the expected status, and times out with the last error', async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    res.writeHead(n < 3 ? 503 : 200);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const ok = await waitForHttp(url, { intervalMs: 20, timeoutMs: 5000 });
    assert.equal(ok.status, 200);
    assert.equal(ok.attempts, 3);
    await assert.rejects(waitForHttp(url, { intervalMs: 20, timeoutMs: 150, expect: [418] }), /not healthy after 150 ms .*last: HTTP 200/);
  } finally {
    server.close();
  }
  await assert.rejects(waitForHttp('http://127.0.0.1:9/', { intervalMs: 20, timeoutMs: 120 }), /not healthy/);
});

test('classifyPhpLog sorts lines by severity', () => {
  const log = ['[x] PHP Warning:  Cannot modify header information', '[x] PHP Fatal error:  Uncaught Error', '[x] PHP Notice:  Undefined index: a', '[x] PHP Deprecated:  x', 'stray'].join('\n');
  const c = classifyPhpLog(log);
  assert.deepEqual([c.fatal.length, c.warning.length, c.notice.length, c.deprecated.length, c.other.length], [1, 1, 1, 1, 1]);
});

test('server log, any stack: the log path, the patterns per stack, target overrides, and the same PHP result as before', () => {
  const php = { source: { stack: 'php' }, runtime: { compose_file: 'c.yml' } };
  const java = { source: { stack: 'java-spring' }, runtime: { compose_file: 'c.yml', error_log: '/app/logs/app.log' } };
  assert.equal(serverLogPath(php), '/var/log/php/error.log', 'the PHP runtime template logs there without being told');
  assert.equal(serverLogPath({ source: { stack: 'php' }, runtime: { compose_file: 'c.yml', php_error_log: '/x.log' } }), '/x.log', 'the older setting name still works');
  assert.equal(serverLogPath(java), '/app/logs/app.log');
  assert.equal(serverLogPath({ source: { stack: 'java-spring' }, runtime: { compose_file: 'c.yml' } }), null, 'no log configured: none is watched');
  assert.equal(serverLogPath({ source: { stack: 'php' }, runtime: { base_url: 'http://x/' } }), null, 'an app reached by URL has no log the plugin can read');

  const phpLog = ['[x] PHP Warning:  Cannot modify header information', '[x] PHP Fatal error:  Uncaught Error', '[x] PHP Notice:  Undefined index: a', '[x] PHP Deprecated:  x', 'stray'].join('\n');
  assert.deepEqual(classifyServerLog(phpLog, logPatterns(php)), classifyPhpLog(phpLog), 'PHP targets classify exactly as before');
  assert.equal(serverErrorLabel(php), 'PHP fatal error');

  const javaLog = [
    '2026-11-10 10:00:01.123  INFO 1 --- [main] c.e.ShopApplication : Started ShopApplication',
    '2026-11-10 10:00:05.001  WARN 1 --- [nio-8080-exec-1] o.h.e.j.s.SqlExceptionHelper : SQL Warning Code: 0',
    '2026-11-10 10:00:06.777 ERROR 1 --- [nio-8080-exec-2] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() threw exception',
    'java.lang.NullPointerException: Cannot invoke "Order.getId()" because "order" is null',
    '\tat com.example.shop.OrderController.one(OrderController.java:42)',
    'Traceback (most recent call last):',
    'This method is deprecated and will be removed',
  ].join('\n');
  const c = classifyServerLog(javaLog, logPatterns(java));
  assert.deepEqual([c.fatal.length, c.warning.length, c.deprecated.length, c.other.length], [3, 1, 1, 2]);
  assert.match(c.fatal[1], /NullPointerException/);
  assert.equal(serverErrorLabel(java), 'Server error');
  assert.deepEqual(classifyServerLog(logPatterns(java).sample.warning, logPatterns(java)).warning.length, 1, 'the self-test sample line is a warning in its own format');
  assert.deepEqual(classifyServerLog(logPatterns(php).sample.warning, logPatterns(php)).warning.length, 1);

  const custom = { ...java, runtime: { ...java.runtime, error_patterns: { fatal: ['level=error', 'OOMKilled'] } } };
  const k = classifyServerLog('ts=1 level=error msg="db down"\n2026 ERROR not matched by the override\nts=2 level=info', logPatterns(custom));
  assert.deepEqual([k.fatal.length, k.other.length], [1, 2], 'runtime.error_patterns replaces a class');
});

test('roleForPage with no role matrix: what the crawl saw, then what the API spec declares, then the code facts', () => {
  const base = { path: 'x', guards: [], redirects: [], sources: ['crawl'] };
  assert.equal(roleForPage({ ...base, reachable_by: ['Admin', 'Customer'] }, null), 'Customer', 'the first role that opened it');
  assert.equal(roleForPage({ ...base, reachable_by: ['Admin', 'Visitor'] }, null), 'Visitor');
  assert.equal(roleForPage({ ...base, sources: ['openapi'] }, null), 'Visitor', 'a spec endpoint that asks for no credentials');
  assert.equal(roleForPage({ ...base, sources: ['openapi'], guards: [{ key: 'bearerAuth', file: 'openapi.yaml', line: 9 }] }, null), null, 'secured in the spec: the role matrix must say for whom');
  assert.equal(roleForPage({ ...base, sources: ['openapi'], guards: [{ key: 'bearerAuth' }] }, [{ page: 'x', role: 'Admin', expected: 'allowed' }]), 'Admin', 'the matrix wins when it exists');
  assert.equal(roleForPage({ path: 'index.php', guards: [], redirects: [], sources: ['pack'] }, null), 'Visitor', 'a parsed page keeps the code-fact rule');
});

test('parseJsonLines keeps NULLs, tabs and newlines intact', () => {
  assert.deepEqual(parseJsonLines('{"a":null,"b":"x\\ty\\nz"}\n{"a":1,"b":""}\n\n'), [{ a: null, b: 'x\ty\nz' }, { a: 1, b: '' }]);
});

test('dbConfig reads the password from the variable named by database.password_env', () => {
  const t = { def: { database: { name: 'd', user: 'u', password_env: 'RQA_TEST_DB_PW' }, runtime: { services: { db: 'mysql' } } }, env: { RQA_TEST_DB_PW: 'from-dotenv' } };
  assert.deepEqual(dbConfig(t), { service: 'mysql', name: 'd', user: 'u', password: 'from-dotenv' });
});

const snap = (label, tables) => ({ label, tables });
test('diffSnapshots finds added, removed and changed rows by primary key', () => {
  const a = snap('before', {
    cart: { count: 1, primaryKey: ['id'], rows: [{ id: 1, qty: 1 }] },
    orders: { count: 0, primaryKey: ['id'], rows: [] },
    users: { count: 1, primaryKey: ['id'], rows: [{ id: 1, name: 'ann' }] },
  });
  const b = snap('after', {
    cart: { count: 0, primaryKey: ['id'], rows: [] },
    orders: { count: 1, primaryKey: ['id'], rows: [{ id: 7, total: 12 }] },
    users: { count: 1, primaryKey: ['id'], rows: [{ id: 1, name: 'ann b' }] },
  });
  const d = diffSnapshots(a, b);
  assert.deepEqual(Object.keys(d.tables), ['cart', 'orders', 'users']);
  assert.deepEqual(d.tables.cart.removed, [{ id: 1, qty: 1 }]);
  assert.deepEqual(d.tables.orders.added, [{ id: 7, total: 12 }]);
  assert.deepEqual(d.tables.users.changed, [{ key: { id: 1 }, changes: { name: ['ann', 'ann b'] } }]);
  assert.equal(diffSummary(d), 'db-snapshot: before → after: cart -1, orders +1, users ~1');
  assert.match(diffMarkdown(d), /## orders \(0 → 1 rows\)\n\n- added: `\{"id":7,"total":12\}`/);
});

test('diffSnapshots handles tables without a primary key as multisets, and unchanged tables are left out', () => {
  const a = snap('a', { log: { count: 2, primaryKey: [], rows: [{ m: 'x' }, { m: 'x' }] }, same: { count: 1, primaryKey: ['id'], rows: [{ id: 1 }] } });
  const b = snap('b', { log: { count: 3, primaryKey: [], rows: [{ m: 'x' }, { m: 'x' }, { m: 'x' }] }, same: { count: 1, primaryKey: ['id'], rows: [{ id: 1 }] } });
  const d = diffSnapshots(a, b);
  assert.deepEqual(Object.keys(d.tables), ['log']);
  assert.deepEqual(d.tables.log.added, [{ m: 'x' }]);
  assert.equal(diffMarkdown(diffSnapshots(a, a)).includes('No table changed.'), true);
});

test('safeLabel rejects path tricks', () => {
  assert.equal(safeLabel('before-login.1'), 'before-login.1');
  for (const bad of ['../x', 'a/b', '', '.hidden', 'x y']) assert.throws(() => safeLabel(bad));
});

test('compareCounts reports every table whose live count differs, including missing tables', () => {
  assert.deepEqual(compareCounts({ a: 1, b: 2, c: 0 }, { a: 1, b: 3 }), [
    { table: 'b', expected: 2, actual: 3 },
    { table: 'c', expected: 0, actual: null },
  ]);
});

test('run-target-app refuses a base_url outside allowed_test_hosts before touching Docker', () => {
  const { root, target } = tempProject();
  const yml = path.join(target, 'target.yaml');
  fs.writeFileSync(yml, fs.readFileSync(yml, 'utf8').replace('http://localhost:8090/', 'http://pay.example.test/'));
  const r = runNode(path.join(PLUGIN, 'skills', 'run-target-app', 'run.mjs'), ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing http:\/\/pay\.example\.test\/: pay\.example\.test is listed in safety\.never_test/);
});

test('the runtime CLIs print usage and exit 1 without a target', () => {
  for (const s of ['run-target-app/run.mjs', 'db-reset/reset.mjs', 'db-snapshot/snapshot.mjs']) {
    assert.equal(runNode(path.join(PLUGIN, 'skills', s), []).status, 1, s);
  }
});
