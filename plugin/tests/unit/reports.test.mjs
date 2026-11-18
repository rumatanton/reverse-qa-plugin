// coverage-report, build-rtm, triage-failures and build-report on a fixed run: a Playwright report with every outcome,
// a role matrix, a risk register, findings and a PHP log. Each expected number is worked out in the comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN, FIXTURE_SRC, tempProject, runNode } from '../helpers.mjs';
import { readReport, flatten, outcomeCounts, tagsOf, skipReasons, linkCovers, perfRows, coveringCases } from '../../lib/pwreport.mjs';
import { toXrayResults, validateCases } from '../../lib/xray.mjs';
import { computeCoverage, gateFailures, summaryLine } from '../../skills/coverage-report/coverage.mjs';
import { buildRtm } from '../../skills/build-rtm/rtm.mjs';
import { parsePhpLog, inWindow, classify, triage, confirmFindings } from '../../skills/triage-failures/triage.mjs';
import { renderReport, junitCounts, testTypeRows, resultsChart, gatesTable, junitCases, dashboardRows, bugRows } from '../../skills/build-report/report.mjs';
import { normalize } from '../../lib/inventory.mjs';
import { parseDump } from '../../lib/sqldump.mjs';
import { parseCsv } from '../../lib/csv.mjs';

const FX = path.join(PLUGIN, 'tests', 'fixtures');
const REPORT = path.join(FX, 'reports', 'mini-shop-report.json');
const ROWS = flatten(readReport(REPORT));
const read = (p) => fs.readFileSync(path.join(FX, p), 'utf8');
const INVENTORY = normalize(JSON.parse(read('scan/mini-shop.raw.json')), parseDump(fs.readFileSync(path.join(FIXTURE_SRC, 'seed.sql'), 'utf8'))).inventory;
const INPUTS = {
  inventory: INVENTORY,
  roleMatrix: parseCsv(read('reports/role-matrix.csv')),
  requirements: YAML.parse(read('xray/mini-shop-requirements.yaml')),
  cases: YAML.parse(read('xray/mini-shop-cases.yaml')),
  risks: parseCsv(read('reports/risk-register.csv')),
  rows: ROWS,
};

test('flatten: one row per run with outcome and traceability tags', () => {
  assert.equal(ROWS.length, 10);
  assert.deepEqual(outcomeCounts(ROWS), { passed: 2, failed: 4, 'known-defect': 1, 'fixed-defect': 1, flaky: 1, skipped: 1 });
  const leak = ROWS.find((r) => r.cases.includes('TC-ADM-001'));
  assert.deepEqual([leak.outcome, leak.findings, leak.pages, leak.roles, leak.tiers], ['known-defect', ['F-001'], ['admin/report.php'], ['Visitor'], ['authz']]);
  assert.deepEqual(tagsOf({ title: 'x @page:index.php @p2 @api' }), { cases: [], findings: [], pages: ['index.php'], roles: [], priority: 'P2', tiers: ['api'] }, '@page: is a page, not the page tier');
});

test('skip reasons: read from the skip annotation and grouped with page names folded out', () => {
  // a skip decided at collection time (static annotation on the test) and one decided inside the body (result annotation)
  const spec = (title, test) => ({ title, file: 'x.spec.ts', tests: [{ projectName: 'chromium', status: 'skipped', expectedStatus: 'skipped', results: [{}], ...test }] });
  const report = {
    suites: [{ file: 'x.spec.ts', specs: [
      spec('a', { annotations: [{ type: 'skip', description: 'admin/a.php has a session guard: role-matrix.csv names the role that may open it' }] }),
      spec('b', { annotations: [{ type: 'skip' }, { type: 'skip', description: 'admin/b.php has a session guard: role-matrix.csv names the role that may open it' }] }),
      spec('c', { results: [{ annotations: [{ type: 'skip', description: 'no credentials for role Customer (target.yaml test_accounts)' }] }] }),
      spec('d', {}), // no skip annotation: Playwright never started it (serial group after a failure)
      spec('f', { annotations: [{ type: 'skip' }] }), // test.skip() with no reason
      { title: 'e', file: 'x.spec.ts', tests: [{ projectName: 'chromium', status: 'expected', expectedStatus: 'passed', results: [{}] }] },
    ] }],
  };
  const rows = flatten(report);
  assert.equal(rows[0].skipReason, 'admin/a.php has a session guard: role-matrix.csv names the role that may open it');
  assert.equal(rows[5].skipReason, null, 'a passed test has no skip reason');
  assert.deepEqual(skipReasons(rows), [
    { reason: '<page> has a session guard: role-matrix.csv names the role that may open it', count: 2 },
    { reason: 'no credentials for role Customer (target.yaml test_accounts)', count: 1 },
    { reason: 'no reason given', count: 1 },
    { reason: 'not run: an earlier test in its serial group failed, or the run was stopped', count: 1 },
  ]);
});

