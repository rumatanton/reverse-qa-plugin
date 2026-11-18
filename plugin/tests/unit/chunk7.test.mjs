// run-perf, run-security-scans, security-second-opinion and run-upgrade-compare logic, on real tool output recorded from
// a PHP shop app (k6 v2.1.0, Semgrep 1.183.0, Psalm 6.20.10, ZAP stable, 2026-11-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { parseK6Summary, parseSlowLog, pickPages, pageUrls, summaryMarkdown, mergeScenarios } from '../../skills/run-perf/perf.mjs';
import { normalizeSemgrep, normalizePsalm, normalizeZap, fingerprint, compareBaseline, zapTarget } from '../../skills/run-security-scans/security.mjs';
import { references, matchSecondOpinion, prepare } from '../../skills/security-second-opinion/second.mjs';
import { diffRuns, compareMarkdown, firstError } from '../../skills/run-upgrade-compare/compare.mjs';
import { isGuarded, publicPages } from '../../lib/pages.mjs';
import { normalize } from '../../lib/inventory.mjs';

const FX = path.join(PLUGIN, 'tests', 'fixtures');
const json = (p) => JSON.parse(fs.readFileSync(path.join(FX, p), 'utf8'));

test('parseK6Summary reads totals, per-page p95 and every threshold from a real k6 summary', () => {
  const s = parseK6Summary('smoke', json('perf/k6-summary.json'));
  assert.equal(s.requests, 30);
  assert.equal(s.error_rate_pct, 0);
  assert.equal(s.thresholds_passed, true);
  assert.equal(s.per_page.length, 6);
  assert.ok(s.p95_ms > 0 && s.per_page.every((p) => p.p95_ms > 0));
  assert.deepEqual(s.per_page.map((p) => p.p95_ms), [...s.per_page.map((p) => p.p95_ms)].sort((a, b) => b - a), 'slowest page first');
  const failing = structuredClone(json('perf/k6-summary.json'));
  failing.metrics.http_req_failed.thresholds = { 'rate<0.01': { ok: false } };
  assert.deepEqual(parseK6Summary('load', failing).failed_thresholds, ['http_req_failed rate<0.01']);
});

test('parseSlowLog lists statements slowest first and skips SET timestamp / use lines', () => {
  const log = [
    '# Time: 261109 21:00:00',
    '# User@Host: root[root] @ localhost []',
    '# Query_time: 0.150000  Lock_time: 0.000010  Rows_sent: 49  Rows_examined: 49',
    'use minishop;',
    'SET timestamp=1794258000;',
    'SELECT * FROM book;',
    '# Query_time: 0.420000  Lock_time: 0.000020  Rows_sent: 1  Rows_examined: 1200',
    'SET timestamp=1794258001;',
    'SELECT * FROM payments p',
    '  JOIN book b ON b.bid = p.bid;',
  ].join('\n');
  assert.deepEqual(parseSlowLog(log), [
    { query_time_s: 0.42, rows_sent: 1, rows_examined: 1200, statement: 'SELECT * FROM payments p JOIN book b ON b.bid = p.bid;' },
    { query_time_s: 0.15, rows_sent: 49, rows_examined: 49, statement: 'SELECT * FROM book;' },
  ]);
  assert.deepEqual(parseSlowLog(''), []);
});

