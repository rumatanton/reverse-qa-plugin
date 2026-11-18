#!/usr/bin/env node
// build-report: one self-contained page (output/report.html) built only from the output files, so every number on it
// can be traced to a file. Numbers carry data-metric attributes; the tests check them against coverage.json.
// A section whose input does not exist yet says "not run yet" instead of inventing a number.
//   node report.mjs --target <name> [--report <playwright-report.json>]     exit 0 = written, 1 = error
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, readLedger, appendLedger } from '../../lib/ledger.mjs';
import { parseCsv, toCsv } from '../../lib/csv.mjs';
import { readReport, flatten, outcomeCounts } from '../../lib/pwreport.mjs';
import { defaultReport } from '../coverage-report/coverage.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SEVERITY = ['critical', 'high', 'medium', 'low'];

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Counts from a node:test JUnit file (the plugin's own tests): { passed, failed, skipped } or null. */
export function junitCounts(xml) {
  if (!xml) return null;
  const cases = xml.match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g) ?? [];
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    if (/<failure\b/.test(c)) failed++;
    else if (/<skipped\b/.test(c)) skipped++;
  }
  return { passed: cases.length - failed - skipped, failed, skipped };
}

/** One row per kind of test, from every report that exists. Playwright rows are split by tier tag. */
export function testTypeRows(d) {
  const rows = [];
  const add = (type, list) => {
    if (!list?.length) return;
    const c = outcomeCounts(list);
    rows.push({ type, passed: c.passed + c['known-defect'] + c.flaky, failed: c.failed + c['fixed-defect'], skipped: c.skipped, known: c['known-defect'], flaky: c.flaky });
  };
  add('Framework unit (helpers)', d.suites?.unit);
  add('Framework self-tests (fixtures vs the app)', d.suites?.selftest);
  const tierName = { smoke: 'Playwright smoke (pages load)', api: 'API (HTTP, no browser)', a11y: 'Accessibility (axe-core)', authz: 'Authorization (role matrix)', authn: 'Authentication', flow: 'UI flows', e2e: 'End-to-end journeys', integration: 'Integration (payment stub)', db: 'Database', visual: 'Visual', char: 'Characterization' };
  const byTier = new Map();
  for (const r of d.rows ?? []) {
    const t = r.tiers.includes('e2e') ? 'e2e' : r.tiers[0] ?? 'other';
    byTier.set(t, [...(byTier.get(t) ?? []), r]);
  }
  for (const [t, list] of [...byTier.entries()].sort()) add(tierName[t] ?? `Other (${t})`, list);
  add('PHP 8.2 copy (same suite)', d.suites?.upgrade);
  add('Firefox, WebKit, phone', d.suites?.browsers);
  if (d.pluginTests) rows.push({ type: 'reverse-qa plugin tests (node:test)', ...d.pluginTests, known: 0, flaky: 0 });
  return rows;
}

// ---- the test dashboard: one row per test that ran, of every kind, from the same files as the report ----

const decodeOnce = (s) =>
  String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[e.toLowerCase()]);