test('coverage: pages 6/6, cells 8/10 (the skipped admin run does not count), requirements 3/3, P1 2/2', () => {
  const c = computeCoverage(INPUTS);
  assert.deepEqual([c.pages.covered, c.pages.total], [6, 6]);
  assert.deepEqual([c.cells.covered, c.cells.total, c.cells.pct], [8, 10, 80]);
  assert.deepEqual(c.cells.gaps, ['admin/products.php|Admin', 'admin/report.php|Admin']);
  assert.deepEqual([c.requirements_designed.covered, c.requirements_automated.covered, c.p1_automated.covered, c.p1_automated.total], [3, 3, 2, 2]);
  assert.equal(summaryLine(c), 'coverage-report: pages 6/6 (100%), role-matrix cells 8/10 (80%), requirements designed 3/3 (100%), requirements automated 3/3 (100%), P1 automated 2/2 (100%)');
  assert.deepEqual(gateFailures(c), ['role-matrix cells: 8/10, gaps: admin/products.php|Admin, admin/report.php|Admin']);
});

test('coverage: a missing input is "not measured" and fails the gate instead of passing silently', () => {
  const c = computeCoverage({ ...INPUTS, roleMatrix: null, rows: null });
  assert.equal(c.cells, undefined);
  assert.equal(c.measured.pages, false);
  assert.ok(gateFailures(c).some((f) => f === 'role-matrix cells: not measured (input missing)'));
});

test('rtm: one row per requirement × case with risk, result, Xray key and findings; orphans listed', () => {
  const findings = parseCsv(read('reports/findings.csv'));
  const stories = [{ id: 'US-ADM-001', requirements: [INPUTS.requirements[0].id] }];
  const { rows, orphans } = buildRtm({ ...INPUTS, xrayKeys: { 'TC-ADM-001': 'QA-104' }, findings, stories });
  assert.equal(rows.length, 4);
  assert.ok(rows.filter((r) => r.req_id === INPUTS.requirements[0].id).every((r) => r.story === 'US-ADM-001'), 'each row names its user story');
  assert.ok(rows.filter((r) => r.req_id !== INPUTS.requirements[0].id).every((r) => r.story === ''), 'no story: an empty cell, never a guess');
  const adm = rows.find((r) => r.case_id === 'TC-ADM-001');
  assert.deepEqual([adm.priority, adm.risk_score, adm.xray_key, adm.last_result, adm.findings], ['P2', '8', 'QA-104', 'known-defect', 'F-001']);
  assert.equal(rows.find((r) => r.case_id === 'TC-PAY-001').last_result, 'failed');
  assert.equal(rows.find((r) => r.case_id === 'TC-PAY-001').findings, 'F-002');
  assert.deepEqual(orphans, { requirements_without_cases: [], cases_without_requirement: [], specs_with_unknown_case: [], cases_never_automated: [], covers_matching_nothing: [] });
  const broken = buildRtm({ ...INPUTS, requirements: INPUTS.requirements.slice(0, 2), rows: [...ROWS, { ...ROWS[0], cases: ['TC-GONE-001'] }] });
  assert.deepEqual(broken.orphans.cases_without_requirement, ['TC-ADM-001']);
  assert.equal(broken.orphans.specs_with_unknown_case.length, 1);
});

