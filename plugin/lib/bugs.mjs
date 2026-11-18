// Bug reports from confirmed findings. bug-reporter writes output/bugs/bugs.json; this module validates it and renders
// each bug as a Jira issue (REST v3, description in Atlassian Document Format). publish-bugs sends them.
import fs from 'node:fs';
import path from 'node:path';

const BUG_ID = /^BUG-\d{3}$/;
const CITATION = /[\w./-]+\.(php|inc|phtml|js|html?|sql):\d+/;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const PRIORITIES = ['P1', 'P2', 'P3'];
const MAX_ATTACHMENT = 10 * 1024 * 1024;

/**
 * Values that must never appear in a bug report or a document: every secret-looking variable in the target's .env
 * and process env. A "secret" that is also a plain setting in the same environment (a demo password equal to its user
 * name, admin / admin) is public, and it would match every path with that word in it, so it is not counted. Both
 * publish-bugs and check-citations read this one function.
 */
export function secretValues(env = {}) {
  const secret = ([k]) => /PASS|SECRET|TOKEN|KEY|PAT\b/i.test(k);
  const plain = new Set(Object.entries(env).filter((e) => !secret(e)).map(([, v]) => v));
  return [...new Set(Object.entries(env).filter((e) => secret(e) && typeof e[1] === 'string' && e[1].length >= 4 && !plain.has(e[1])).map(([, v]) => v))];
}

/**
 * Check bugs.json. findings: rows of findings.csv; targetDir: to resolve attachment paths; secrets: values to keep out.
 * Only confirmed findings become bugs, one bug per finding.
 */
export function validateBugs(doc, { findings = [], targetDir = '.', secrets = [] } = {}) {
  const problems = [];
  const bugs = doc?.bugs;
  if (!Array.isArray(bugs)) return ['bugs: missing or not a list'];
  const byFinding = new Map(findings.map((f) => [f.id, f]));
  const ids = new Set();
  const seenFindings = new Set();
  for (const [i, b] of bugs.entries()) {
    const at = b?.id ?? `bugs[${i}]`;
    if (!BUG_ID.test(b?.id ?? '')) problems.push(`${at}: id must look like BUG-001`);
    if (ids.has(b?.id)) problems.push(`${at}: duplicate id`);
    ids.add(b?.id);
    const f = byFinding.get(b?.finding_id);
    if (!f) problems.push(`${at}: finding ${b?.finding_id} is not in findings.csv`);
    else if (f.status !== 'confirmed') problems.push(`${at}: finding ${b.finding_id} is "${f.status}"; only confirmed findings become bugs`);
    if (seenFindings.has(b?.finding_id)) problems.push(`${at}: finding ${b.finding_id} already has a bug`);
    seenFindings.add(b?.finding_id);
    if (typeof b?.summary !== 'string' || b.summary.trim().length < 10 || b.summary.length > 255) problems.push(`${at}: summary must be 10-255 characters`);
    if (!SEVERITIES.includes(b?.severity)) problems.push(`${at}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (!PRIORITIES.includes(b?.priority)) problems.push(`${at}: priority must be one of ${PRIORITIES.join(', ')}`);
    if (!Array.isArray(b?.steps) || b.steps.length === 0 || b.steps.some((s) => !String(s).trim())) problems.push(`${at}: steps to reproduce are required`);
    for (const k of ['expected', 'actual', 'environment']) if (!String(b?.[k] ?? '').trim()) problems.push(`${at}: ${k} is required`);
    if (!CITATION.test(b?.root_cause ?? '')) problems.push(`${at}: root_cause must cite the source as path:line`);
    for (const a of b?.attachments ?? []) {
      const file = path.resolve(targetDir, a);
      if (!fs.existsSync(file)) problems.push(`${at}: attachment ${a} not found`);
      else if (fs.statSync(file).size > MAX_ATTACHMENT) problems.push(`${at}: attachment ${a} is over 10 MB`);
    }
    const text = JSON.stringify(b ?? {});
    for (const s of secrets) if (text.includes(s)) problems.push(`${at}: contains a credential value from .env; remove it`);
  }
  return problems;
}

// ---- Atlassian Document Format --------------------------------------------------------------------------------
const textNode = (t) => ({ type: 'text', text: String(t) });
const para = (t) => ({ type: 'paragraph', content: [textNode(t)] });
const heading = (t) => ({ type: 'heading', attrs: { level: 3 }, content: [textNode(t)] });
const list = (type, items) => ({ type, content: items.map((i) => ({ type: 'listItem', content: [para(i)] })) });

export function toAdf(b, { requirementKey = null, testKey = null } = {}) {
  const links = [`Finding: ${b.finding_id}`, b.requirement && `Requirement: ${b.requirement}${requirementKey ? ` (${requirementKey})` : ''}`, ...(b.test_ids ?? []).map((t) => `Test case: ${t}${testKey ? ` (${testKey})` : ''}`)].filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: [
      heading('Environment'),
      para(b.environment),
      heading('Steps to reproduce'),
      list('orderedList', b.steps),
      heading('Expected'),
      para(b.expected),
      heading('Actual'),
      para(b.actual),
      heading('Root cause'),
      { type: 'paragraph', content: [{ type: 'text', text: b.root_cause, marks: [{ type: 'code' }] }] },
      ...(b.evidence?.length ? [heading('Evidence'), list('bulletList', b.evidence)] : []),
      heading('Traceability'),
      list('bulletList', links),
      para('Reported by reverse-qa from a confirmed finding; reproduced against the local copy of the app.'),
    ],
  };
}

/** The create-issue body for one bug. priorityMap maps P1–P3 to the Jira instance's priority names (omit = labels only). */
export function toJiraIssue(b, { projectKey, issueType = 'Bug', priorityMap = null, requirementKey = null, testKey = null } = {}) {
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary: b.summary,
    description: toAdf(b, { requirementKey, testKey }),
    labels: ['reverse-qa', b.id, b.finding_id, b.priority, `severity-${b.severity}`, ...(b.labels ?? [])].map((l) => String(l).replace(/\s+/g, '_')),
  };
  if (priorityMap?.[b.priority]) fields.priority = { name: priorityMap[b.priority] };
  return { fields };
}