test('pickPages: explicit list, then target.yaml perf.pages, then public pages from the inventory', () => {
  const inv = normalize(json('scan/mini-shop.raw.json'), null).inventory;
  const t = { def: { test_accounts: { c: { login: { path: 'login.php' } } } } };
  assert.deepEqual(pickPages(t, inv, ['a.php']), ['a.php']);
  assert.deepEqual(pickPages({ def: { perf: { pages: ['x.php'] } } }, inv), ['x.php']);
  assert.deepEqual(pickPages(t, inv), ['index.php', 'login.php'], 'cart, checkout and the admin pages redirect to log in');
  // a detail page is timed with the query a user arrives with, never on its "no id" path; the result keeps the page's name
  assert.deepEqual(pageUrls({ def: { page_params: { 'books.php': { query: 'id=1' } } } }, ['index.php', 'books.php']), { 'index.php': 'index.php', 'books.php': 'books.php?id=1' });
  assert.deepEqual(pageUrls({ def: {} }, ['index.php']), { 'index.php': 'index.php' });
  assert.match(fs.readFileSync(path.join(PLUGIN, 'templates', 'perf', 'k6-pages.js'), 'utf8'), /URLS\[page\] \|\| page/, 'the k6 script requests that address');
  assert.equal(isGuarded(inv.pages.find((p) => p.path === 'cart.php'), ['login.php']), true);
  assert.deepEqual(publicPages(inv, []).sort(), ['index.php', 'login.php'], 'own check + redirect within 3 lines counts without login paths');
  assert.match(summaryMarkdown({ pages: ['a'], scenarios: [], slow_queries: [], long_query_time_s: 0.1 }), /None slower than 0\.1 s\./);
});

test('scanner normalizers turn real Semgrep, Psalm and ZAP output into one finding shape', () => {
  const s = normalizeSemgrep(json('security/semgrep.json'));
  assert.equal(s.length, 3);
  for (const f of s) assert.ok(f.rule && f.file && !f.file.startsWith('/src/') && Number.isInteger(f.line) && ['high', 'medium', 'low'].includes(f.severity));
  const p = normalizePsalm(json('security/psalm.json'));
  assert.equal(p.length, 3);
  assert.ok(p.every((f) => f.tool === 'psalm' && /^Tainted/.test(f.rule) && f.severity === 'high' && !f.file.startsWith('/src/')));
  const z = normalizeZap(json('security/zap.json'));
  assert.deepEqual(z.map((f) => f.severity), ['high', 'medium', 'medium']);
  assert.ok(z.every((f) => f.url.every((u) => u.startsWith('/'))), 'ZAP URLs are reduced to paths');
  assert.deepEqual(normalizeSemgrep({}), []);
  assert.deepEqual(normalizePsalm(null), []);
});

test('baseline comparison marks only findings that were not there before', () => {
  const f = normalizeSemgrep(json('security/semgrep.json'));
  const marked = compareBaseline(f, [fingerprint(f[0]), fingerprint(f[1])]);
  assert.deepEqual(marked.map((x) => x.new), [false, false, true]);
  assert.deepEqual(compareBaseline(f, null).map((x) => x.new), [true, true, true]);
  // ZAP's affected-URL list is a sample that changes per run: the alert is identified by its rule (2026-11-10: 11 of
  // 21 alerts showed as "new" only because books.php?id=3 became ?id=9)
  assert.equal(fingerprint({ tool: 'zap', rule: '10202', url: ['/a', '/b'] }), 'zap|10202|||');
  const zapNow = [{ tool: 'zap', rule: '10038', url: ['/mini-shop/books.php?id=9'] }, { tool: 'zap', rule: '99999', url: ['/x'] }];
  assert.deepEqual(compareBaseline(zapNow, ['zap|10038|||/mini-shop/books.php?id=3']).map((x) => x.new), [false, true], 'an old baseline entry with a URL sample still matches; a new rule is new');
});

test('zapTarget scans the app service inside the target compose network', () => {
  const { root } = tempProject();
  assert.deepEqual(zapTarget(loadTarget(root, 'mini-shop')), { network: 'rqa-mini-shop_default', url: 'http://web/' });
});

test('second opinion: references parse file:line forms; matching corroborates within 5 lines', () => {
  const text = 'Found SQL injection in `login.php` line 39 and in admin/comment.php:14. Also see includes/header.php:4.';
  assert.deepEqual(references(text), [
    { file: 'login.php', line: 39 },
    { file: 'admin/comment.php', line: 14 },
    { file: 'includes/header.php', line: 4 },
  ]);
  const findings = [
    { id: 'F-001', root_cause: 'login.php:36 "addslashes"', evidence: '' },
    { id: 'F-002', root_cause: 'admin/index.php:8', evidence: '' },
  ];
  const scanner = [{ tool: 'psalm', rule: 'TaintedSql', file: 'admin/comment.php', line: 13 }];
  assert.deepEqual(matchSecondOpinion(text, findings, scanner), {
    corroborated: [{ id: 'F-001', at: 'login.php:39' }],
    single_source: [{ id: 'F-002' }],
    second_opinion_only: [
      { at: 'admin/comment.php:14', also_flagged_by: ['psalm:TaintedSql'] },
      { at: 'includes/header.php:4', also_flagged_by: [] },
    ],
  });
});