test('covers: a case selects results that carry no case tag (a tier, a browser, a k6 scenario); a selector matching nothing is listed', () => {
  const rows = [
    { file: 'a11y/axe.spec.ts', title: 'login.php has no new accessibility violations @a11y @page:login.php @role:Visitor', project: 'chromium', outcome: 'passed', cases: [] },
    { file: 't4-e2e/customer.spec.ts', title: 'a customer buys a book @e2e', project: 'firefox', outcome: 'failed', cases: [] },
    { file: 't4-e2e/customer.spec.ts', title: 'a customer buys a book @e2e', project: 'chromium', outcome: 'passed', cases: ['TC-CART-001'] },
    { file: 't0-smoke/pages.spec.ts', title: 'index.php loads for Visitor @smoke @page:index.php', project: 'chromium', outcome: 'skipped', cases: [] },
  ];
  // k6 is not a Playwright test: its summary becomes rows a case can select, one per scenario and per page
  const perf = perfRows({ scenarios: [{ name: 'load', thresholds_passed: true, per_page: [{ page: 'index.php', p95_ms: 10.8 }, { page: 'books.php', p95_ms: 900 }] }] }, { p95_ms: 800 });
  assert.deepEqual(perf.map((r) => [r.title, r.outcome]), [['k6:load @perf', 'passed'], ['k6:load @perf @page:index.php', 'passed'], ['k6:load @perf @page:books.php', 'failed']]);
  const cases = [
    { id: 'TC-ACC-001', requirement: 'REQ-ACC-001', covers: ['@a11y @page:login.php'] },
    { id: 'TC-COMPAT-001', requirement: 'REQ-COMPAT-001', covers: ['project:firefox @e2e'] },
    { id: 'TC-PERF-001', requirement: 'REQ-PERF-001', covers: ['k6:load @page:index.php'] },
    { id: 'TC-PERF-002', requirement: 'REQ-PERF-002', covers: ['k6:load @page:books.php'] },
    { id: 'TC-SMOKE-001', requirement: 'REQ-CAT-001', covers: ['@smoke @page:index.php'] }, // its only result was skipped
    { id: 'TC-ACC-002', requirement: 'REQ-ACC-002', covers: ['@a11y @page:nowhere.php'] }, // names a test that does not exist
  ];
  const { rows: linked, unmatched } = linkCovers([...rows, ...perf], cases);
  assert.deepEqual(linked[0].cases, ['TC-ACC-001']);
  assert.deepEqual(linked[1].cases, ['TC-COMPAT-001'], 'the firefox run, not the chromium one');
  assert.deepEqual(linked[2].cases, ['TC-CART-001'], 'a tagged result keeps its own case');
  assert.deepEqual(unmatched, [{ case: 'TC-SMOKE-001', selector: '@smoke @page:index.php' }, { case: 'TC-ACC-002', selector: '@a11y @page:nowhere.php' }], 'a skipped result and a missing one are not coverage');
  assert.deepEqual(coveringCases({ title: 'x @a11y @page:login.php', project: 'webkit' }, cases), ['TC-ACC-001']);

  // through coverage and the traceability matrix
  const requirements = ['REQ-ACC-001', 'REQ-COMPAT-001', 'REQ-PERF-001', 'REQ-PERF-002', 'REQ-CAT-001', 'REQ-ACC-002'].map((id) => ({ id, statement: id, kind: 'intended' }));
  const main = linked.slice(0, rows.length);
  const extraRows = linked.slice(rows.length);
  const c = computeCoverage({ requirements, cases: { cases }, rows: main, extraRows });
  assert.deepEqual(c.requirements_automated.gaps, ['REQ-ACC-002', 'REQ-CAT-001'], 'k6 and other-browser results count; a skipped one does not');
  const rtm = buildRtm({ requirements, cases: { cases }, rows: main, extraRows, unmatchedCovers: unmatched });
  const result = (id) => rtm.rows.find((r) => r.case_id === id).last_result;
  assert.deepEqual(['TC-ACC-001', 'TC-COMPAT-001', 'TC-PERF-001', 'TC-PERF-002', 'TC-ACC-002'].map(result), ['passed', 'failed', 'passed', 'failed', 'not run']);
  assert.match(rtm.rows.find((r) => r.case_id === 'TC-COMPAT-001').automated_by, /\[firefox\]/);
  assert.deepEqual(rtm.orphans.covers_matching_nothing, ['TC-SMOKE-001: @smoke @page:index.php', 'TC-ACC-002: @a11y @page:nowhere.php']);

  // the case checker reads each word; a covered Playwright result reaches its Xray test
  const valid = { id: 'TC-ACC-001', title: 'The login page has no accessibility violation', requirement: 'REQ-ACC-001', priority: 'P2', tier: 'a11y', technique: 'checklist', type: 'manual', steps: [{ action: 'Open login.php', expected: 'axe-core reports no violation' }] };
  assert.deepEqual(validateCases({ cases: [{ ...valid, covers: ['@a11y @page:login.php', 'project:webkit @a11y', 'k6:load @page:login.php'] }] }).problems, []);
  assert.match(validateCases({ cases: [{ ...valid, covers: ['@a11y page:login.php'] }] }).problems.join('\n'), /covers word "page:login.php" must be a tag/);
  assert.match(validateCases({ cases: [{ ...valid, covers: [] }] }).problems.join('\n'), /covers is a list of selectors/);
  const report = { suites: [{ file: 'a11y/axe.spec.ts', specs: [{ title: 'login.php has no new accessibility violations @a11y @page:login.php', tests: [{ projectName: 'chromium', status: 'expected', expectedStatus: 'passed', results: [{}] }] }] }] };
  const x = toXrayResults(report, { testKeys: { 'TC-ACC-001': 'QA-7' }, cases });
  assert.deepEqual(x.results.tests.map((r) => [r.testKey, r.status]), [['QA-7', 'PASSED']]);
  assert.deepEqual(toXrayResults(report, { testKeys: { 'TC-ACC-001': 'QA-7' } }).unlinked.length, 1, 'without covers the result has no case');
});