// node:test's JUnit reporter escapes a quote in a test name twice (`"` is written `&amp;quot;`), so one decoding
// leaves a literal &quot; in the name. A second pass undoes it; a name with no entity left is unchanged by it.
const xmlText = (s) => decodeOnce(decodeOnce(s));
const attr = (tag, name) => xmlText(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
const firstLine = (s) => (s ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 240) ?? '';
const cleanTitle = (t) => t.replace(/\s+@\S+/g, '').trim();

/** node:test JUnit test cases: { folder, name, status, ms, detail }. The folder under tests/ says what kind of test it is. */
export function junitCases(xml) {
  const out = [];
  for (const m of (xml ?? '').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = m[1];
    const body = m[3] ?? '';
    const file = attr(tag, 'file').replace(/\\/g, '/');
    const status = /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const failure = body.match(/<failure\b[^>]*message="([^"]*)"/)?.[1];
    out.push({ folder: file.match(/\/tests\/([^/]+)\//)?.[1] ?? 'other', name: attr(tag, 'name'), status, ms: Math.round(Number(attr(tag, 'time') || 0) * 1000), detail: status === 'failed' ? firstLine(xmlText(failure)) : '' });
  }
  return out;
}

const PLUGIN_SUITE = { unit: 'Unit', hooks: 'Hooks', contract: 'Contract (Docker)', integration: 'Integration (Docker)' };
const TIER_SUITE = { smoke: 'Smoke: every page loads', a11y: 'Accessibility (axe-core)', visual: 'Visual comparison', e2e: 'End-to-end journeys', flow: 'UI flows', authn: 'Authentication', char: 'Characterization' };

/** Where a Playwright row belongs on the dashboard: [group, suite, runner]. */
function playwrightPlace(r) {
  if (r.project === 'unit') return ['Playwright', 'Framework unit', 'Playwright'];
  if (r.project === 'selftest') {
    if (/database|db fixture|snapshot/i.test(r.title)) return ['Database', 'Framework self-tests', 'Playwright'];
    if (/blocked|gateway|stub/i.test(r.title)) return ['Integration', 'Framework self-tests', 'Playwright'];
    return ['Playwright', 'Framework self-tests', 'Playwright'];
  }
  const browser = ['firefox', 'webkit', 'mobile'].includes(r.project) ? ` (${r.project})` : '';
  if (r.tiers.includes('security')) return ['Security', 'Security tests', 'Playwright'];
  if (r.tiers.includes('integration')) return ['Integration', 'Payment gateway (stubbed)', 'Playwright'];
  if (r.tiers.includes('api')) return ['API', `HTTP endpoints${browser}`, 'Playwright request'];
  if (r.tiers.includes('authz')) return ['Authorization', `Role matrix${browser}`, 'Playwright request'];
  if (r.tiers.includes('db')) return ['Database', 'Database tests', 'Playwright'];
  const tier = r.tiers.includes('e2e') ? 'e2e' : r.tiers[0];
  return ['Playwright', `${TIER_SUITE[tier] ?? tier ?? 'Other'}${browser}`, 'Playwright'];
}

const PW_STATUS = { passed: 'passed', failed: 'failed', 'known-defect': 'known defect', 'fixed-defect': 'failed', flaky: 'flaky', skipped: 'skipped' };

/**
 * Every test that ran, one row each: { group, suite, test, runner, browser, status, ms, detail }. status is passed,
 * failed, known defect (a test.fail() documenting a confirmed finding, which is expected to fail), flaky or skipped.
 */
export function dashboardRows(d) {
  const rows = [];
  const pw = (list, override) => {
    for (const r of list ?? []) {
      const [group, suite, runner] = override ? override(r) : playwrightPlace(r);
      rows.push({ group, suite, test: cleanTitle(r.title), runner, browser: ['unit', 'selftest'].includes(r.project) ? '' : r.project, status: PW_STATUS[r.outcome], ms: Math.round(r.duration ?? 0), detail: r.outcome === 'passed' ? '' : firstLine(r.error) });
    }
  };
  pw(d.suites?.unit);
  pw(d.suites?.selftest);
  pw(d.rows);
  pw(d.suites?.browsers);
  pw(d.suites?.visual);
  pw(d.suites?.upgrade, (r) => ['Upgrade (PHP 8.2)', `Same suite on PHP 8.2: ${playwrightPlace(r)[1]}`, 'Playwright']);
  for (const s of d.perf?.scenarios ?? []) {
    rows.push({ group: 'Performance (k6)', suite: `k6 ${s.name}`, test: `${s.name}: thresholds on p95 and error rate`, runner: 'k6', browser: '', status: s.thresholds_passed ? 'passed' : 'failed', ms: 0, detail: `${s.requests} requests, p95 ${s.p95_ms} ms, errors ${s.error_rate_pct}%${s.failed_thresholds?.length ? `; failed: ${s.failed_thresholds.join(', ')}` : ''}` });
  }
  const toolName = { semgrep: 'Semgrep', psalm: 'Psalm taint analysis', zap: 'ZAP passive baseline' };
  for (const t of d.security?.tools ?? []) {
    const judged = typeof t.new === 'number';
    rows.push({ group: 'Security', suite: 'Scanners vs the baseline', test: `${toolName[t.tool] ?? t.tool}: no new findings`, runner: toolName[t.tool] ?? t.tool, browser: '', status: t.ran === false || !judged || t.new > 0 ? 'failed' : 'passed', ms: Math.round((t.seconds ?? 0) * 1000), detail: t.ran === false ? 'did not run' : judged ? `${t.new} new, ${t.findings} known in the baseline` : 'no baseline recorded yet' });
  }
  for (const c of d.pluginCases ?? []) {
    const group = c.folder === 'behavior' ? 'Agents (behavior)' : 'reverse-qa plugin';
    rows.push({ group, suite: group === 'Agents (behavior)' ? 'Subagents on the fixture app' : PLUGIN_SUITE[c.folder] ?? c.folder, test: c.name, runner: 'node:test', browser: '', status: c.status, ms: c.ms, detail: c.detail });
  }
  return rows.map((r, i) => ({ id: String(i + 1).padStart(4, '0'), ...r })); // id: the dashboard table's row key
}

/** One row per bug report written from a confirmed finding, with its Jira key once filed. */
export function bugRows(bugsDoc, jiraKeys = {}) {
  return (bugsDoc?.bugs ?? []).map((b) => ({ bug: b.id, finding: b.finding_id, severity: b.severity, priority: b.priority, summary: b.summary, jira: jiraKeys[b.id] ?? '', filed: jiraKeys[b.id] ? 'yes' : 'no' }));
}

export const DASHBOARD_COLUMNS = ['id', 'group', 'suite', 'test', 'runner', 'browser', 'status', 'ms', 'detail'];
export const BUG_COLUMNS = ['bug', 'finding', 'severity', 'priority', 'summary', 'jira', 'filed'];

const W = 520;
/** One 100%-stacked bar per row; failed segments also carry a hatch so identity never rests on color alone. */
export function resultsChart(rows) {
  if (rows.length === 0) return notRun('Test runs');
  const rowH = 30;
  const label = 300;
  const h = rows.length * rowH + 10;
  const bars = rows
    .map((r, i) => {
      const total = r.passed + r.failed + r.skipped || 1;
      let x = label;
      const y = i * rowH + 6;
      const segs = [
        ['passed', r.passed, 'var(--ok)', ''],
        ['failed', r.failed, 'var(--bad)', 'url(#hatch)'],
        ['skipped', r.skipped, 'var(--skip)', ''],
      ]
        .filter(([, n]) => n > 0)
        .map(([name, n, fill, pattern]) => {
          const w = Math.max(2, (n / total) * W - 2);
          const seg = `<g><title>${esc(r.type)}: ${n} ${name}</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="18" rx="4" fill="${fill}"/>${pattern ? `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="18" rx="4" fill="${pattern}"/>` : ''}${w > 26 ? `<text x="${(x + w / 2).toFixed(1)}" y="${y + 13}" text-anchor="middle" class="seg">${n}</text>` : ''}</g>`;
          x += w + 2;
          return seg;
        })
        .join('');
      return `<text x="0" y="${y + 13}" class="lbl">${esc(r.type)}</text>${segs}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${label + W + 10} ${h}" width="100%" role="img" aria-label="Passed, failed and skipped tests per test type">
<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,.55)" stroke-width="2"/></pattern></defs>${bars}</svg>
<p class="legend"><span class="sw ok"></span>✓ passed (incl. documented defects) <span class="sw bad"></span>✗ failed <span class="sw skip"></span>– skipped (waiting for an input; each skip names its reason)</p>
<table><thead><tr><th>Test type</th><th>✓ Passed</th><th>✗ Failed</th><th>– Skipped</th><th>Documented defects</th><th>Flaky</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.type)}</td><td>${num(`tests.${r.type}.passed`, r.passed)}</td><td>${num(`tests.${r.type}.failed`, r.failed)}</td><td>${r.skipped}</td><td>${r.known}</td><td>${r.flaky}</td></tr>`)
    .join('')}</tbody></table>`;
}

/** Checks that are not test counts: security gate, performance thresholds, upgrade, coverage. */
export function gatesTable(d) {
  const rows = [];
  for (const t of d.security?.tools ?? []) rows.push([`Security: ${t.tool}`, t.ran === false ? '✗ did not run' : t.new === 0 ? '✓ no new findings' : t.new === 'no baseline' ? '– no baseline yet' : `✗ ${t.new} new`, `${t.findings ?? 0} findings in the baseline set`]);
  for (const s of d.perf?.scenarios ?? []) rows.push([`Performance: k6 ${s.name}`, s.thresholds_passed ? '✓ thresholds met' : '✗ thresholds failed', `${s.requests} requests, p95 ${s.p95_ms} ms, errors ${s.error_rate_pct}%`]);
  if (d.upgrade) rows.push(['Upgrade: PHP 7.2 → 8.2', d.upgrade.different?.length ? `✗ ${d.upgrade.different.length} differ` : '✓ same', `${d.upgrade.same} tests behave the same`]);
  if (d.coverage?.pages) rows.push(['Coverage: pages', d.coverage.pages.covered === d.coverage.pages.total ? '✓ 100%' : `– ${d.coverage.pages.pct}%`, `${d.coverage.pages.covered}/${d.coverage.pages.total} pages exercised`]);
  if (rows.length === 0) return '';
  return `<h3>Quality gates</h3><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function loadReportInputs(target, reportFile) {
  const out = outputDir(target.dir);
  const json = (rel) => (fs.existsSync(path.join(out, rel)) ? JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8')) : null);
  const csv = (rel) => (fs.existsSync(path.join(out, rel)) ? parseCsv(fs.readFileSync(path.join(out, rel), 'utf8')) : null);
  const results = path.join(target.dir, 'framework', 'test-results');
  const suite = (name) => (fs.existsSync(path.join(results, `${name}.json`)) ? flatten(readReport(path.join(results, `${name}.json`))) : null);
  const junit = path.join(PLUGIN_ROOT, 'test-results', 'junit.xml');
  return {
    suites: { unit: suite('unit'), selftest: suite('selftest'), upgrade: suite('upgrade-report'), browsers: suite('browsers'), visual: suite('visual') },
    pluginTests: fs.existsSync(junit) ? junitCounts(fs.readFileSync(junit, 'utf8')) : null,
    pluginCases: [junit, path.join(PLUGIN_ROOT, 'test-results', 'behavior-junit.xml')].filter((f) => fs.existsSync(f)).flatMap((f) => junitCases(fs.readFileSync(f, 'utf8'))),
    bugs: json('bugs/bugs.json'),
    jiraBugKeys: json('bugs/jira-bug-keys.json') ?? {},
    target: target.name,
    commit: target.def.commit ?? null,
    inventory: json('inventory.json'),
    coverage: json('coverage.json'),
    triage: json('triage.json'),
    perf: json('perf/perf-summary.json'),
    security: json('security/summary.json'),
    upgrade: json('upgrade/upgrade-diff.json'),
    findings: csv('findings.csv'),
    rtm: csv('rtm.csv'),
    rows: fs.existsSync(reportFile) ? flatten(readReport(reportFile)) : null,
    ledger: readLedger(target.dir),
  };
}

const notRun = (what) => `<p class="muted">${esc(what)}: not run yet.</p>`;
const num = (metric, value) => `<b data-metric="${esc(metric)}">${esc(value)}</b>`;

function coverageSection(c) {
  if (!c) return notRun('Coverage');
  const rows = [
    ['pages', 'Pages exercised'],
    ['cells', 'Role-matrix cells'],
    ['requirements_designed', 'Requirements with a test case'],
    ['requirements_automated', 'Requirements automated and run'],
    ['p1_automated', 'P1 requirements automated'],
  ].map(([k, label]) =>
    c[k]
      ? `<tr><td>${label}</td><td>${num(`${k}.covered`, c[k].covered)} / ${num(`${k}.total`, c[k].total)}</td><td>${num(`${k}.pct`, c[k].pct ?? '-')}%</td><td>${esc(c[k].gaps.slice(0, 8).join(', '))}${c[k].gaps.length > 8 ? ' …' : ''}</td></tr>`
      : `<tr><td>${label}</td><td colspan="3" class="muted">not measured</td></tr>`,
  );
  return `<table><thead><tr><th>Measure</th><th>Covered</th><th>%</th><th>Gaps</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function resultsSection(rows) {
  if (!rows) return notRun('Test run');
  const c = outcomeCounts(rows);
  const byTier = {};
  for (const r of rows) for (const t of r.tiers.length ? r.tiers : ['untagged']) {
    byTier[t] ??= outcomeCounts([]);
    byTier[t][r.outcome]++;
  }
  const head = `<p>${num('results.total', rows.length)} test runs: ${num('results.passed', c.passed)} passed, ${num('results.failed', c.failed)} failed, ${num('results.known-defect', c['known-defect'])} documented defects (test.fail()), ${num('results.flaky', c.flaky)} flaky, ${num('results.skipped', c.skipped)} skipped.</p>`;
  const tiers = Object.entries(byTier)
    .sort()
    .map(([t, x]) => `<tr><td>${esc(t)}</td><td>${x.passed}</td><td>${x.failed}</td><td>${x['known-defect']}</td><td>${x.flaky}</td><td>${x.skipped}</td></tr>`)
    .join('');
  return `${head}<table><thead><tr><th>Tier</th><th>Passed</th><th>Failed</th><th>Documented defect</th><th>Flaky</th><th>Skipped</th></tr></thead><tbody>${tiers}</tbody></table>`;
}

function findingsSection(findings) {
  if (!findings) return notRun('Findings');
  const counts = Object.fromEntries(SEVERITY.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const top = [...findings].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || a.id.localeCompare(b.id)).slice(0, 15);
  return `<p>${SEVERITY.map((s) => `${num(`findings.${s}`, counts[s])} ${s}`).join(' · ')} (${num('findings.total', findings.length)} total)</p>
<table><thead><tr><th>ID</th><th>Title</th><th>Severity</th><th>Status</th><th>Root cause</th></tr></thead><tbody>${top
    .map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.title)}</td><td>${esc(f.severity)}</td><td>${esc(f.status)}</td><td>${esc(f.root_cause)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function triageSection(t) {
  if (!t) return notRun('Failure triage');
  return `<p>${Object.entries(t.summary).map(([k, v]) => `${num(`triage.${k}`, v)} ${esc(k)}`).join(' · ')} · ${num('triage.flaky', t.flaky.length)} flaky</p>`;
}

function perfSection(p) {
  if (!p) return notRun('Performance (k6)');
  const rows = (p.scenarios ?? []).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.p95_ms)}</td><td>${esc(s.error_rate_pct)}%</td><td>${s.thresholds_passed ? 'pass' : 'FAIL'}</td></tr>`).join('');
  return `<p class="muted">A baseline measured on one laptop, not a capacity figure.</p><table><thead><tr><th>Scenario</th><th>p95 (ms)</th><th>Errors</th><th>Thresholds</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function securitySection(s) {
  if (!s) return notRun('Security scans');
  return `<table><thead><tr><th>Tool</th><th>Findings</th><th>New vs baseline</th></tr></thead><tbody>${(s.tools ?? [])
    .map((t) => `<tr><td>${esc(t.tool)}</td><td>${esc(t.findings)}</td><td>${esc(t.new)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function upgradeSection(u) {
  if (!u) return notRun('PHP upgrade comparison');
  return `<p>${num('upgrade.same', u.same ?? 0)} tests behave the same on both versions, ${num('upgrade.different', u.different?.length ?? 0)} differ.</p>${
    u.different?.length ? `<ul>${u.different.slice(0, 15).map((d) => `<li>${esc(d.title)}: ${esc(d.before)} → ${esc(d.after)}</li>`).join('')}</ul>` : ''
  }`;
}

export function renderReport(d) {
  const inv = d.inventory?.summary;
  const asOf = d.ledger.at(-1)?.ts ?? 'no runs recorded';
  const steps = [...new Map(d.ledger.map((e) => [e.step, e.ts])).entries()];
  const appLine = inv
    ? `${num('inventory.pages', inv.pages)} pages, ${num('inventory.tables', inv.tables)} tables, ${num('inventory.sql', inv.sql_statements)} SQL statements, ${num('inventory.forms', inv.forms)} forms, session keys ${esc(inv.session_keys.join(', '))}, outbound hosts ${esc(inv.outbound_hosts.join(', ') || 'none')}`
    : 'not scanned yet';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>reverse-qa report: ${esc(d.target)}</title>
<style>
:root{--bg:#f6f7f8;--fg:#15202b;--muted:#5b6670;--line:#d9dee2;--card:#fff;--accent:#a8520c;--ok:#0ca30c;--bad:#d03b3b;--skip:#898781}
@media (prefers-color-scheme:dark){:root{--bg:#10171c;--fg:#e4e9ed;--muted:#98a5ae;--line:#26323b;--card:#161f26;--accent:#e08a3c}}
svg .lbl{font-size:12.5px;fill:var(--fg)}svg .seg{font-size:11px;font-weight:600;fill:#fff}.legend{font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-1px}.sw.ok{background:var(--ok)}.sw.bad{background:var(--bad);background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.55) 0 2px,transparent 2px 6px)}.sw.skip{background:var(--skip)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
h1{margin:0;font-size:28px}h2{margin:0 0 8px;font-size:19px;border-top:2px solid var(--fg);padding-top:10px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.muted{color:var(--muted)}b[data-metric]{color:var(--accent)}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
</style></head><body><main>
<header><h1>reverse-qa report: ${esc(d.target)}</h1>
<p class="muted">Commit <code>${esc(d.commit ?? 'unknown')}</code> · data as of ${esc(asOf)} · every figure below is read from <code>targets/${esc(d.target)}/output/</code></p></header>
<section><h2>The app</h2><p>${appLine}</p></section>
<section><h2>Results by test type</h2>${resultsChart(testTypeRows(d))}${gatesTable(d)}</section>
<section><h2>Coverage</h2>${coverageSection(d.coverage)}</section>
<section><h2>Test results</h2>${resultsSection(d.rows)}</section>
<section><h2>Findings</h2>${findingsSection(d.findings)}</section>
<section><h2>Failure triage</h2>${triageSection(d.triage)}</section>
<section><h2>Performance</h2>${perfSection(d.perf)}</section>
<section><h2>Security scans</h2>${securitySection(d.security)}</section>
<section><h2>Upgrade comparison</h2>${upgradeSection(d.upgrade)}</section>
<section><h2>How this was produced</h2><p>Deterministic scripts for every mechanical step; three subagents (tech-analyst, workflow-analyst, test-designer) for judgment, each checked by code; a person approves the requirements before any test is written. Steps recorded in <code>ledger.jsonl</code>:</p>
<table><thead><tr><th>Step</th><th>Last run</th></tr></thead><tbody>${steps.map(([s, ts]) => `<tr><td>${esc(s)}</td><td>${esc(ts)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">none yet</td></tr>'}</tbody></table></section>
</main></body></html>
`;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, report: { type: 'string' }, dashboard: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: report.mjs --target <name> [--report <playwright-report.json>]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const d = loadReportInputs(target, values.report ? path.resolve(values.report) : defaultReport(target));
    const file = writeOutput(target.dir, 'report.html', renderReport(d));
    const present = ['inventory', 'coverage', 'rows', 'findings', 'triage', 'perf', 'security', 'upgrade'].filter((k) => d[k]);
    appendLedger(target.dir, 'build-report', { sections_with_data: present });
    process.stdout.write(`build-report: ${file} (${present.length}/8 sections with data: ${present.join(', ') || 'none'})\n`);
    if (values.dashboard) {
      // the test dashboard's data: one row per test, and the bug reports written from confirmed findings
      const tests = dashboardRows(d);
      const bugs = bugRows(d.bugs, d.jiraBugKeys);
      writeOutput(target.dir, 'dashboard/tests.csv', toCsv(tests, DASHBOARD_COLUMNS));
      writeOutput(target.dir, 'dashboard/bugs.csv', toCsv(bugs, BUG_COLUMNS));
      const by = (k) => tests.filter((t) => t.status === k).length;
      process.stdout.write(`build-report: dashboard data: ${tests.length} tests (${by('passed')} passed, ${by('failed')} failed, ${by('known defect')} known defect, ${by('flaky')} flaky, ${by('skipped')} skipped), ${bugs.length} bug report(s), ${bugs.filter((b) => b.jira).length} filed in Jira\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`build-report: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