test('second opinion prepare: a git repo whose only content is one pending change, binaries left out', () => {
  const { root } = tempProject();
  const t = loadTarget(root, 'mini-shop');
  const p = prepare(t);
  assert.ok(p.files >= 9);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: p.dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(status.every((l) => l.startsWith('A ')), 'every file staged, nothing committed');
  assert.ok(status.some((l) => l.endsWith('admin/report.php')));
  assert.ok(!status.some((l) => l.endsWith('.md')), 'only code files');
});

test('upgrade diff: same, different (with the first error after), and tests only one side ran', () => {
  const run = (outcome, extra = {}) => ({ project: 'chromium', file: 'a.spec.ts', title: 't', outcome, error: null, ...extra });
  const before = [run('passed'), run('passed', { title: 'u' }), run('passed', { title: 'gone' })];
  const after = [run('passed'), run('failed', { title: 'u', error: 'Error: PHP Deprecated\nmore' }), run('passed', { title: 'new' })];
  const d = diffRuns(before, after);
  assert.equal(d.same, 1);
  assert.deepEqual(d.different, [{ title: 'u', file: 'a.spec.ts', project: 'chromium', before: 'passed', after: 'failed', error_after: 'Error: PHP Deprecated' }]);
  assert.deepEqual(d.only_before, ['chromium › a.spec.ts › gone']);
  assert.deepEqual(d.only_after, ['chromium › a.spec.ts › new']);
  const md = compareMarkdown({ ...d, before_label: 'web', after_label: 'web-php8', php_log: { before: { fatal: 0, warning: 1 }, after: { fatal: 0, warning: 3 } } });
  assert.match(md, /# Upgrade comparison: web → web-php8/);
  assert.match(md, /\| warning \| 1 \| 3 \|/);
});

test('firstError picks the PHP fatal over the framework watcher header', () => {
  assert.equal(
    firstError('Error: PHP fatal error during the test:\n[10-Nov-2026 03:41:02 UTC] PHP Fatal error:  Uncaught mysqli_sql_exception: You have an error in your SQL syntax'),
    'PHP Fatal error:  Uncaught mysqli_sql_exception: You have an error in your SQL syntax',
  );
  assert.equal(firstError('Error: expect(received).toBe(expected)\nmore'), 'Error: expect(received).toBe(expected)');
  assert.equal(firstError(null), null);
});

test('the chunk-7 CLIs print usage and exit 1 without a target', () => {
  for (const s of ['run-perf/perf.mjs', 'run-security-scans/security.mjs', 'security-second-opinion/second.mjs', 'run-upgrade-compare/compare.mjs']) assert.equal(runNode(path.join(PLUGIN, 'skills', s), []).status, 1, s);
});

test('run-upgrade-compare explains a missing report instead of guessing', () => {
  const { root } = tempProject();
  const r = runNode(path.join(PLUGIN, 'skills', 'run-upgrade-compare', 'compare.mjs'), ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /report\.json not found: run with --run/);
});

test('run-perf keeps the latest result of every scenario: a load run does not erase the smoke result', () => {
  const smoke = { name: 'smoke', p95_ms: 14 };
  const oldLoad = { name: 'load', p95_ms: 9 };
  const newLoad = { name: 'load', p95_ms: 6.5 };
  assert.deepEqual(mergeScenarios([smoke, oldLoad], [newLoad]), [smoke, newLoad]);
  assert.deepEqual(mergeScenarios([], [smoke]), [smoke]);
});