test('triage: each failing test gets a category from evidence, with the deciding line', () => {
  const log = parsePhpLog(read('reports/php-error.log'));
  assert.equal(log[1].level, 'fatal');
  assert.equal(log[1].at, Date.UTC(2026, 10, 9, 10, 0, 11));
  const t = triage(ROWS, log);
  assert.deepEqual(t.summary, { environment: 1, app: 1, test: 1, 'needs-review': 1, 'app-changed': 1 });
  const by = (title) => t.items.find((i) => i.title.startsWith(title));
  assert.equal(by('checkout').category, 'app');
  assert.match(by('checkout').evidence[0], /PHP log: PHP Fatal error: {2}Uncaught Error: Call to a member function fetch_assoc/);
  assert.equal(by('wrong password').category, 'test');
  assert.deepEqual(by('wrong password').evidence, ['Error: locator.click: Timeout 5000ms exceeded.', "- waiting for getByRole('button', { name: 'Sign in' })"]);
  assert.equal(by('products').category, 'environment');
  assert.equal(by('price shown').category, 'needs-review', 'an assertion mismatch with no server evidence is not guessed');
  assert.equal(by('old defect').category, 'app-changed');
  assert.deepEqual(t.flaky.map((f) => f.project), ['firefox']);
});

test('triage: the log window keeps unrelated errors out', () => {
  const log = parsePhpLog(read('reports/php-error.log'));
  const home = ROWS.find((r) => r.title.startsWith('home'));
  assert.deepEqual(inWindow(log, home), [], 'the 09:59 mysqli warning is outside every test window');
  assert.equal(classify({ ...home, outcome: 'failed', error: 'Error: expect(received).toBe(expected)' }, log).category, 'needs-review');
  assert.equal(classify({ ...home, outcome: 'failed', error: 'Error: expected status 200, received 500 Internal Server Error' }, []).category, 'app');
  const watcher = classify({ ...home, outcome: 'failed', error: 'Error: PHP fatal error during the test:\n[10-Nov-2026 01:08:22 UTC] PHP Fatal error:  Uncaught Error: Call to a member function fetch_assoc() on boolean in /var/www/html/cart.php:4' }, []);
  assert.equal(watcher.category, 'app', 'the framework watcher message carries the fatal line even after the log was cleaned up');
  assert.match(watcher.evidence[0], /fetch_assoc\(\) on boolean/);
  // a stack other than PHP: the watcher's message names a server error and carries the logged lines
  const java = classify({ ...home, outcome: 'failed', error: 'Error: Server error during the test:\n2026-11-10 10:00:06.777 ERROR 1 --- [exec-2] o.a.c.c.C.[dispatcherServlet] : Servlet.service() threw exception\njava.lang.NullPointerException: Cannot invoke "Order.getId()"' }, []);
  assert.equal(java.category, 'app', 'a logged server error is the app\'s, whatever the language');
  assert.match(java.evidence[1], /NullPointerException/);
});

