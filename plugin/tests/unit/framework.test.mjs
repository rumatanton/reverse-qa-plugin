// scaffold-framework rendering, run-suites planning and archiving, and the clean-up record logic (no Docker, no npm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { renderTemplate, applyAgentLessons, BROWSER_ONLY, NOT_FOR_DESKTOP } from '../../skills/scaffold-framework/scaffold.mjs';
import { plan, commandFor, archiveRun, BROWSER_TIERS } from '../../skills/run-suites/run.mjs';
import { newFiles, leftoverRows, cleanupTestData } from '../../lib/cleanup.mjs';
import { crawlSummary, summaryLines } from '../../skills/crawl-app/crawl.mjs';
import { newCrawl, recordVisit, observedMatrix } from '../../lib/crawl.mjs';

const TEMPLATE_FILES = [
  '.gitignore', 'README.md', 'crawl/crawl.spec.ts', 'package.json', 'pages/base.page.ts', 'playwright.config.ts', 'selftest/fixtures.selftest.ts', 'support/desktop.ts', 'support/fixtures.ts', 'support/global-setup.ts',
  'support/global-teardown.ts', 'support/matrix.ts', 'support/plugin.ts', 'support/seed.ts', 'support/target.ts', 'tests/a11y/axe.spec.ts', 'tests/api/endpoints.spec.ts', 'tests/t0-smoke/pages.spec.ts',
  'tests/t3-roles/authz/matrix.spec.ts', 'tests/visual/pages.spec.ts', 'unit/matrix.unit.ts',
];

test('the app kind decides the framework: an API gets no browser tiers, a kind with no driver is refused with the reason', () => {
  const { root } = tempProject();
  const api = loadTarget(root, 'mini-shop');
  api.def.app = { kind: 'api' };
  const r = renderTemplate(api);
  assert.equal(r.kind, 'api');
  assert.deepEqual(r.written.sort(), TEMPLATE_FILES.filter((f) => !BROWSER_ONLY.some((p) => f.startsWith(p))));
  assert.ok(r.written.includes('tests/api/endpoints.spec.ts') && r.written.includes('tests/t3-roles/authz/matrix.spec.ts'), 'the HTTP tiers stay');
  assert.ok(!r.written.some((f) => /a11y|visual|t0-smoke|crawl/.test(f)));
  const mobile = loadTarget(tempProject().root, 'mini-shop');
  mobile.def.app = { kind: 'mobile' };
  assert.throws(() => renderTemplate(mobile), /no test framework for a mobile app yet: needs the Appium driver \(templates\/DRIVERS\.md\)\. Everything up to the test cases works without it\./);

  assert.deepEqual(plan('all', { kind: 'api' }).map((s) => s.name), ['unit', 'selftest', 'full'], 'an API run has no smoke, other-browser or visual tier');
  assert.deepEqual(BROWSER_TIERS, ['smoke', 'browsers', 'visual']);
  assert.throws(() => plan('visual', { kind: 'api' }), /the visual tier needs a browser and this target is an API \(its tiers: all, unit, selftest, p1, full\)/);
  assert.deepEqual(plan('all', { kind: 'web' }).map((s) => s.name), ['unit', 'selftest', 'smoke', 'full', 'browsers', 'visual']);
});

test('a desktop app built with Electron gets the desktop driver: the tiers that open its windows, in one project, and no HTTP tiers', () => {
  const desktop = loadTarget(tempProject().root, 'mini-shop');
  desktop.def.app = { kind: 'desktop', driver: 'electron' };
  desktop.def.runtime = { app: { start_page: 'renderer/index.html' } };
  const r = renderTemplate(desktop);
  assert.deepEqual([r.kind, r.driver], ['desktop', 'electron']);
  assert.deepEqual(r.written.sort(), TEMPLATE_FILES.filter((f) => !NOT_FOR_DESKTOP.some((p) => f.startsWith(p))));
  for (const f of ['support/desktop.ts', 'tests/t0-smoke/pages.spec.ts', 'tests/a11y/axe.spec.ts', 'crawl/crawl.spec.ts']) assert.ok(r.written.includes(f), f);
  // a desktop app that is not built with Electron still has no driver
  const other = loadTarget(tempProject().root, 'mini-shop');
  other.def.app = { kind: 'desktop' };
  assert.throws(() => renderTemplate(other), /no test framework for a desktop app yet: needs the Appium driver/);

  const all = plan('all', { kind: 'desktop', driver: 'electron' });
  assert.deepEqual(all.map((s) => s.name), ['unit', 'selftest', 'smoke', 'full'], 'no other engines to repeat on, and no visual tier yet');
  assert.deepEqual(all.filter((s) => ['smoke', 'full'].includes(s.name)).map((s) => s.projects), [['desktop'], ['desktop']]);
  assert.throws(() => plan('visual', { kind: 'desktop', driver: 'electron' }), /a desktop app has no visual tier/);
  assert.deepEqual(plan('smoke', { kind: 'web' })[0].projects, ['chromium'], 'a web app is unchanged');
});

