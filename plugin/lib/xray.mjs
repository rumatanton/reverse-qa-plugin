// Xray formats. test-designer writes one canonical file (output/test-cases/cases.yaml); everything Xray reads is
// rendered from it here, deterministically: the Xray Cloud bulk-import JSON, Gherkin .feature files, the Test Case
// Importer CSV, and execution results (Xray JSON) from a Playwright JSON report.
// Format source: Xray's official Postman collection (Xray-App/xray-postman-collections), checked 2026-11-09:
//   POST /api/v2/import/test/bulk  [{ testtype, fields: { summary, project: { key } }, steps[{action,data,result}] |
//   gherkin_def | unstructured_def, update: { issuelinks: [{ add: { type: { name: "Test" }, outwardIssue: { key } } }] } }]
import crypto from 'node:crypto';
import { toCsv } from './csv.mjs';
import { walkSpecs, coveringCases, COVERS_WORD } from './pwreport.mjs';

export const PRIORITIES = ['P1', 'P2', 'P3'];
export const TIERS = ['smoke', 'page', 'api', 'flow', 'integration', 'roles', 'authn', 'authz', 'e2e', 'char', 'db', 'a11y', 'visual', 'perf', 'security', 'upgrade'];
export const TECHNIQUES = ['equivalence-partitioning', 'boundary-value', 'decision-table', 'state-transition', 'use-case', 'pairwise', 'error-guessing', 'exploratory', 'checklist'];
const CASE_ID = /^TC-[A-Z]+-\d{3}$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const GHERKIN_STEP = /^\s*(Given|When|Then|And|But)\s+\S/m;
const BULK_LIMIT = 1000; // Xray Cloud: at most 1000 tests per bulk request

const list = (v) => (v === undefined || v === null ? [] : [v].flat());
export const areaOf = (id) => id.split('-')[1].toLowerCase();

/**
 * Check the canonical cases file. requirementIds: ids from requirements.yaml (a Set), or null to skip that check.
 * Returns { problems, uncovered } where uncovered lists requirements with no test case.
 */
export function validateCases(doc, requirementIds = null) {
  const problems = [];
  const cases = doc?.cases;
  if (!Array.isArray(cases)) return { problems: ['cases: missing or not a list'], uncovered: [] };
  const seen = new Set();
  const covered = new Set();
  for (const [i, c] of cases.entries()) {
    const at = c?.id ?? `cases[${i}]`;
    if (!CASE_ID.test(c?.id ?? '')) problems.push(`${at}: id must look like TC-AUTH-001`);
    if (seen.has(c?.id)) problems.push(`${at}: duplicate id`);
    seen.add(c?.id);
    if (typeof c?.title !== 'string' || c.title.trim().length < 5 || c.title.length > 255) problems.push(`${at}: title must be 5-255 characters`);
    const reqs = list(c?.requirement);
    if (reqs.length === 0) problems.push(`${at}: requirement is required (traceability)`);
    for (const r of reqs) {
      covered.add(r);
      if (requirementIds && !requirementIds.has(r)) problems.push(`${at}: requirement ${r} is not in requirements.yaml`);
    }
    if (!PRIORITIES.includes(c?.priority)) problems.push(`${at}: priority must be one of ${PRIORITIES.join(', ')}`);
    if (!TIERS.includes(c?.tier)) problems.push(`${at}: tier must be one of ${TIERS.join(', ')}`);
    if (!TECHNIQUES.includes(c?.technique)) problems.push(`${at}: technique must be one of ${TECHNIQUES.join(', ')}`);
    if (c?.type === 'manual') {
      if (!Array.isArray(c.steps) || c.steps.length === 0) problems.push(`${at}: a manual case needs steps`);
      for (const [j, s] of (c.steps ?? []).entries()) {
        if (!s?.action?.trim()) problems.push(`${at}: step ${j + 1} has no action`);
        if (!s?.expected?.trim()) problems.push(`${at}: step ${j + 1} has no expected result`);
      }
    } else if (c?.type === 'cucumber') {
      if (!GHERKIN_STEP.test(c.gherkin ?? '')) problems.push(`${at}: a cucumber case needs gherkin with Given/When/Then steps`);
      if (/^\s*(Feature|Scenario)\b/m.test(c.gherkin ?? '')) problems.push(`${at}: gherkin holds steps only (no Feature/Scenario line)`);
    } else problems.push(`${at}: type must be manual or cucumber`);
    if (c?.covers !== undefined) {
      const sels = [c.covers].flat();
      if (sels.length === 0 || sels.some((s) => typeof s !== 'string' || !s.trim())) problems.push(`${at}: covers is a list of selectors, each a few words`);
      for (const s of sels.filter((x) => typeof x === 'string')) {
        for (const w of s.split(/\s+/).filter(Boolean)) if (!COVERS_WORD.test(w)) problems.push(`${at}: covers word "${w}" must be a tag (@a11y, @page:login.php, @role:Visitor), a browser (project:firefox) or a k6 scenario (k6:load)`);
      }
    }
  }
  const uncovered = requirementIds ? [...requirementIds].filter((r) => !covered.has(r)).sort() : [];
  return { problems, uncovered };
}

