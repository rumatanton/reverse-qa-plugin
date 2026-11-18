// bug-reporter's output contract and publish-bugs: validation, the Jira payload, dry run, confirm against a mock Jira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PLUGIN, tempProject, runNode, runNodeAsync } from '../helpers.mjs';
import { validateBugs, toJiraIssue, toAdf, secretValues } from '../../lib/bugs.mjs';
import { parseCsv } from '../../lib/csv.mjs';

const PUBLISH = path.join(PLUGIN, 'skills', 'publish-bugs', 'publish.mjs');
const FX = path.join(PLUGIN, 'tests', 'fixtures');
const BUGS = JSON.parse(fs.readFileSync(path.join(FX, 'bugs', 'bugs.json'), 'utf8'));
const FINDINGS = parseCsv(fs.readFileSync(path.join(FX, 'reports', 'findings.csv'), 'utf8'));

/** A project with findings, bugs.json and the evidence file the bug attaches. */
function project({ jira = true } = {}) {
  const p = tempProject();
  const out = path.join(p.target, 'output');
  fs.mkdirSync(path.join(out, 'bugs'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'reports', 'findings.csv'), path.join(out, 'findings.csv'));
  fs.copyFileSync(path.join(FX, 'bugs', 'bugs.json'), path.join(out, 'bugs', 'bugs.json'));
  const trace = path.join(out, 'runs', '20261109-120000-report', 'artifacts', 'report-leak', 'trace.zip');
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  fs.writeFileSync(trace, 'PK fake trace');
  fs.writeFileSync(path.join(out, 'jira-keys.yaml'), 'REQ-ADM-001: QA-13\n');
  fs.mkdirSync(path.join(out, 'xray'), { recursive: true });
  fs.writeFileSync(path.join(out, 'xray', 'xray-keys.json'), JSON.stringify({ 'TC-ADM-001': 'QA-104' }));
  if (jira) fs.appendFileSync(path.join(p.target, 'target.yaml'), 'jira:\n  base_url: http://127.0.0.1:1\n  project_key: QA\n  priority_map: { P1: Highest, P2: High, P3: Medium }\n');
  return { ...p, out };
}

test('validateBugs accepts a complete report for a confirmed finding', () => {
  const { target } = project();
  assert.deepEqual(validateBugs(BUGS, { findings: FINDINGS, targetDir: target }), []);
});

test('validateBugs refuses unconfirmed findings, missing steps, uncited root causes, missing evidence and credentials', () => {
  const { target } = project();
  const bad = structuredClone(BUGS);
  bad.bugs.push({ ...bad.bugs[0], id: 'BUG-002', finding_id: 'F-002' });
  bad.bugs.push({ ...bad.bugs[0], id: 'BUG-002', steps: [], root_cause: 'somewhere', attachments: ['nope.png'], actual: 'login with admin/s3cret-pass' });
  const p = validateBugs(bad, { findings: FINDINGS, targetDir: target, secrets: ['s3cret-pass'] });
  for (const want of ['F-002 is "single-source"', 'duplicate id', 'already has a bug', 'steps to reproduce', 'root_cause must cite', 'nope.png not found', 'credential value']) assert.ok(p.some((x) => x.includes(want)), want);
  assert.deepEqual(validateBugs({}, {}), ['bugs: missing or not a list']);
});

test('secretValues picks password, token, secret and key variables only', () => {
  assert.deepEqual(secretValues({ ADMIN_PASSWORD: 'hunter22', JIRA_API_TOKEN: 'tok-123', TARGET_DIR: 'C:/x', DB_PORT: '3306', XRAY_CLIENT_SECRET: 'abc' }).sort(), ['hunter22', 'tok-123']);
});

