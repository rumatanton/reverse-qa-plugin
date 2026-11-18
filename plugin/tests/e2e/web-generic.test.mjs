// End to end on a web app the tool has no parser for: the mini-shop fixture with `source.stack: unknown`, so the
// generic pack reads the source and every page has to come from a crawl of the running app. start → scan (no pages
// yet) → scaffold → crawl-app → scan (pages from the crawl) → the smoke tier on those pages.
// Opt-in (RQA_E2E=1): it builds and starts containers and installs npm packages. `npm run test:e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { start, stop } from '../../skills/run-target-app/run.mjs';

const skill = (name, file) => path.join(PLUGIN, 'skills', name, file);
const skip = process.env.RQA_E2E !== '1' ? 'opt-in: RQA_E2E=1 (containers and npm packages)' : !dockerAvailable() ? 'Docker engine not running' : false;

test('a web app with no parser: pages come from the crawl, and the smoke tier runs on them', { skip, timeout: 2_400_000 }, async () => {
  const { root, target: dir } = tempProject();
  // what a person states: the stack is not one the tool parses, where the server log is, and one test account
  const yaml = path.join(dir, 'target.yaml');
  fs.writeFileSync(yaml, `${fs.readFileSync(yaml, 'utf8')
    .replace('  stack: php\n', '  stack: unknown\n')
    .replace('  health_path: index.php\n', '  health_path: index.php\n  error_log: /var/log/php/error.log\n')}app:
  kind: web
test_accounts:
  customer: { role: Customer, user_env: CUSTOMER_EMAIL, password_env: CUSTOMER_PASSWORD, login: { path: login.php, user_field: email, password_field: password } }
`);
  fs.appendFileSync(path.join(dir, '.env'), 'CUSTOMER_EMAIL=ann@example.test\nCUSTOMER_PASSWORD=secret\n');
  const args = ['--target', 'mini-shop', '--root', root];
  const target = loadTarget(root, 'mini-shop');
  assert.equal(target.def.source.stack, 'unknown');
  try {
    const up = await start(target, { timeoutMs: 300_000 });
    assert.equal(up.health.status, 200);

    // 1. the source alone: facts in any language, and no pages
    const first = runNode(skill('scan-repo', 'scan.mjs'), args);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\(0 pages, 0 includes, 0 parse errors\)/);
    assert.match(first.stdout, /outbound hosts \[pay\.example\.test\]/, 'the payment host is found in the source without a parser');
    assert.match(first.stdout, /no pages yet\. The generic pack does not read pages from source: run crawl-app/);
    const inv1 = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'inventory.json'), 'utf8'));
    assert.equal(inv1.pack.name, 'generic');
    assert.ok(inv1.sql.some((s) => s.verb === 'INSERT' && s.writes.includes('orders')), 'SQL in PHP string literals is found by the generic pack');

    // 2. the framework, then the crawl
    const scaffold = runNode(skill('scaffold-framework', 'scaffold.mjs'), [...args, '--no-agents']);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    const crawl = runNode(skill('crawl-app', 'crawl.mjs'), args);
    assert.equal(crawl.status, 0, crawl.stdout.split('\n').filter((l) => /crawl-app|Error|failed/.test(l)).join('\n') + crawl.stderr);
    assert.match(crawl.stdout, /crawl-app: 4 page\(s\)/);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'scan', 'crawl.json'), 'utf8'));
    assert.deepEqual(record.roles, ['Visitor', 'Customer']);
    assert.deepEqual([...new Set(Object.values(record.pages).map((p) => p.path))].sort(), ['cart.php', 'checkout.php', 'index.php', 'login.php'], 'the two admin pages have no link to them: a crawl cannot see a page nobody links to');
    const cart = Object.values(record.pages).find((p) => p.path === 'cart.php');
    assert.deepEqual([cart.roles.Visitor.outcome, cart.roles.Customer.outcome, cart.roles.Customer.landed_on], ['redirect-login', 'redirect', 'checkout.php']);

    // 3. the inventory now has pages, each with what the roles got
    const second = runNode(skill('scan-repo', 'scan.mjs'), args);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /\(4 pages: 4 from the crawl, 0 includes/);
    const inv2 = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'inventory.json'), 'utf8'));
    const by = Object.fromEntries(inv2.pages.map((p) => [p.path, p]));
    assert.deepEqual(by['checkout.php'].reachable_by, ['Customer']);
    assert.deepEqual(by['cart.php'].reachable_by, ['Customer'], 'add to cart moves the customer on to checkout: the customer may use it');
    assert.deepEqual([by['cart.php'].seen_query, by['cart.php'].example_query], ['add=1', undefined], 'the query the crawl saw is information, not test input');
    assert.deepEqual(by['index.php'].reachable_by, ['Visitor', 'Customer']);

    // 4. the smoke tier runs on the crawl's pages, each as a role the crawl saw open it
    const smoke = runNode(skill('run-suites', 'run.mjs'), [...args, '--tier', 'smoke']);
    const line = smoke.stdout.split('\n').find((l) => l.startsWith('run-suites: smoke:')) ?? '';
    assert.equal(smoke.status, 0, line + smoke.stderr);
    assert.match(line, /exit 0 .*\(5 passed, 0 failed, 0 known-defect, 0 fixed-defect, 0 flaky, 0 skipped\)/);
    assert.match(line, /cleaned up \d+ test row\(s\) and 0 file\(s\); seed restored/);
    for (const t of ['index.php loads for Visitor', 'login.php loads for Visitor', 'cart.php loads for Customer', 'checkout.php loads for Customer']) assert.ok(smoke.stdout.includes(t), t);
  } finally {
    stop(target);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