/** Check a bulk-import payload against Xray Cloud's documented shape. Returns a list of problems. */
export function validateBulkTests(tests) {
  if (!Array.isArray(tests)) return ['payload must be a JSON array of tests'];
  const problems = [];
  if (tests.length === 0) problems.push('payload has no tests');
  if (tests.length > BULK_LIMIT) problems.push(`payload has ${tests.length} tests; Xray accepts at most ${BULK_LIMIT} per request`);
  for (const [i, t] of tests.entries()) {
    const at = `tests[${i}]${t?.fields?.summary ? ` (${t.fields.summary.slice(0, 40)})` : ''}`;
    if (!['Manual', 'Cucumber', 'Generic'].includes(t?.testtype)) problems.push(`${at}: testtype must be Manual, Cucumber or Generic`);
    if (!t?.fields?.summary?.trim()) problems.push(`${at}: fields.summary is required`);
    if ((t?.fields?.summary ?? '').length > 255) problems.push(`${at}: fields.summary is longer than 255 characters`);
    if (!PROJECT_KEY.test(t?.fields?.project?.key ?? '')) problems.push(`${at}: fields.project.key must be a Jira project key`);
    for (const l of t?.fields?.labels ?? []) if (/\s/.test(l)) problems.push(`${at}: label "${l}" contains whitespace (Jira rejects it)`);
    if (t?.testtype === 'Manual') {
      if (!Array.isArray(t.steps) || t.steps.length === 0) problems.push(`${at}: Manual tests need steps`);
      // Only action is required: Xray's own example omits data on one step and leaves result empty on another.
      for (const [j, s] of (t.steps ?? []).entries()) {
        if (!s?.action?.trim()) problems.push(`${at}: step ${j + 1} needs an action`);
        for (const k of ['data', 'result']) if (s?.[k] !== undefined && typeof s[k] !== 'string') problems.push(`${at}: step ${j + 1} ${k} must be a string`);
      }
    }
    if (t?.testtype === 'Cucumber' && !GHERKIN_STEP.test(t.gherkin_def ?? '')) problems.push(`${at}: Cucumber tests need gherkin_def steps`);
    if (t?.testtype === 'Generic' && !t.unstructured_def?.trim()) problems.push(`${at}: Generic tests need unstructured_def`);
    for (const link of t?.update?.issuelinks ?? []) {
      if (link?.add?.type?.name !== 'Test') problems.push(`${at}: issue links must use the "Test" link type`);
      if (!JIRA_KEY.test(link?.add?.outwardIssue?.key ?? '')) problems.push(`${at}: linked requirement key "${link?.add?.outwardIssue?.key}" is not a Jira key`);
    }
  }
  return problems;
}

/** Labels for a case: Jira labels cannot contain spaces. */
export function labelsOf(c) {
  return ['reverse-qa', c.id, ...list(c.requirement), c.priority, `tier-${c.tier}`, c.technique, ...list(c.tags)].map((l) => String(l).replace(/\s+/g, '_'));
}

