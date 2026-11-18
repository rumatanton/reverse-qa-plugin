// Read a Playwright JSON report (reporter "json") into a flat list of executed tests with their traceability tags:
//   @TC-AUTH-001        the test case it automates (cases.yaml)
//   @page:admin/x.php   the page it exercises         @role:Visitor   the role it runs as   (role-matrix cells)
//   @p1 @smoke @authz   priority and tier             F-012           a finding it documents (test.fail())
import fs from 'node:fs';

export function readReport(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Specs with the file they belong to, from nested suites. */
export function walkSpecs(suites, out = [], file = null) {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? []) out.push({ ...spec, file: spec.file ?? s.file ?? file });
    walkSpecs(s.suites, out, s.file ?? file);
  }
  return out;
}

const tagText = (spec) => [spec.title ?? '', ...(spec.tags ?? [])].join(' ');
const uniq = (a) => [...new Set(a)];

export function tagsOf(spec) {
  const text = tagText(spec);
  return {
    cases: uniq(text.match(/TC-[A-Z]+-\d{3}/g) ?? []),
    findings: uniq(text.match(/\bF-\d{3}\b/g) ?? []),
    pages: uniq([...text.matchAll(/@page:(\S+)/g)].map((m) => m[1])),
    roles: uniq([...text.matchAll(/@role:(\S+)/g)].map((m) => m[1])),
    priority: (text.match(/@(p[123])\b/i)?.[1] ?? '').toUpperCase() || null,
    tiers: uniq([...text.matchAll(/@(smoke|page|api|flow|integration|roles|authn|authz|e2e|char|db|a11y|visual|perf|security|upgrade)(?![\w:-])/g)].map((m) => m[1])),
  };
}

// A test Playwright reports as skipped with no skip annotation was never started: an earlier test in its serial group
// failed, or the run was stopped. That is a consequence of a failure, not a test.skip() in the code.
export const NOT_RUN = 'not run: an earlier test in its serial group failed, or the run was stopped';

/**
 * One row per (spec, project) run:
 *   outcome: passed | failed | known-defect (test.fail() failing as expected) | fixed-defect (test.fail() that passed) | flaky | skipped
 */
export function flatten(report) {
  const rows = [];
  for (const spec of walkSpecs(report.suites)) {
    const tags = tagsOf(spec);
    for (const t of spec.tests ?? []) {
      const last = t.results?.at(-1) ?? {};
      let outcome;
      if (t.status === 'skipped') outcome = 'skipped';
      else if (t.status === 'flaky') outcome = 'flaky';
      else if (t.expectedStatus === 'failed') outcome = t.status === 'expected' ? 'known-defect' : 'fixed-defect';
      else outcome = t.status === 'expected' ? 'passed' : 'failed';
      const skips = [...(t.annotations ?? []), ...(last.annotations ?? [])].filter((a) => a.type === 'skip' || a.type === 'fixme');
      const skip = skips.find((a) => a.description);
      rows.push({
        file: spec.file,
        title: spec.title,
        line: spec.line ?? null,
        project: t.projectName ?? 'default',
        outcome,
        skipReason: outcome === 'skipped' ? skip?.description ?? (skips.length ? 'no reason given' : NOT_RUN) : null,
        error: last.error?.message ?? (last.errors ?? [])[0]?.message ?? null,
        startTime: last.startTime ?? null,
        duration: last.duration ?? 0,
        attachments: (last.attachments ?? []).map((a) => ({ name: a.name, path: a.path ?? null, contentType: a.contentType })),
        ...tags,
      });
    }
  }
  return rows;
}

/** Counts by outcome. */
export function outcomeCounts(rows) {
  const c = { passed: 0, failed: 0, 'known-defect': 0, 'fixed-defect': 0, flaky: 0, skipped: 0 };
  for (const r of rows) c[r.outcome]++;
  return c;
}

/**
 * Why tests were skipped, most common first: [{ reason, count }]. Page names are folded out so one missing input
 * (no role matrix, no test account) shows as one line, not one line per page.
 */
export function skipReasons(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.outcome !== 'skipped') continue;
    const reason = (r.skipReason ?? 'no reason given').replace(/\S+\.php\b/g, '<page>');
    by.set(reason, (by.get(reason) ?? 0) + 1);
  }
  return [...by].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ---- results that automate a case without its id in the title (cases.yaml `covers`) ----
// The template tiers make one test per page and role, and k6 is not a Playwright test at all, so their results carry
// no @TC tag. A case names them instead: every word of a selector must be true of one result. A word is a tag in the
// test's title (@a11y, @page:login.php, @role:Visitor), a browser (project:firefox), or a k6 scenario (k6:load).
export const COVERS_WORD = /^(@[\w:./-]+|project:[\w-]+|k6:[\w-]+)$/;

const wordsOf = (row) => new Set([...String(row.title ?? '').split(/\s+/), `project:${row.project ?? 'default'}`]);

/** Ids of the cases whose `covers` selects this result ({ title, project }). */
export function coveringCases(row, cases) {
  const words = wordsOf(row);
  const ids = [];
  for (const c of cases ?? []) {
    if ([c.covers ?? []].flat().some((sel) => String(sel).split(/\s+/).filter(Boolean).every((w) => words.has(w)))) ids.push(c.id);
  }
  return ids;
}

/**
 * Add each covering case's id to the results it selects. Returns { rows, unmatched }: new rows, and the selectors that
 * selected no result that ran (a wrong selector must not read as coverage), as [{ case, selector }].
 */
export function linkCovers(rows, cases) {
  const list = cases ?? [];
  const out = (rows ?? []).map((r) => ({ ...r, cases: [...new Set([...(r.cases ?? []), ...coveringCases(r, list)])] }));
  const ran = out.filter((r) => r.outcome !== 'skipped').map(wordsOf);
  const unmatched = [];
  for (const c of list) {
    for (const sel of [c.covers ?? []].flat()) {
      const words = String(sel).split(/\s+/).filter(Boolean);
      if (!ran.some((have) => words.every((w) => have.has(w)))) unmatched.push({ case: c.id, selector: String(sel) });
    }
  }
  return { rows: out, unmatched };
}

/**
 * k6 results as rows a case can select: one per scenario (`k6:load`), and one per scenario and page
 * (`k6:load @perf @page:index.php`). A page row passes when its p95 is within the limit and the scenario's own
 * thresholds held. `thresholds` is target.yaml perf.thresholds.
 */
export function perfRows(perf, thresholds = {}) {
  const rows = [];
  const base = { file: 'k6', line: null, project: 'k6', skipReason: null, error: null, startTime: null, duration: 0, attachments: [], cases: [], findings: [], roles: [], priority: null, tiers: ['perf'] };
  for (const s of perf?.scenarios ?? []) {
    const ok = s.thresholds_passed !== false;
    rows.push({ ...base, title: `k6:${s.name} @perf`, pages: [], outcome: ok ? 'passed' : 'failed' });
    for (const p of s.per_page ?? []) {
      const within = thresholds.p95_ms === undefined || p.p95_ms <= thresholds.p95_ms;
      rows.push({ ...base, title: `k6:${s.name} @perf @page:${p.page}`, pages: [p.page], outcome: ok && within ? 'passed' : 'failed', error: within ? null : `p95 ${p.p95_ms} ms is over the limit of ${thresholds.p95_ms} ms` });
    }
  }
  return rows;
}