test('a demo password equal to its user name is public: it is not a secret, and a real secret beside it still is', () => {
  // admin / admin: counted as a secret, the word would match every report that names an admin/ page
  const env = { ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin', DB_PASSWORD: 'hunter22' };
  assert.deepEqual(secretValues(env), ['hunter22']);
  const bug = { id: 'BUG-001', finding: 'F-001', title: 'The admin page is open', severity: 'high', priority: 'P1', steps: ['Open admin/index.php'], expected: 'login', actual: 'the page', root_cause: 'admin/index.php:3' };
  const problems = (text) => validateBugs({ bugs: [{ ...bug, actual: text }] }, { findings: [{ id: 'F-001', status: 'confirmed' }], secrets: secretValues(env) }).filter((p) => /credential/.test(p));
  assert.deepEqual(problems('admin/index.php is served'), []);
  assert.equal(problems('the database password is hunter22').length, 1);
});

test('toJiraIssue renders a Bug with ADF description, labels, mapped priority and traceability', () => {
  const issue = toJiraIssue(BUGS.bugs[0], { projectKey: 'QA', priorityMap: { P2: 'High' }, requirementKey: 'QA-13', testKey: 'QA-104' });
  assert.equal(issue.fields.issuetype.name, 'Bug');
  assert.deepEqual(issue.fields.priority, { name: 'High' });
  assert.deepEqual(issue.fields.labels, ['reverse-qa', 'BUG-001', 'F-001', 'P2', 'severity-high', 'authz']);
  const adf = issue.fields.description;
  assert.equal(adf.type, 'doc');
  const headings = adf.content.filter((n) => n.type === 'heading').map((n) => n.content[0].text);
  assert.deepEqual(headings, ['Environment', 'Steps to reproduce', 'Expected', 'Actual', 'Root cause', 'Evidence', 'Traceability']);
  assert.equal(adf.content.find((n) => n.type === 'orderedList').content.length, 3);
  assert.match(JSON.stringify(adf), /Requirement: REQ-ADM-001 \(QA-13\)/);
  assert.equal(toJiraIssue(BUGS.bugs[0], { projectKey: 'QA' }).fields.priority, undefined, 'no map: priority travels as a label');
  assert.ok(toAdf({ ...BUGS.bugs[0], evidence: [] }).content.every((n) => n.content?.[0]?.text !== 'Evidence'));
});

/** A mock Jira Cloud: create issue, attachments (checks the no-check header), issue links. */
async function mockJira() {
  const calls = [];
  let n = 500;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, xToken: req.headers['x-atlassian-token'], body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (req.headers.authorization !== `Basic ${Buffer.from('qa@example.test:tok-123').toString('base64')}`) return send(401, { errorMessages: ['unauthorized'] });
    if (req.url === '/rest/api/3/issue' && req.method === 'POST') return send(201, { id: String(++n), key: `QA-${n}` });
    if (/^\/rest\/api\/3\/issue\/QA-\d+\/attachments$/.test(req.url)) return req.headers['x-atlassian-token'] === 'no-check' ? send(200, [{ id: '1' }]) : send(403, {});
    if (req.url === '/rest/api/3/issueLink') return send(201);
    return send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

test('publish-bugs: dry run sends nothing; confirm creates the bug, attaches the trace, links requirement and test; rerun skips it', async () => {
  const { root, out } = project();
  const dry = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN, nothing sent\. 1 bug\(s\) to create \(1 high\), 0 already in Jira\. preview_id [0-9a-f]{16}/);
  const id = JSON.parse(fs.readFileSync(path.join(out, 'bugs', 'publish-preview.json'), 'utf8')).preview_id;
  const jira = await mockJira();
  try {
    const env = { JIRA_BASE_URL: jira.url, JIRA_EMAIL: 'qa@example.test', JIRA_API_TOKEN: 'tok-123' };
    const wrong = await runNodeAsync(PUBLISH, ['--target', 'mini-shop', '--root', root, '--confirm', 'ffffffffffffffff'], { env });
    assert.equal(wrong.status, 2);
    assert.equal(jira.calls.length, 0);
    const r = await runNodeAsync(PUBLISH, ['--target', 'mini-shop', '--root', root, '--confirm', id], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BUG-001 → QA-501 \(1 attachment\(s\), linked QA-13, QA-104\)/);
    assert.deepEqual(jira.calls.map((c) => `${c.method} ${c.url}`), ['POST /rest/api/3/issue', 'POST /rest/api/3/issue/QA-501/attachments', 'POST /rest/api/3/issueLink', 'POST /rest/api/3/issueLink']);
    const created = JSON.parse(jira.calls[0].body);
    assert.deepEqual([created.fields.project.key, created.fields.priority.name], ['QA', 'High']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'bugs', 'jira-bug-keys.json'), 'utf8')), { 'BUG-001': 'QA-501' });
    const again = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root], { env });
    assert.match(again.stdout, /0 bug\(s\) to create \(none\), 1 already in Jira/);
    assert.ok(!fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8').includes('tok-123'), 'the token never reaches the ledger');
  } finally {
    await jira.close();
  }
});

test('publish-bugs: without a Jira project the dry run still validates, with a note; confirm refuses', async () => {
  const { root } = project({ jira: false });
  const dry = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Note: no Jira project yet/);
  const r = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root, '--confirm', 'x']);
  assert.equal(r.status, 2, 'preview mismatch is checked first');
});

test('publish-bugs: an invalid report fails the dry run with every problem listed', () => {
  const { root, out } = project();
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'bugs', 'bugs.json'), 'utf8'));
  doc.bugs[0].finding_id = 'F-002';
  fs.writeFileSync(path.join(out, 'bugs', 'bugs.json'), JSON.stringify(doc));
  const r = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only confirmed findings become bugs/);
});