test('a run started by hand cannot replace the report the full tier wrote', () => {
  const TPL = path.join(PLUGIN, 'templates', 'framework');
  assert.match(fs.readFileSync(path.join(TPL, 'playwright.config.ts'), 'utf8'), /process\.env\.RQA_REPORT \?\? 'adhoc'/, 'a run that names no report is "adhoc", never "report"');
  assert.match(fs.readFileSync(path.join(TPL, 'support', 'global-teardown.ts'), 'utf8'), /process\.env\.RQA_REPORT \?\? 'adhoc'/);
  assert.equal(plan('full')[0].report, 'report', 'only the full tier writes report.json');
});

test('crawl-app summary: pages, what each role got, links left alone, and whether the page limit cut it short', () => {
  const base = 'http://localhost/shop/';
  const crawl = newCrawl({ baseUrl: base, start: ['index.php'], roles: ['Visitor', 'Admin'], maxPages: 2 });
  const visit = (role, p, final = p, extra = {}) => recordVisit(crawl, role, { requested: `${base}${p}`, finalUrl: `${base}${final}`, status: 200, title: p, links: [], forms: [], ...extra }, { loginPaths: ['login.php'] });
  visit('Visitor', 'index.php', 'index.php', { links: [{ href: `${base}logout.php`, label: 'Log out' }, { href: 'https://cdn.example.test/a', label: 'x' }, { href: `${base}media/manual.pdf`, label: 'Manual' }], forms: [{ action: `${base}login.php`, method: 'post', fields: [{ name: 'email' }] }] });
  // sent to log in, but the server logged an error while it answered: the page kept running behind the redirect
  visit('Visitor', 'admin/orders.php', 'login.php', { serverErrors: ['[x] PHP Fatal error:  Uncaught Error in /app/admin/orders.php:12', 'second line'] });
  visit('Admin', 'index.php');
  visit('Admin', 'admin/orders.php');
  crawl.truncated = true;
  assert.deepEqual(crawl.pages['admin/orders.php'].roles.Visitor, { outcome: 'redirect-login', status: 200, landed_on: 'login.php', server_errors: 2, server_error: '[x] PHP Fatal error:  Uncaught Error in /app/admin/orders.php:12' });
  assert.deepEqual(crawl.files, ['media/manual.pdf'], 'a link to a file is recorded, never opened as a page');
  assert.equal(crawl.pages['media/manual.pdf'], undefined);
  const s = crawlSummary(crawl);
  assert.deepEqual(s, { pages: 2, forms: 1, roles: { Visitor: { allowed: 1, 'redirect-login': 1, redirect: 0, error: 0, server_errors: 1 }, Admin: { allowed: 2, 'redirect-login': 0, redirect: 0, error: 0, server_errors: 0 } }, skipped_links: 1, files: 1, external_hosts: ['cdn.example.test'], truncated: true });
  const lines = summaryLines(s);
  assert.match(lines[0], /2 page\(s\), 1 form\(s\); stopped at the page limit/);
  assert.match(lines[1], /Visitor: 1 opened, 1 sent to log in, 0 redirected elsewhere, 0 answered with an error; on 1 page\(s\) the server logged an error/);
  assert.doesNotMatch(lines[2], /server logged/, 'a role with no server errors gets no such note');
  assert.match(lines[3], /1 link\(s\) left alone .* 1 link\(s\) to files, not opened; links to other hosts: \[cdn\.example\.test\]/);
  assert.deepEqual(observedMatrix(crawl).find((r) => r.page === 'admin/orders.php' && r.role === 'Visitor'), { page: 'admin/orders.php', role: 'Visitor', observed: 'redirect-login', status: 200, landed_on: 'login.php', server_errors: 2 });
});

