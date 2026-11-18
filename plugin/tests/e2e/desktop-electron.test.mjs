// End to end on a desktop app: the mini-desktop fixture (an Electron notes app, no server and no browser). From a
// source folder to passing tiers, with nothing written by hand except what a person must state (two test accounts,
// the host tests must never reach): init-target → scan-repo (generic pack) → scaffold-framework (the desktop driver,
// no browsers installed) → self-tests → crawl-app → scan-repo → the smoke tier → the full tier.
// Opt-in (RQA_E2E=1): it installs npm packages, Electron among them, and starts the app about 40 times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, runNode } from '../helpers.mjs';

const MINI_DESKTOP = path.join(PLUGIN, 'tests', 'fixtures', 'mini-desktop');
const skill = (name, file) => path.join(PLUGIN, 'skills', name, file);
const login = '{ path: login.html, user_field: email, password_field: password }';

test('a desktop app: init, scan, scaffold the desktop driver, self-tests, crawl, smoke and the full tier', { skip: process.env.RQA_E2E !== '1' && 'opt-in: RQA_E2E=1 (installs npm packages and Electron)', timeout: 2_400_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-e2e-desktop-'));
  const source = path.join(root, 'src', 'mini-desktop');
  const dir = path.join(root, 'targets', 'mini-desktop');
  const args = ['--target', 'mini-desktop', '--root', root];
  const tier = (name) => {
    const r = runNode(skill('run-suites', 'run.mjs'), [...args, '--tier', name]);
    const line = r.stdout.split('\n').find((l) => l.startsWith(`run-suites: ${name}:`)) ?? '';
    return { status: r.status, line, out: r.stdout + r.stderr };
  };
  try {
    fs.cpSync(MINI_DESKTOP, source, { recursive: true });
    const npm = spawnSync('npm install --no-audit --no-fund', { cwd: source, shell: true, encoding: 'utf8' });
    assert.equal(npm.status, 0, npm.stderr);

    // 1. onboarding: the app is recognised, and target.yaml names the driver and the page the app opens first
    const init = runNode(skill('init-target', 'init.mjs'), ['--name', 'mini-desktop', '--source', source, '--root', root]);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Electron \(package\.json\); a desktop app/);
    assert.match(init.stdout, /yes {2}Automated tests \(the app is started and driven through its own windows/);
    const yaml = path.join(dir, 'target.yaml');
    let text = fs.readFileSync(yaml, 'utf8');
    assert.match(text, /^ {2}driver: electron/m);
    assert.match(text, /^ {4}start_page: renderer\/index\.html/m);
    // what a person states: two test accounts, and the update host no test may reach
    text = text
      .replace(/^test_accounts: \{\}.*$/m, `test_accounts:\n  customer: { role: Customer, user_env: CUSTOMER_EMAIL, password_env: CUSTOMER_PASSWORD, login: ${login} }\n  admin: { role: Admin, user_env: ADMIN_EMAIL, password_env: ADMIN_PASSWORD, login: ${login} }`)
      .replace(/^ {2}never_test: \[\].*$/m, '  never_test: [updates.example.test]');
    fs.writeFileSync(yaml, text);
    fs.appendFileSync(path.join(dir, '.env'), 'CUSTOMER_EMAIL=ann@example.test\nCUSTOMER_PASSWORD=ann-demo-pass\nADMIN_EMAIL=admin@example.test\nADMIN_PASSWORD=admin-demo-pass\n');

    // 2. the source alone: the update host is found without a parser, and there are no pages yet
    const first = runNode(skill('scan-repo', 'scan.mjs'), args);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\(0 pages, 0 includes, 0 parse errors\)/);
    assert.match(first.stdout, /outbound hosts \[updates\.example\.test\]/);

    // 3. the framework: the tiers that open the app's windows, and no browser installed
    const scaffold = runNode(skill('scaffold-framework', 'scaffold.mjs'), [...args, '--no-agents']);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    assert.match(scaffold.stdout, /a desktop app is started itself: no browser needed/);
    const fw = path.join(dir, 'framework');
    assert.ok(fs.existsSync(path.join(fw, 'support', 'desktop.ts')));
    for (const gone of ['tests/api', 'tests/t3-roles', 'tests/visual']) assert.ok(!fs.existsSync(path.join(fw, gone)), `${gone} is not for a desktop app`);
    const doctor = runNode(skill('init-target', 'init.mjs'), ['--doctor', ...args]);
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout, /PASS {2}the app's start page exists/);
    assert.match(doctor.stdout, /PASS {2}Electron is installed in the source folder/);

    // 4. the driver proves itself: the app starts at its start page, each copy has its own data folder, both roles get
    //    in through the login screen, and the update host is blocked and recorded
    const self = tier('selftest');
    assert.equal(self.status, 0, self.out.slice(-3000));
    assert.match(self.line, /\(6 passed, 0 failed, 0 known-defect, 0 fixed-defect, 0 flaky, 0 skipped\)/);

    // 5. the crawl walks the app as each role, and leaves the links that sign out or delete alone
    const crawl = runNode(skill('crawl-app', 'crawl.mjs'), args);
    assert.equal(crawl.status, 0, crawl.stdout.split('\n').filter((l) => /crawl-app|Error|failed/.test(l)).join('\n') + crawl.stderr);
    assert.match(crawl.stdout, /crawl-app: 6 page\(s\), 2 form\(s\)/);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'scan', 'crawl.json'), 'utf8'));
    assert.deepEqual(record.roles, ['Visitor', 'Customer', 'Admin']);
    assert.deepEqual(Object.values(record.pages).map((p) => p.path).sort(), ['about.html', 'admin.html', 'export.html', 'index.html', 'login.html', 'notes.html']);
    const got = (page, role) => Object.values(record.pages).find((p) => p.path === page).roles[role].outcome;
    assert.deepEqual([got('notes.html', 'Visitor'), got('notes.html', 'Customer'), got('admin.html', 'Customer'), got('admin.html', 'Admin')], ['redirect-login', 'allowed', 'redirect-login', 'allowed']);
    assert.deepEqual([got('export.html', 'Visitor'), got('export.html', 'Customer')], ['allowed', 'allowed'], 'the planted defect: the export screen has no guard, and the crawl records that anyone gets it');
    assert.deepEqual(record.skipped.map((s) => s.href.split('/').pop()).sort(), ['clear.html', 'logout.html'], 'the links that delete every note and that sign out are left alone');

    // 6. the inventory now has the app's screens, each with the roles that may use it
    const second = runNode(skill('scan-repo', 'scan.mjs'), args);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /\(6 pages: 6 from the crawl, 0 includes/);
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, 'output', 'inventory.json'), 'utf8')).pages.map((p) => [p.path, p]));
    assert.deepEqual(by['admin.html'].reachable_by, ['Admin']);
    assert.deepEqual(by['notes.html'].reachable_by, ['Customer', 'Admin']);

    // 7. smoke: every screen opens for a role that may use it; each test started its own copy of the app
    const smoke = tier('smoke');
    assert.equal(smoke.status, 0, smoke.out.slice(-3000));
    assert.match(smoke.line, /exit 0 .*\(7 passed, 0 failed, 0 known-defect, 0 fixed-defect, 0 flaky, 0 skipped\)/);
    assert.match(smoke.line, /each test started the app with a data folder of its own/);
    for (const t of ['index.html loads for Visitor', 'notes.html loads for Customer', 'admin.html loads for Admin']) assert.ok(smoke.out.includes(t), t);

    // 8. accessibility: the baseline is recorded from the app's own windows (the planted image with no text), then
    //    the full tier (smoke and accessibility) passes against it
    const base = spawnSync('npx playwright test --project=desktop --grep @a11y', { cwd: fw, shell: true, encoding: 'utf8', env: { ...process.env, A11Y_UPDATE: '1', RQA_REPORT: 'baseline-a11y' } });
    assert.equal(base.status, 0, (base.stdout + base.stderr).slice(-3000));
    const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'a11y', 'baseline.json'), 'utf8'));
    assert.deepEqual(baseline['about.html'], { 'image-alt': 1 });
    assert.deepEqual(baseline['index.html'], {});
    const full = tier('full');
    assert.equal(full.status, 0, full.out.slice(-3000));
    assert.match(full.line, /\(13 passed, 0 failed, 0 known-defect, 0 fixed-defect, 0 flaky, 0 skipped\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
