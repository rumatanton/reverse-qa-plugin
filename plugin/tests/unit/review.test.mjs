import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { itemsOf, statusOf, decide, summary, hashOf } from '../../lib/review.mjs';

const REVIEW = path.join(PLUGIN, 'skills', 'review-gate', 'review.mjs');
const EXPORT = path.join(PLUGIN, 'skills', 'export-xray', 'export.mjs');
const FX = path.join(PLUGIN, 'tests', 'fixtures', 'xray');

const requirements = [
  { id: 'REQ-AUTH-001', statement: 'When a visitor logs in, the system shall start a session.', role: 'Visitor', kind: 'as-is', label: 'code-only', evidence: [{ file: 'login.php', line: 9, quote: 'session_start' }] },
  { id: 'REQ-PAY-001', statement: 'When a customer pays, the system shall record the order.', role: 'Customer', kind: 'as-is', label: 'code-only', evidence: [] },
];
const risks = [{ req_id: 'REQ-AUTH-001', likelihood: '3', impact: '4', score: '12', priority: 'P2' }];
const stories = [{ id: 'US-AUTH-001', requirements: ['REQ-AUTH-001'], story: 'As a visitor, I want to log in, so that I can shop' }];
const at = '2026-11-11';

test('review gate: each item is decided by a named person, and an edit after the decision shows as changed with the fields that differ', () => {
  const items = itemsOf({ requirements, risks, stories });
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [['REQ-AUTH-001', 'requirement'], ['REQ-PAY-001', 'requirement'], ['US-AUTH-001', 'story']]);
  assert.equal(hashOf({ a: 1, b: [2, { d: 4, c: 3 }] }), hashOf({ b: [2, { c: 3, d: 4 }], a: 1 }), 'key order does not change a hash');
  assert.deepEqual(summary(statusOf(items, {})), { total: 3, approved: 0, pending: 3, changed: 0, rejected: 0, waiting: ['REQ-AUTH-001', 'REQ-PAY-001', 'US-AUTH-001'] });

  // one item, by name; then the rest
  const one = decide(items, {}, { ids: ['REQ-AUTH-001'], status: 'approved', by: 'Anton', at });
  assert.deepEqual(one.decided, ['REQ-AUTH-001']);
  assert.deepEqual(statusOf(items, one.review).map((s) => s.state), ['approved', 'pending', 'pending']);
  const rest = decide(items, one.review, { ids: ['all'], status: 'approved', by: 'Anton', at });
  assert.deepEqual(rest.decided, ['REQ-PAY-001', 'US-AUTH-001'], 'the one already approved is not decided twice');
  assert.equal(summary(statusOf(items, rest.review)).waiting.length, 0);
  assert.deepEqual(decide(items, {}, { ids: ['stories'], status: 'approved', by: 'Anton', at }).decided, ['US-AUTH-001']);

  // who and why are required; an unknown id records nothing
  assert.throws(() => decide(items, {}, { ids: ['all'], status: 'approved', by: '', at }), /say who decides/);
  assert.throws(() => decide(items, {}, { ids: ['REQ-PAY-001'], status: 'rejected', by: 'Anton', at }), /needs its reason/);
  assert.deepEqual(decide(items, {}, { ids: ['REQ-NOPE-001'], status: 'approved', by: 'Anton', at }), { review: { items: {} }, decided: [], unknown: ['REQ-NOPE-001'] });
  const rejected = decide(items, rest.review, { ids: ['REQ-PAY-001'], status: 'rejected', by: 'Anton', at, note: 'the gateway answer is not checked' });
  const pay = statusOf(items, rejected.review).find((s) => s.id === 'REQ-PAY-001');
  assert.deepEqual([pay.state, pay.by, pay.note], ['rejected', 'Anton', 'the gateway answer is not checked']);

  // the statement is reworded and the risk score raised after approval: changed, and it says which fields
  const edited = itemsOf({ requirements: [{ ...requirements[0], statement: 'When a visitor logs in, the system shall start a new session.' }, requirements[1]], risks: [{ ...risks[0], score: '16', priority: 'P1' }], stories });
  const auth = statusOf(edited, rest.review).find((s) => s.id === 'REQ-AUTH-001');
  assert.deepEqual([auth.state, auth.was, auth.changed], ['changed', 'approved', ['risk', 'statement']]);
  assert.equal(statusOf(edited, rest.review).find((s) => s.id === 'REQ-PAY-001').state, 'approved', 'an untouched item keeps its approval');
});