function description(c) {
  const parts = [];
  if (list(c.preconditions).length) parts.push(`*Preconditions*\n${list(c.preconditions).map((p) => `* ${p}`).join('\n')}`);
  parts.push(`*Requirement(s):* ${list(c.requirement).join(', ')} · *Priority:* ${c.priority} · *Technique:* ${c.technique}`);
  if (c.automation) parts.push(`*Automated by:* ${c.automation}`);
  return parts.join('\n\n');
}

/** Render the bulk-import payload. jiraKeys maps REQ ids to Jira issue keys; unmapped requirements stay as labels. */
export function toBulk(doc, { projectKey, jiraKeys = {}, repositoryPath = null } = {}) {
  const key = doc.project_key ?? projectKey;
  return doc.cases.map((c) => {
    const t = { testtype: c.type === 'cucumber' ? 'Cucumber' : 'Manual', fields: { summary: c.title, project: { key }, labels: labelsOf(c), description: description(c) } };
    if (c.type === 'cucumber') t.gherkin_def = c.gherkin.trimEnd();
    else t.steps = c.steps.map((s) => ({ action: s.action, data: s.data ?? '', result: s.expected }));
    const links = list(c.requirement).filter((r) => jiraKeys[r]).map((r) => ({ add: { type: { name: 'Test' }, outwardIssue: { key: jiraKeys[r] } } }));
    if (links.length) t.update = { issuelinks: links };
    if (repositoryPath) t.xray_test_repository_folder = `${repositoryPath.replace(/\/+$/, '')}/${c.tier}`;
    return t;
  });
}

/** Gherkin .feature files, one per area (from the case id), with traceability tags. */
export function toFeatures(doc, { jiraKeys = {} } = {}) {
  const byArea = new Map();
  for (const c of doc.cases) byArea.set(areaOf(c.id), [...(byArea.get(areaOf(c.id)) ?? []), c]);
  const files = {};
  for (const [area, cases] of [...byArea.entries()].sort()) {
    const lines = [`Feature: ${area}`, '  Test cases generated by reverse-qa from approved requirements.', ''];
    for (const c of cases) {
      const reqTags = list(c.requirement).map((r) => `@REQ_${jiraKeys[r] ?? r}`);
      lines.push(`  ${[`@${c.id}`, ...reqTags, `@${c.priority}`, `@${c.tier}`].join(' ')}`);
      const outline = c.type === 'cucumber' && /^\s*Examples:/m.test(c.gherkin);
      lines.push(`  Scenario${outline ? ' Outline' : ''}: ${c.title}`);
      if (c.type === 'cucumber') {
        for (const l of c.gherkin.trimEnd().split('\n')) lines.push(`    ${l.trim().startsWith('|') ? '  ' : ''}${l.trim()}`);
      } else {
        list(c.preconditions).forEach((p, i) => lines.push(`    ${i === 0 ? 'Given' : 'And'} ${p}`));
        c.steps.forEach((s, i) => {
          lines.push(`    ${i === 0 ? 'When' : 'And'} ${s.action}${s.data ? ` with "${s.data.replace(/"/g, "'")}"` : ''}`);
          lines.push(`    Then ${s.expected}`);
        });
      }
      lines.push('');
    }
    files[`${area}.feature`] = `${lines.join('\n').trimEnd()}\n`;
  }
  return files;
}

export const IMPORTER_COLUMNS = ['TCID', 'Summary', 'Test Type', 'Priority', 'Labels', 'Requirement', 'Preconditions', 'Action', 'Data', 'Expected Result', 'Gherkin', 'Repository Path'];

/** Xray Test Case Importer CSV: one row per step; the first row of each case carries its fields, rows share TCID. */
export function toImporterCsv(doc, { jiraKeys = {}, repositoryPath = '' } = {}) {
  const rows = [];
  for (const c of doc.cases) {
    const head = {
      TCID: c.id,
      Summary: c.title,
      'Test Type': c.type === 'cucumber' ? 'Cucumber' : 'Manual',
      Priority: c.priority,
      Labels: labelsOf(c).join(' '),
      Requirement: list(c.requirement).map((r) => jiraKeys[r] ?? r).join(' '),
      Preconditions: list(c.preconditions).join(' | '),
      'Repository Path': repositoryPath ? `${repositoryPath.replace(/\/+$/, '')}/${c.tier}` : '',
    };
    if (c.type === 'cucumber') rows.push({ ...head, Gherkin: c.gherkin.trimEnd() });
    else c.steps.forEach((s, i) => rows.push({ ...(i === 0 ? head : { TCID: c.id }), Action: s.action, Data: s.data ?? '', 'Expected Result': s.expected }));
  }
  return toCsv(rows, IMPORTER_COLUMNS);
}