test('build-report: every number on the page equals the source files; missing sections say "not run yet"', () => {
  const coverage = computeCoverage(INPUTS);
  const html = renderReport({ target: 'mini-shop', commit: 'abc', inventory: INVENTORY, coverage, rows: ROWS, findings: parseCsv(read('reports/findings.csv')), triage: triage(ROWS, []), perf: null, security: null, upgrade: null, ledger: [] });
  const metric = (k) => html.match(new RegExp(`data-metric="${k.replace('.', '\\.')}">([^<]*)<`))?.[1];
  for (const k of ['pages', 'cells', 'requirements_designed', 'requirements_automated', 'p1_automated']) {
    assert.equal(metric(`${k}.covered`), String(coverage[k].covered), k);
    assert.equal(metric(`${k}.total`), String(coverage[k].total), k);
  }
  assert.equal(metric('results.total'), '10');
  assert.equal(metric('results.known-defect'), '1');
  assert.equal(metric('findings.high'), '1');
  assert.equal(metric('inventory.pages'), '6');
  for (const s of ['Performance (k6): not run yet', 'Security scans: not run yet', 'PHP upgrade comparison: not run yet']) assert.ok(html.includes(s), s);
  assert.ok(!/<script/i.test(html), 'self-contained, no scripts');
});

test('test dashboard data: one row per test of every kind, grouped by type, with bugs and their Jira keys', () => {
  const xml = `<testsuites><testsuite name="s"><testcase name="parses &quot;dumps&quot;" time="0.25" file="C:\\p\\plugin\\tests\\unit\\sqldump.test.mjs"/>
    <testcase name="mini-shop flow" time="2" file="/p/plugin/tests/integration/runtime.test.mjs"><failure message="fetch failed&#10;more"/></testcase>
    <testcase name="tech-analyst" time="1" file="/p/plugin/tests/behavior/agents.test.mjs"></testcase></testsuite></testsuites>`;
  const cases = junitCases(xml);
  assert.deepEqual(cases.map((c) => [c.folder, c.name, c.status, c.ms]), [['unit', 'parses "dumps"', 'passed', 250], ['integration', 'mini-shop flow', 'failed', 2000], ['behavior', 'tech-analyst', 'passed', 1000]]);
  assert.equal(cases[1].detail, 'fetch failed', 'first line of the failure');
  // node:test writes a quote in a test name escaped twice: the name must come out with the quote, not a literal &quot;
  assert.equal(junitCases('<testcase name="ends with a &amp;quot;Lessons&amp;quot; section" time="0" file="/p/plugin/tests/unit/registry.test.mjs"/>')[0].name, 'ends with a "Lessons" section');

  const pw = (title, project, outcome) => ({ title, project, outcome, duration: 10, error: outcome === 'failed' ? '\u001b[31mError: boom\u001b[39m\nstack' : null, tiers: tagsOf({ title }).tiers });
  const rows = dashboardRows({
    suites: { selftest: [pw('db fixture reads exact counts', 'selftest', 'passed'), pw('requests are blocked and recorded', 'selftest', 'passed')], browsers: [pw('index.php loads @smoke', 'firefox', 'passed')], upgrade: [pw('GET books.php @api', 'chromium', 'failed')] },
    rows: [pw('GET index.php as Visitor @api @page:index.php', 'chromium', 'passed'), pw('admin/index.php as Visitor → redirect F-008 @authz', 'chromium', 'known-defect'), pw('forged callback rejected @integration @security', 'chromium', 'passed'), pw('admin journey @e2e @flow', 'chromium', 'failed')],
    perf: { scenarios: [{ name: 'load', requests: 2670, p95_ms: 6.4, error_rate_pct: 0, thresholds_passed: true, failed_thresholds: [] }] },
    security: { tools: [{ tool: 'semgrep', ran: true, findings: 107, new: 0, seconds: 9 }, { tool: 'zap', ran: true, findings: 21, new: 'no baseline', seconds: 60 }] },
    pluginCases: cases,
  });
  const by = (t) => rows.find((r) => r.test === t);
  assert.deepEqual([by('db fixture reads exact counts').group, by('requests are blocked and recorded').group], ['Database', 'Integration']);
  assert.deepEqual([by('GET index.php as Visitor').group, by('GET index.php as Visitor').runner], ['API', 'Playwright request'], 'tags are stripped from the name');
  assert.deepEqual([by('admin/index.php as Visitor → redirect F-008').group, by('admin/index.php as Visitor → redirect F-008').status], ['Authorization', 'known defect']);
  assert.equal(by('forged callback rejected').group, 'Security', 'a security tag wins over integration');
  assert.deepEqual([by('admin journey').suite, by('admin journey').detail], ['End-to-end journeys', 'Error: boom'], 'colour codes and the stack are dropped');
  assert.deepEqual([by('index.php loads').suite, by('index.php loads').browser], ['Smoke: every page loads (firefox)', 'firefox']);
  assert.equal(rows.find((r) => r.group === 'Upgrade (PHP 8.2)').suite, 'Same suite on PHP 8.2: HTTP endpoints');
  assert.deepEqual(rows.filter((r) => r.group === 'Performance (k6)').map((r) => [r.status, r.detail]), [['passed', '2670 requests, p95 6.4 ms, errors 0%']]);
  assert.deepEqual(rows.filter((r) => r.group === 'Security' && r.runner !== 'Playwright').map((r) => r.status), ['passed', 'failed'], 'a scanner with no baseline is not a pass');
  assert.deepEqual([...new Set(rows.filter((r) => r.runner === 'node:test').map((r) => `${r.group}/${r.suite}`))], ['reverse-qa plugin/Unit', 'reverse-qa plugin/Integration (Docker)', 'Agents (behavior)/Subagents on the fixture app']);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.id), ['0001', '0002']);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'ids are unique');
  assert.deepEqual(bugRows({ bugs: [{ id: 'BUG-001', finding_id: 'F-008', severity: 'critical', priority: 'P1', summary: 's' }, { id: 'BUG-002', finding_id: 'F-009', severity: 'medium', priority: 'P2', summary: 't' }] }, { 'BUG-001': 'EB-12' }).map((b) => [b.bug, b.jira, b.filed]), [['BUG-001', 'EB-12', 'yes'], ['BUG-002', '', 'no']]);
});