test('review-gate script: status exits 2 until every item is approved, writes what was approved, and names a later edit', () => {
  const { root, target } = tempProject();
  const out = path.join(target, 'output');
  fs.copyFileSync(path.join(FX, 'mini-shop-requirements.yaml'), path.join(out, 'requirements.yaml'));
  const reqs = YAML.parse(fs.readFileSync(path.join(out, 'requirements.yaml'), 'utf8'));
  const run = (...args) => runNode(REVIEW, ['--target', 'mini-shop', '--root', root, ...args]);

  const before = run();
  assert.equal(before.status, 2, before.stderr);
  assert.match(before.stdout, new RegExp(`${reqs.length} item\\(s\\): 0 approved, ${reqs.length} pending`));
  assert.ok(!fs.existsSync(path.join(out, 'review.json')), 'looking records nothing');

  assert.equal(run('--approve', 'all').status, 1, 'no name, no decision');
  assert.equal(run('--approve', 'REQ-NOPE-001', '--by', 'Anton').status, 2);
  const first = run('--approve', reqs[0].id, '--by', 'Anton');
  assert.equal(first.status, 2, 'one approved, the rest still waiting');
  assert.match(first.stdout, /1 item\(s\) approved by Anton/);
  assert.deepEqual(YAML.parse(fs.readFileSync(path.join(out, 'approved', 'requirements.yaml'), 'utf8')).map((r) => r.id), [reqs[0].id], 'only what a person passed');
  const all = run('--approve', 'all', '--by', 'Anton');
  assert.equal(all.status, 0, all.stdout);
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8')).items[reqs[0].id];
  assert.deepEqual([saved.status, saved.by, /^\d{4}-\d{2}-\d{2}$/.test(saved.at)], ['approved', 'Anton', true]);
  assert.match(fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8'), /"step":"review-gate"/);

  // someone rewords an approved requirement
  reqs[1].statement = `${reqs[1].statement} Twice.`;
  fs.writeFileSync(path.join(out, 'requirements.yaml'), YAML.stringify(reqs));
  const after = run();
  assert.equal(after.status, 2);
  assert.match(after.stdout, new RegExp(`changed  ${reqs[1].id}: statement \\(was approved by Anton`));
  assert.match(run('--show', reqs[1].id).stdout, /statement changed since it was approved by Anton/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('export-xray: once the gate is started, a case for a requirement nobody approved fails, and only approved requirements need a case', () => {
  const { root, target } = tempProject();
  const out = path.join(target, 'output');
  fs.mkdirSync(path.join(out, 'test-cases'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'mini-shop-requirements.yaml'), path.join(out, 'requirements.yaml'));
  fs.copyFileSync(path.join(FX, 'mini-shop-cases.yaml'), path.join(out, 'test-cases', 'cases.yaml'));
  const reqs = YAML.parse(fs.readFileSync(path.join(out, 'requirements.yaml'), 'utf8'));
  const exportCases = () => runNode(EXPORT, ['--target', 'mini-shop', '--root', root]);
  const review = (...args) => runNode(REVIEW, ['--target', 'mini-shop', '--root', root, ...args]);

  assert.equal(exportCases().status, 0, 'no review file: nothing is held back, as before the gate existed');
  review('--approve', reqs[0].id, '--by', 'Anton');
  const held = exportCases();
  assert.equal(held.status, 2);
  assert.match(held.stderr + held.stdout, new RegExp(`requirement ${reqs[1].id} is not approved at the review gate`));
  review('--approve', 'all', '--by', 'Anton');
  assert.equal(exportCases().status, 0);

  // an approved requirement loses its case: it still needs one; a rejected one does not
  const doc = YAML.parse(fs.readFileSync(path.join(out, 'test-cases', 'cases.yaml'), 'utf8'));
  const dropped = reqs[reqs.length - 1].id;
  doc.cases = doc.cases.filter((c) => ![c.requirement].flat().includes(dropped));
  fs.writeFileSync(path.join(out, 'test-cases', 'cases.yaml'), YAML.stringify(doc));
  assert.match(exportCases().stderr + exportCases().stdout, new RegExp(`requirement ${dropped} has no test case`));
  review('--reject', dropped, '--by', 'Anton', '--note', 'out of scope for this release');
  assert.equal(exportCases().status, 0, 'a rejected requirement needs no case');
  fs.rmSync(root, { recursive: true, force: true });
});
