#!/usr/bin/env node
// run-perf: k6 smoke and load runs on a target's key pages, with p95 and error-rate thresholds, plus the MariaDB slow
// query log captured during the run. Writes output/perf/perf-summary.json (read by build-report) and .md.
// A laptop baseline, not a capacity figure.
//   node perf.mjs --target <name> [--scenario smoke|load|both] [--duration 30s] [--vus 10] [--pages a.php,b.php]
//   exit 0 = thresholds met, 2 = a threshold failed, 1 = usage or setup problem
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { assertSafeUrls } from '../../lib/runtime.mjs';
import { execSql } from '../../lib/db.mjs';
import { compose } from '../../lib/docker.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { publicPages, loginPathsOf } from '../../lib/pages.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'perf', 'k6-pages.js');
const SLOW_LOG = '/var/lib/mysql/slow.log';

/** Pages to load: perf.pages in target.yaml, else up to 6 public pages from the inventory. */
export function pickPages(target, inventory, explicit) {
  if (explicit?.length) return explicit;
  if (target.def.perf?.pages?.length) return target.def.perf.pages;
  return publicPages(inventory, loginPathsOf(target.def)).slice(0, 6);
}

const ms = (v) => (v === undefined ? null : Math.round(v * 10) / 10);

/** The numbers that matter from a k6 handleSummary() document. */
export function parseK6Summary(name, data) {
  const m = data.metrics ?? {};
  const thresholds = Object.entries(m).flatMap(([metric, v]) => Object.entries(v.thresholds ?? {}).map(([expr, t]) => ({ metric, expr, ok: Boolean(t.ok) })));
  const perPage = Object.entries(m)
    .filter(([k]) => k.startsWith('http_req_duration{page:'))
    .map(([k, v]) => ({ page: k.slice('http_req_duration{page:'.length, -1), p95_ms: ms(v.values?.['p(95)']), avg_ms: ms(v.values?.avg) }))
    .sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0));
  return {
    name,
    requests: m.http_reqs?.values?.count ?? 0,
    p95_ms: ms(m.http_req_duration?.values?.['p(95)']),
    avg_ms: ms(m.http_req_duration?.values?.avg),
    max_ms: ms(m.http_req_duration?.values?.max),
    error_rate_pct: Math.round((m.http_req_failed?.values?.rate ?? 0) * 10000) / 100,
    thresholds_passed: thresholds.every((t) => t.ok),
    failed_thresholds: thresholds.filter((t) => !t.ok).map((t) => `${t.metric} ${t.expr}`),
    per_page: perPage,
  };
}

/** Parse a MySQL/MariaDB slow query log into entries, slowest first. */
export function parseSlowLog(text, top = 10) {
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const qt = line.match(/^# Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/);
    if (qt) {
      cur = { query_time_s: Number(qt[1]), rows_sent: Number(qt[3]), rows_examined: Number(qt[4]), statement: '' };
      entries.push(cur);
    } else if (cur && line.trim() && !line.startsWith('#') && !/^(SET timestamp=|use )/i.test(line.trim())) {
      cur.statement += `${cur.statement ? ' ' : ''}${line.trim()}`;
    }
  }
  return entries.filter((e) => e.statement).sort((a, b) => b.query_time_s - a.query_time_s).slice(0, top);
}

function k6Bin() {
  return process.env.K6_BIN || 'k6';
}

/**
 * The address k6 requests for each page: the page with the query a user arrives with (target.yaml page_params), so a
 * detail page is timed as a visitor sees it and not on its "no id" path. The result is still reported under the page.
 */
export function pageUrls(target, pages) {
  const params = target.def?.page_params ?? {};
  return Object.fromEntries(pages.map((p) => [p, params[p]?.query ? `${p}${p.includes('?') ? '&' : '?'}${params[p].query}` : p]));
}

export function runScenario(target, scenario, pages, { duration, vus }) {
  const summaryFile = path.join(outputDir(target.dir), 'perf', `k6-${scenario}.json`);
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  const thresholds = target.def.perf?.thresholds ?? {};
  const env = {
    ...process.env,
    BASE_URL: target.def.runtime.base_url,
    PAGES: JSON.stringify(pages),
    PAGE_URLS: JSON.stringify(pageUrls(target, pages)),
    SCENARIO: scenario,
    SUMMARY_FILE: summaryFile,
    ...(duration ? { DURATION: duration } : {}),
    LOAD_VUS: String(vus ?? thresholds.load_vus ?? 10),
    P95_MS: String(thresholds.p95_ms ?? 800),
    MAX_ERROR_RATE: String(thresholds.max_error_rate ?? 0.01),
  };
  const r = spawnSync(k6Bin(), ['run', '--quiet', '--no-color', SCRIPT], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`k6 not runnable (${r.error.code}): install k6 or set K6_BIN`);
  if (!fs.existsSync(summaryFile)) throw new Error(`k6 wrote no summary (exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`);
  return parseK6Summary(scenario, JSON.parse(fs.readFileSync(summaryFile, 'utf8')));
}