test('results by test type: rows per suite and tier, plugin JUnit counts, a chart that never relies on color alone', () => {
  const xml = '<testsuites><testsuite><testcase name="a"/><testcase name="b"><failure message="x"/></testcase><testcase name="c"><skipped/></testcase><testcase name="d"></testcase></testsuite></testsuites>';
  assert.deepEqual(junitCounts(xml), { passed: 2, failed: 1, skipped: 1 });
  assert.equal(junitCounts(''), null);
  const rows = testTypeRows({ rows: ROWS, suites: { unit: ROWS.slice(0, 1) }, pluginTests: { passed: 140, failed: 0, skipped: 1 } });
  const by = Object.fromEntries(rows.map((r) => [r.type, r]));
  assert.deepEqual([by['Framework unit (helpers)'].passed, by['reverse-qa plugin tests (node:test)'].passed], [1, 140]);
  assert.deepEqual([by['Authorization (role matrix)'].passed, by['Authorization (role matrix)'].failed, by['Authorization (role matrix)'].skipped, by['Authorization (role matrix)'].known], [1, 1, 1, 1], 'known defects count as passing, with their own column');
  assert.ok(by['End-to-end journeys'], 'an @e2e test is a journey even when another tier tag comes first');
  const html = resultsChart(rows);
  assert.match(html, /<pattern id="hatch"/);
  assert.match(html, /fill="url\(#hatch\)"/, 'failed segments carry the hatch texture');
  assert.match(html, /<title>[^<]+: \d+ failed<\/title>/, 'every segment has a tooltip');
  assert.match(html, /<th>✓ Passed<\/th><th>✗ Failed<\/th>/, 'a table repeats every number');
  assert.match(gatesTable({ perf: { scenarios: [{ name: 'load', thresholds_passed: true, requests: 9, p95_ms: 6, error_rate_pct: 0 }] }, security: { tools: [{ tool: 'zap', ran: true, findings: 21, new: 0 }] } }), /✓ thresholds met[\s\S]*✓ no new findings|✓ no new findings[\s\S]*✓ thresholds met/);
});