/** Case ids a Playwright spec is linked to: @TC-XXX-000 tags in its title or its tags list. */
export function caseIdsOf(spec) {
  const text = [spec.title ?? '', ...(spec.tags ?? [])].join(' ');
  return [...new Set(text.match(/TC-[A-Z]+-\d{3}/g) ?? [])];
}

/** One Xray status per Playwright test. A test.fail() that fails as expected is a known defect: FAILED in Xray. */
export function statusOf(test, { passed = 'PASSED', failed = 'FAILED', todo = 'TODO' } = {}) {
  if (test.status === 'skipped') return { status: todo, note: 'skipped' };
  if (test.expectedStatus === 'failed' && test.status === 'expected') return { status: failed, note: 'known defect (test.fail())' };
  if (test.status === 'expected') return { status: passed, note: null };
  if (test.status === 'flaky') return { status: passed, note: 'flaky: passed on retry' };
  return { status: failed, note: null };
}

/**
 * Xray JSON execution results from a Playwright JSON report. testKeys maps case ids to Xray test keys (from
 * /publish-xray); cases without a key are listed in `unmapped`. Several specs on one case: any failure wins.
 */
export function toXrayResults(report, { testKeys = {}, summary = 'reverse-qa automated run', statuses, cases = [] } = {}) {
  const byCase = new Map();
  const unlinked = [];
  for (const spec of walkSpecs(report.suites)) {
    const tagged = caseIdsOf(spec);
    // a case may also select this result through `covers` (per project: a selector can name a browser)
    const idsFor = (t) => [...new Set([...tagged, ...coveringCases({ title: spec.title, project: t.projectName }, cases)])];
    if (!(spec.tests ?? []).some((t) => idsFor(t).length)) {
      unlinked.push(`${spec.file}: ${spec.title}`);
      continue;
    }
    for (const t of spec.tests ?? []) {
      const ids = idsFor(t);
      const { status, note } = statusOf(t, statuses);
      const last = t.results?.at(-1);
      for (const id of ids) {
        const prev = byCase.get(id) ?? { status: statuses?.passed ?? 'PASSED', comments: [], start: null, finish: null };
        if (status !== (statuses?.passed ?? 'PASSED') && prev.status !== (statuses?.failed ?? 'FAILED')) prev.status = status;
        prev.comments.push(`${t.projectName ?? 'default'} · ${spec.title}: ${status}${note ? ` (${note})` : ''}${last?.error?.message ? ` — ${last.error.message.split('\n')[0].slice(0, 200)}` : ''}`);
        if (last?.startTime) {
          const s = new Date(last.startTime);
          const f = new Date(s.getTime() + (last.duration ?? 0));
          if (!prev.start || s < new Date(prev.start)) prev.start = s.toISOString();
          if (!prev.finish || f > new Date(prev.finish)) prev.finish = f.toISOString();
        }
        byCase.set(id, prev);
      }
    }
  }
  const tests = [];
  const unmapped = [];
  for (const [id, r] of [...byCase.entries()].sort()) {
    if (!testKeys[id]) {
      unmapped.push(id);
      continue;
    }
    tests.push({ testKey: testKeys[id], ...(r.start ? { start: r.start, finish: r.finish } : {}), status: r.status, comment: r.comments.join('\n') });
  }
  const starts = tests.map((t) => t.start).filter(Boolean).sort();
  const finishes = tests.map((t) => t.finish).filter(Boolean).sort();
  return {
    results: { info: { summary, description: 'Imported by reverse-qa from the Playwright JSON report', ...(starts[0] ? { startDate: starts[0], finishDate: finishes.at(-1) } : {}) }, tests },
    unmapped,
    unlinked,
  };
}

/** Stable id of a payload: a publish must send exactly what the dry run showed. */
export function previewId(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