export function summaryMarkdown(s) {
  const lines = ['# Performance baseline', '', `Pages: ${s.pages.join(', ')}`, '', 'A baseline measured on one machine, not a capacity figure.', ''];
  for (const sc of s.scenarios) {
    lines.push(`## ${sc.name}: ${sc.requests} requests, p95 ${sc.p95_ms} ms, errors ${sc.error_rate_pct}% — thresholds ${sc.thresholds_passed ? 'met' : `FAILED (${sc.failed_thresholds.join('; ')})`}`, '');
    lines.push('| Page | p95 (ms) | avg (ms) |', '|---|---|---|', ...sc.per_page.map((p) => `| ${p.page} | ${p.p95_ms} | ${p.avg_ms} |`), '');
  }
  lines.push('## Slowest SQL during the runs', '');
  if (s.slow_queries.length === 0) lines.push(`None slower than ${s.long_query_time_s} s.`);
  for (const q of s.slow_queries) lines.push(`- ${q.query_time_s} s, ${q.rows_examined} rows examined: \`${q.statement.slice(0, 200)}\``);
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, scenario: { type: 'string' }, duration: { type: 'string' }, vus: { type: 'string' }, pages: { type: 'string' } } });
  if (!values.target) {
    process.stderr.write('usage: perf.mjs --target <name> [--scenario smoke|load|both] [--duration 30s] [--vus 10] [--pages a.php,b.php]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    assertSafeUrls(target.def, [target.def.runtime?.base_url]);
    const invFile = path.join(outputDir(target.dir), 'inventory.json');
    const inventory = fs.existsSync(invFile) ? JSON.parse(fs.readFileSync(invFile, 'utf8')) : null;
    const pages = pickPages(target, inventory, values.pages?.split(',').map((p) => p.trim()).filter(Boolean));
    if (pages.length === 0) throw new Error('no pages to load: run scan-repo, or list perf.pages in target.yaml');
    const longQuery = target.def.perf?.long_query_time_s ?? 0.1;
    const db = target.def.runtime?.services?.db ?? 'db';
    execSql(target, `SET GLOBAL slow_query_log = 1; SET GLOBAL long_query_time = ${Number(longQuery)}; SET GLOBAL slow_query_log_file = '${SLOW_LOG}';`, { database: false });
    compose(target, ['exec', '-T', db, 'sh', '-c', `: > ${SLOW_LOG}`]);
    const scenarios = (values.scenario === 'both' ? ['smoke', 'load'] : [values.scenario ?? 'smoke']).map((sc) => runScenario(target, sc, pages, { duration: values.duration, vus: values.vus && Number(values.vus) }));
    const slow = compose(target, ['exec', '-T', db, 'cat', SLOW_LOG]);
    // keep the other scenarios' latest results: a load run must not erase the smoke result (and the other way round)
    const file = path.join(outputDir(target.dir), 'perf', 'perf-summary.json');
    const earlier = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).scenarios ?? [] : [];
    const summary = { pages, scenarios: mergeScenarios(earlier, scenarios), long_query_time_s: longQuery, slow_queries: parseSlowLog(slow.stdout ?? '') };
    writeOutput(target.dir, 'perf/perf-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
    writeOutput(target.dir, 'perf/perf-summary.md', summaryMarkdown(summary));
    appendLedger(target.dir, 'run-perf', { pages: pages.length, scenarios: scenarios.map((s) => ({ name: s.name, p95_ms: s.p95_ms, error_rate_pct: s.error_rate_pct, passed: s.thresholds_passed })), slow_queries: summary.slow_queries.length });
    for (const s of scenarios) process.stdout.write(`run-perf: ${s.name}: ${s.requests} requests on ${pages.length} pages, p95 ${s.p95_ms} ms, errors ${s.error_rate_pct}%, thresholds ${s.thresholds_passed ? 'met' : `FAILED: ${s.failed_thresholds.join('; ')}`}\n`);
    process.stdout.write(`run-perf: ${summary.slow_queries.length} statement(s) slower than ${longQuery} s; output/perf/perf-summary.md\n`);
    return scenarios.every((s) => s.thresholds_passed) ? 0 : 2;
  } catch (err) {
    process.stderr.write(`run-perf: ${err.message}\n`);
    return 1;
  }
}

/** The latest result per scenario: this run's scenarios replace earlier ones of the same name, the rest are kept. */
export function mergeScenarios(earlier, now) {
  return [...earlier.filter((e) => !now.some((s) => s.name === e.name)), ...now];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
