// End to end on an app that is not PHP and has no pages: the mini-api fixture (a Node JSON API with an OpenAPI spec).
// From a source folder to a passing test run, with no file written by hand except what a person must state (accounts,
// the role matrix): init-target → scan-repo (generic pack + API spec) → scaffold-framework (API driver, no browser) →
// run-suites. Opt-in (RQA_E2E=1) because scaffold-framework installs npm packages: `npm run test:e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PLUGIN, runNode } from '../helpers.mjs';
import { waitForHttp } from '../../lib/runtime.mjs';
import { flatten } from '../../lib/pwreport.mjs';

const MINI_API = path.join(PLUGIN, 'tests', 'fixtures', 'mini-api');
const skill = (name, file) => path.join(PLUGIN, 'skills', name, file);
const PORT = 8095;
const BASE = `http://127.0.0.1:${PORT}/`;

const MATRIX = [
  ['health', 'allowed', 'allowed', 'allowed'],
  ['products', 'allowed', 'allowed', 'allowed'],
  ['products/{id}', 'allowed', 'allowed', 'allowed'],
  ['orders', 'denied', 'allowed', 'allowed'],
  ['orders/{id}', 'denied', 'allowed', 'allowed'],
  ['admin/report', 'denied', 'denied', 'allowed'],
];

test('mini-api: init, scan, scaffold the API driver, run every tier it has', { skip: process.env.RQA_E2E !== '1' && 'opt-in: RQA_E2E=1 (installs npm packages)', timeout: 900_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-e2e-api-'));
  const server = spawn(process.execPath, [path.join(MINI_API, 'server.mjs')], { env: { ...process.env, PORT: String(PORT), MINI_API_TEST: '1' }, stdio: 'ignore' });
  try {
    await waitForHttp(`${BASE}health`, { timeoutMs: 15_000, intervalMs: 200 });

    // 1. a new app: detected as an API from its spec
    const init = runNode(skill('init-target', 'init.mjs'), ['--name', 'mini-api', '--source', MINI_API, '--url', BASE, '--root', root]);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /a api app/);
    assert.match(init.stdout, /yes {2}Automated tests \(HTTP tests: endpoints, authorization, security/);

    // 2. what only a person can state: the health path, the test accounts (a token login) and their credentials
    const dir = path.join(root, 'targets', 'mini-api');
    const yaml = path.join(dir, 'target.yaml');
    const login = '{ path: login, json: { email: "{user}", password: "{password}" }, token: token }';
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8')
      .replace(`  base_url: ${BASE}\n`, `  base_url: ${BASE}\n  health_path: health\n`)
      .replace('test_accounts: {}', `test_accounts:\n  customer: { role: Customer, user_env: CUSTOMER_EMAIL, password_env: CUSTOMER_PASSWORD, login: ${login} }\n  admin: { role: Admin, user_env: ADMIN_EMAIL, password_env: ADMIN_PASSWORD, login: ${login} }\n#`));
    fs.appendFileSync(path.join(dir, '.env'), 'CUSTOMER_EMAIL=ann@example.test\nCUSTOMER_PASSWORD=demo-pass-1\nADMIN_EMAIL=admin@example.test\nADMIN_PASSWORD=demo-pass-3\n');
    const doctor = runNode(skill('init-target', 'init.mjs'), ['--doctor', '--target', 'mini-api', '--root', root]);
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /PASS {2}the app answers at the base URL: HTTP 404/, 'an API with nothing at its root is still up');

    // 3. the inventory: the source by the generic pack, the endpoints from the spec
    const scan = runNode(skill('scan-repo', 'scan.mjs'), ['--target', 'mini-api', '--root', root]);
    assert.equal(scan.status, 0, scan.stderr);
    assert.match(scan.stdout, /7 pages: 7 from the API spec/);
    assert.match(scan.stdout, /10 route hints \(2 matched no page\)/);

    // 4. the role matrix (the workflow-analyst's output in a real run)
    fs.writeFileSync(path.join(dir, 'output', 'role-matrix.csv'), `page,role,expected,evidence\n${MATRIX.flatMap(([page, v, c, a]) => [['Visitor', v], ['Customer', c], ['Admin', a]].map(([role, e]) => `${page},${role},${e},server.mjs:1`)).join('\n')}\n`);

    // 5. the API driver: no browser tiers copied, no browsers installed
    const scaffold = runNode(skill('scaffold-framework', 'scaffold.mjs'), ['--target', 'mini-api', '--root', root, '--no-agents']);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    assert.match(scaffold.stdout, /dependencies installed \(an API target needs no browser\)/);
    for (const f of ['tests/api/endpoints.spec.ts', 'tests/t3-roles/authz/matrix.spec.ts', 'support/fixtures.ts']) assert.ok(fs.existsSync(path.join(dir, 'framework', f)), f);
    for (const f of ['tests/a11y', 'tests/visual', 'tests/t0-smoke', 'crawl']) assert.ok(!fs.existsSync(path.join(dir, 'framework', f)), `${f} is a browser tier`);

    // 6. every tier an API has
    const run = runNode(skill('run-suites', 'run.mjs'), ['--target', 'mini-api', '--root', root, '--tier', 'all']);
    assert.equal(run.status, 0, run.stdout.split('\n').filter((l) => l.startsWith('run-suites')).join('\n') + run.stderr);
    const lines = Object.fromEntries(run.stdout.split('\n').filter((l) => /^run-suites: \w+: exit/.test(l)).map((l) => [l.match(/^run-suites: (\w+)/)[1], l]));
    assert.deepEqual(Object.keys(lines), ['unit', 'selftest', 'full'], 'no smoke, other-browser or visual step');
    for (const l of Object.values(lines)) assert.match(l, /exit 0 .*0 failed, 0 known-defect, 0 fixed-defect, 0 flaky, 0 skipped/);
    assert.match(lines.full, /not cleaned: no database the plugin can reach, so rows the tests added stay in the app/, 'the run says what it could not clean');

    const report = JSON.parse(fs.readFileSync(path.join(dir, 'framework', 'test-results', 'report.json'), 'utf8'));
    const titles = flatten(report).map((r) => r.title.split(' @')[0]).sort();
    const expected = [
      'every endpoint with a path parameter has a value to call it with',
      ...['admin/report as Admin', 'health as Visitor', 'orders as Customer', 'orders/{id} as Customer', 'products as Visitor', 'products/{id} as Visitor'].map((t) => `GET ${t}`),
      'POST orders with an empty form as Customer',
      ...MATRIX.flatMap(([page, v, c, a]) => [`${page} as Visitor → ${v}`, `${page} as Customer → ${c}`, `${page} as Admin → ${a}`]),
    ].sort();
    assert.deepEqual(titles, expected, 'exactly the tests the inventory and the role matrix call for');
  } finally {
    server.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