test('the report CLIs run end to end on a project and write their files', () => {
  const { root, target } = tempProject();
  const out = path.join(target, 'output');
  fs.mkdirSync(path.join(out, 'test-cases'), { recursive: true });
  fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(INVENTORY));
  fs.copyFileSync(path.join(FX, 'reports', 'role-matrix.csv'), path.join(out, 'role-matrix.csv'));
  fs.copyFileSync(path.join(FX, 'reports', 'risk-register.csv'), path.join(out, 'risk-register.csv'));
  fs.copyFileSync(path.join(FX, 'reports', 'findings.csv'), path.join(out, 'findings.csv'));
  fs.copyFileSync(path.join(FX, 'xray', 'mini-shop-requirements.yaml'), path.join(out, 'requirements.yaml'));
  fs.copyFileSync(path.join(FX, 'xray', 'mini-shop-cases.yaml'), path.join(out, 'test-cases', 'cases.yaml'));
  const args = ['--target', 'mini-shop', '--root', root, '--report', REPORT];
  const skill = (s) => path.join(PLUGIN, 'skills', s);
  const cov = runNode(skill('coverage-report/coverage.mjs'), args);
  assert.equal(cov.status, 0, cov.stderr);
  assert.equal(runNode(skill('coverage-report/coverage.mjs'), [...args, '--gate']).status, 2);
  const rtm = runNode(skill('build-rtm/rtm.mjs'), [...args, '--strict']);
  assert.equal(rtm.status, 0, rtm.stderr);
  assert.match(rtm.stdout, /build-rtm: 4 rows; orphans: 0 requirement/);
  const tri = runNode(skill('triage-failures/triage.mjs'), [...args, '--php-log', path.join(FX, 'reports', 'php-error.log')]);
  assert.equal(tri.status, 0, tri.stderr);
  assert.match(tri.stdout, /5 failing test\(s\): environment 1, app 1, test 1, needs-review 1, app-changed 1; flaky 1/);
  const rep = runNode(skill('build-report/report.mjs'), args);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /5\/8 sections with data: inventory, coverage, rows, findings, triage/);
  for (const f of ['coverage.json', 'rtm.csv', 'rtm-orphans.json', 'triage.json', 'triage.md', 'report.html']) assert.ok(fs.existsSync(path.join(out, f)), f);
});

test('confirm findings: a test.fail() tagged with the finding that failed at the assertion naming it confirms it, nothing else does', () => {
  const findings = [
    { id: 'F-008', status: 'triaged', test_id: '' },
    { id: 'F-012', status: 'single-source', test_id: '' },
    { id: 'F-013', status: 'triaged', test_id: '' },
    { id: 'F-R01', status: 'rejected', test_id: '' },
    { id: 'F-015', status: 'confirmed', test_id: 'upgrade: books.php' },
    { id: 'F-009', status: 'triaged', test_id: '' },
  ];
  const row = (title, outcome, error = null) => ({ file: 'security/runtime-checks.spec.ts', title, outcome, error, findings: tagsOf({ title }).findings });
  const rows = [
    row('index.php sends the basic security headers @security F-012', 'known-defect', 'F-012: security headers\n\nexpect(received).toEqual(expected)'),
    row('login.php sends the basic security headers @security F-012', 'known-defect', 'F-012: security headers\n\nexpect(received).toEqual(expected)'),
    row('the session cookie is HttpOnly @security F-013', 'fixed-defect'), // passed: the defect may be fixed, so not confirmed
    row('zap informational @security F-R01', 'known-defect', 'F-R01: informational'),
    row('books.php on PHP 8 F-015', 'known-defect', 'F-015: GET books.php with no parameters'),
    row('admin page served to visitors F-008', 'failed', 'F-008: page body served'), // a red test is evidence for triage, not a confirmation
    // failed as expected, but on a precondition: it says nothing about the finding
    row('a visitor cannot delete a comment F-009', 'known-defect', 'a visitor is sent to the admin login\n\nExpected: 302\nReceived: 200'),
  ];
  const { findings: out, confirmed, unproven } = confirmFindings(findings, rows);
  assert.deepEqual(confirmed, ['F-012']);
  assert.deepEqual(out.map((f) => f.status), ['triaged', 'confirmed', 'triaged', 'rejected', 'confirmed', 'triaged']);
  assert.equal(out[1].test_id, 'security/runtime-checks.spec.ts: index.php sends the basic security headers; security/runtime-checks.spec.ts: login.php sends the basic security headers');
  assert.equal(out[4].test_id, 'upgrade: books.php; security/runtime-checks.spec.ts: books.php on PHP 8', 'earlier test ids are kept');
  assert.deepEqual(unproven, [{ id: 'F-009', test: 'security/runtime-checks.spec.ts: a visitor cannot delete a comment', error: 'a visitor is sent to the admin login' }]);
});