test('renderTemplate writes every template file, names the package after the target, and points at the plugin', () => {
  const { root } = tempProject();
  const t = loadTarget(root, 'mini-shop');
  const r = renderTemplate(t);
  assert.deepEqual(r.written.sort(), TEMPLATE_FILES);
  const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'rqa-framework-mini-shop');
  assert.equal(pkg.devDependencies['@playwright/test'], '1.65.0', 'pinned, not a range');
  assert.ok(fs.readFileSync(path.join(r.dir, 'README.md'), 'utf8').startsWith('# mini-shop test framework'));
  assert.equal(fs.readFileSync(path.join(r.dir, '.rqa-plugin-path'), 'utf8').trim(), PLUGIN, 'a temp project is not next to the plugin');
  assert.match(fs.readFileSync(path.join(r.dir, '.gitignore'), 'utf8'), /\.rqa-plugin-path/);
});

test('template tests never skip: a test exists only when it can run, a missing input fails; rolePage opens no extra page', () => {
  const TPL = path.join(PLUGIN, 'templates', 'framework');
  for (const f of TEMPLATE_FILES.filter((x) => /\.(spec|selftest|unit)\.ts$|support\/fixtures\.ts$/.test(x))) {
    const src = fs.readFileSync(path.join(TPL, f), 'utf8');
    assert.doesNotMatch(src, /\b(test|testInfo|test\.describe)\.skip\(/, `${f}: no skips (a skipped test reports green while testing nothing)`);
    // in a serial group one failure leaves every later test unrun: each test makes the data it needs instead
    assert.doesNotMatch(src, /\bdescribe\.serial\(|mode:\s*['"]serial['"]/, `${f}: no serial groups (a failure would leave the tests after it unrun)`);
  }
  const fixtures = fs.readFileSync(path.join(TPL, 'support', 'fixtures.ts'), 'utf8');
  // two forms of the fixture: a desktop app's (its own window) and a browser's
  const rolePage = fixtures.match(/rolePage: isDesktop\s*\? async \(\{([^}]*)\}[\s\S]*?\n    : async \(\{([^}]*)\}/);
  assert.ok(rolePage, 'rolePage fixture found, in both forms');
  for (const deps of [rolePage[1], rolePage[2]]) assert.doesNotMatch(deps, /\bpage\b/, 'rolePage must not depend on the built-in page fixture');
  assert.doesNotMatch(rolePage[1], /\b(browser|context)\b/, 'the desktop form starts no browser');
  // a shared login is ended for every later test by any test that opens a logout page: each test logs in on its own
  const roles = fixtures.slice(fixtures.indexOf('roleRequest: async'));
  assert.match(roles, /await logIn\(ctx, role\)/, 'roleRequest logs in on its own session');
  assert.match(roles, /await logIn\(ctx\.request, role\)/, 'rolePage logs in on its own session');
  assert.doesNotMatch(roles, /storageState/, 'no test reuses the global-setup session');
});

test('visual pages open still, and every known-defect template test names its finding in the deciding assertion', () => {
  const TPL = path.join(PLUGIN, 'templates', 'framework');
  const visual = fs.readFileSync(path.join(TPL, 'tests', 'visual', 'pages.spec.ts'), 'utf8');
  assert.match(visual, /openStill\(page, /, 'screenshots are taken with timers paused and animated images on frame one');
  assert.doesNotMatch(visual, /openPage\(|page\.goto\(/, 'no other way into the page');
  const base = fs.readFileSync(path.join(TPL, 'pages', 'base.page.ts'), 'utf8');
  for (const needle of ['clock.install', 'clock.pauseAt', 'clock.runFor', 'ImageDecoder', 'unreadable']) assert.ok(base.includes(needle), `openStill uses ${needle}`);
  // a test.fail() test passes on any failure, so only the assertion naming the finding may confirm it (triage-failures)
  for (const f of TEMPLATE_FILES.filter((x) => x.endsWith('.spec.ts'))) {
    const src = fs.readFileSync(path.join(TPL, f), 'utf8');
    const known = src.match(/test\.fail\(true, `known defect \$\{([\w.]+)\}/);
    if (!known) continue;
    assert.ok(src.includes(`\${${known[1]}}: `), `${f}: the deciding assertion message starts with the finding ID`);
  }
});

test('the plugin\'s lessons are added to Playwright\'s planner, generator and healer once, and refreshed on every run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-agents-'));
  const agents = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  for (const role of ['planner', 'generator', 'healer']) fs.writeFileSync(path.join(agents, `playwright-test-${role}.md`), `---\nname: playwright-test-${role}\n---\n\nVendor text.\n`);
  assert.deepEqual(applyAgentLessons(dir), ['planner', 'generator', 'healer']);
  assert.deepEqual(applyAgentLessons(dir), ['planner', 'generator', 'healer'], 'a second run replaces the section');
  const gen = fs.readFileSync(path.join(agents, 'playwright-test-generator.md'), 'utf8');
  assert.equal(gen.split('## Lessons from real runs - Memory (reverse-qa)').length, 2, 'exactly one lessons section');
  assert.ok(gen.startsWith('---\nname: playwright-test-generator\n---\n\nVendor text.'), 'the vendor text is kept');
  assert.match(gen, /hover the card/);
  // a target scaffolded before the section was renamed carries the older heading: it is replaced, never kept beside the new one
  const healerFile = path.join(agents, 'playwright-test-healer.md');
  fs.writeFileSync(healerFile, '---\nname: playwright-test-healer\n---\n\nVendor text.\n\n## Lessons from real runs (reverse-qa)\n\n- an old lesson\n');
  applyAgentLessons(dir);
  const healer = fs.readFileSync(healerFile, 'utf8');
  assert.equal(healer.split('## Lessons from real runs').length, 2, 'the older heading is replaced by the new section');
  assert.doesNotMatch(healer, /an old lesson/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderTemplate never overwrites existing files unless forced', () => {
  const { root } = tempProject();
  const t = loadTarget(root, 'mini-shop');
  renderTemplate(t);
  const spec = path.join(t.dir, 'framework', 'tests', 't0-smoke', 'pages.spec.ts');
  fs.writeFileSync(spec, '// edited by a person');
  const again = renderTemplate(t);
  assert.equal(again.written.length, 0);
  assert.equal(fs.readFileSync(spec, 'utf8'), '// edited by a person');
  renderTemplate(t, { force: true });
  assert.notEqual(fs.readFileSync(spec, 'utf8'), '// edited by a person');
});

test('scaffold --no-install renders only and logs the step', () => {
  const { root, target } = tempProject();
  const r = runNode(path.join(PLUGIN, 'skills', 'scaffold-framework', 'scaffold.mjs'), ['--target', 'mini-shop', '--root', root, '--no-install']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`scaffold-framework: ${TEMPLATE_FILES.length} file\\(s\\) written, 0 kept`));
  assert.match(fs.readFileSync(path.join(target, 'output', 'ledger.jsonl'), 'utf8'), /"step":"scaffold-framework"/);
});

test('run-suites plans the tiers in order; unit, selftest and smoke stop the run on failure', () => {
  const all = plan('all');
  assert.deepEqual(all.map((s) => s.name), ['unit', 'selftest', 'smoke', 'full', 'browsers', 'visual']);
  assert.deepEqual(all.map((s) => s.stopOnFail), [true, true, true, false, false, false]);
  assert.equal(commandFor(all[2]), 'npx playwright test --project=chromium --grep=@smoke');
  assert.deepEqual(all[0].env, { RQA_SKIP_SETUP: '1' });
  assert.equal(all[3].report, 'report', 'the full run writes the main report that coverage and triage read');
  assert.deepEqual(plan('full', { upgrade: true }).map((s) => s.report), ['upgrade-report']);
  const flake = plan('all', { flakeGrep: '@TC-AUTH-001', repeatEach: 5 });
  assert.equal(commandFor(flake[0]), 'npx playwright test --project=chromium --grep=@TC-AUTH-001 --repeat-each=5');
  // a pattern with a space or a | would be split or piped by the shell: it is quoted, a plain tag is not
  assert.equal(commandFor({ ...flake[0], grep: 'Saved changes|TC-PAY-004' }), 'npx playwright test --project=chromium --grep="Saved changes|TC-PAY-004" --repeat-each=5');
  assert.throws(() => plan('nope'), /unknown tier/);
});

test('run-suites --dry-run prints the commands without running them', () => {
  const { root } = tempProject();
  const r = runNode(path.join(PLUGIN, 'skills', 'run-suites', 'run.mjs'), ['--target', 'mini-shop', '--root', root, '--dry-run', '--tier', 'all']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 6, 'one line per step, visual included');
  assert.match(r.stdout, /^unit: npx playwright test --project=unit {2}\[RQA_REPORT=unit RQA_SKIP_SETUP=1\]/);
});

test('run-suites refuses to run an uninstalled framework', () => {
  const { root } = tempProject();
  const r = runNode(path.join(PLUGIN, 'skills', 'run-suites', 'run.mjs'), ['--target', 'mini-shop', '--root', root, '--tier', 'unit']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run scaffold-framework first/);
});

test('archiveRun keeps the reports, the clean-up record, the PHP log, the HTML report and the artifacts', () => {
  const { target } = tempProject();
  const fw = path.join(target, 'framework');
  const results = path.join(fw, 'test-results');
  fs.mkdirSync(path.join(results, 'smoke-artifacts', 'failed-test'), { recursive: true });
  fs.mkdirSync(path.join(fw, 'playwright-report'), { recursive: true });
  fs.writeFileSync(path.join(results, 'smoke.json'), '{"suites":[]}');
  fs.writeFileSync(path.join(results, 'smoke-junit.xml'), '<testsuites/>');
  fs.writeFileSync(path.join(results, 'smoke-cleanup.json'), JSON.stringify({ leftover_rows: { cart: 2 }, removed_files: ['/var/www/html/uploads/x.png'], php_log: 'PHP Warning: x\n' }));
  fs.writeFileSync(path.join(results, 'smoke-artifacts', 'failed-test', 'trace.zip'), 'zip');
  fs.writeFileSync(path.join(fw, 'playwright-report', 'index.html'), '<html>');
  const dir = archiveRun(target, fw, 'smoke', '20261109-120000');
  assert.equal(path.basename(dir), '20261109-120000-smoke');
  for (const f of ['report.json', 'junit.xml', 'cleanup.json', 'php-error.log', 'html-report/index.html', 'artifacts/failed-test/trace.zip']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.readFileSync(path.join(dir, 'php-error.log'), 'utf8'), 'PHP Warning: x\n');
});

test('clean-up for a target the plugin cannot reach into: nothing is touched, and the record says what was not cleaned', () => {
  const target = loadTarget(tempProject().root, 'mini-shop');
  // no database, no containers, no log: no Docker call is made (this test runs with no engine)
  const record = cleanupTestData(target, 'web', { database: false, files: false, log: false });
  assert.deepEqual([record.leftover_rows, record.removed_files, record.reset, record.php_log], [null, null, null, ''], 'null, never an empty result that would read as "nothing was left"');
  assert.equal(record.not_cleaned, 'no database the plugin can reach, so rows the tests added stay in the app; the app does not run in containers the plugin started, so files the tests uploaded stay in the app');
});

test('clean-up record: rows above the seed per table, and only files the run added', () => {
  assert.deepEqual(leftoverRows({ cart: 2, orders: 31, users: 10 }, { cart: 5, orders: 31, users: 9, extra: 1 }), { cart: 3, extra: 1, users: -1 });
  assert.deepEqual(newFiles(['/a/1.png', '/a/2.png'], ['/a/1.png', '/a/2.png', '/a/3.pdf']), ['/a/3.pdf']);
});

test('rerun runs every check in order, upgrade only where the target has an upgrade runtime', async () => {
  const { steps } = await import('../../skills/recon/rerun.mjs');
  const { root } = tempProject();
  const t = loadTarget(root, 'mini-shop');
  const names = (o) => steps(t, o).map((s) => s.name);
  const all = names({ root });
  assert.deepEqual(all.filter((n) => !n.startsWith('run-target-app') && !n.startsWith('run-upgrade')), ['plugin tests', 'run-suites', 'run-security-scans', 'run-perf smoke', 'run-perf load', 'triage-failures', 'build-stories', 'coverage-report', 'build-report']);
  assert.equal(all.includes('run-upgrade-compare'), Boolean(t.def.runtime?.upgrade_base_url));
  assert.ok(!names({ root, plugin: false }).includes('plugin tests'));
  const triage = steps(t, { root }).find((s) => s.name === 'triage-failures');
  assert.ok(triage.args.includes('--confirm-findings'), 'triage also confirms findings that a test reproduces');
  assert.ok(steps(t, { root }).find((s) => s.name === 'run-suites').args.join(' ').endsWith('--tier all'));
});
