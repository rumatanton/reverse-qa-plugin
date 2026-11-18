// build-stories: grouping, keep/fix split, priority, findings, id and wording stability, the check, and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { buildStories, checkStories, draftAcceptance, pairOf, placement, storiesMarkdown, jiraStories, STORY_LINE } from '../../skills/build-stories/stories.mjs';

const SCRIPT = path.join(PLUGIN, 'skills', 'build-stories', 'stories.mjs');

const REQS = [
  { id: 'REQ-AUTH-001', statement: 'When a visitor submits login.php with a wrong password, the system shall show an error and set no session key.', role: 'Visitor', kind: 'as-is' },
  { id: 'REQ-AUTH-002', statement: 'When a visitor registers, the system shall store the password exactly as typed.', role: 'Visitor', kind: 'as-is', notes: 'F-003.' },
  { id: 'REQ-AUTH-003', statement: 'When a visitor registers, the system shall store a salted hash of the password.', role: 'Visitor', kind: 'intended', notes: 'Pairs with REQ-AUTH-002.' },
  { id: 'REQ-CART-001', statement: 'When a customer adds a book, the system shall insert one cart row.', role: 'Customer', kind: 'as-is' },
  { id: 'REQ-CART-002', statement: 'The system shall keep cart rows per customer.', role: 'Customer', kind: 'as-is', notes: 'F-001 nearby.' },
  { id: 'REQ-ROLE-001', statement: 'When a visitor opens admin/x.php, the system shall redirect to admin_login.php and stop.', role: 'Visitor', kind: 'intended' },
];
const RISKS = [
  { req_id: 'REQ-AUTH-001', feature: 'Authentication', priority: 'P2' },
  { req_id: 'REQ-AUTH-002', feature: 'Authentication', priority: 'P1' },
  { req_id: 'REQ-AUTH-003', feature: 'Authentication', priority: 'P2' },
  { req_id: 'REQ-CART-001', feature: 'Cart', priority: 'P3' },
  { req_id: 'REQ-CART-002', feature: 'Cart', priority: 'P2' },
  { req_id: 'REQ-ROLE-001', feature: 'Authorization', priority: 'P1' },
];
const FINDINGS = [
  { id: 'F-001', req_id: '', status: 'triaged' },
  { id: 'F-003', req_id: '', status: 'confirmed' },
  { id: 'F-R01', req_id: 'REQ-CART-001', status: 'rejected' },
];

test('placement: an intended rule leads a fix story and takes its as-is pair under replaces; other as-is behaviour is kept', () => {
  assert.equal(pairOf(REQS[2]), 'REQ-AUTH-002');
  const p = placement(REQS, new Map(RISKS.map((r) => [r.req_id, r])));
  assert.deepEqual(p.get('REQ-AUTH-003'), { story: 'AUTH|Authentication|Visitor|fix', as: 'requirement' });
  assert.deepEqual(p.get('REQ-AUTH-002'), { story: 'AUTH|Authentication|Visitor|fix', as: 'replaces' }, 'today\'s broken side goes with the rule that replaces it');
  assert.deepEqual(p.get('REQ-AUTH-001'), { story: 'AUTH|Authentication|Visitor|keep', as: 'requirement' });
  assert.deepEqual(p.get('REQ-ROLE-001'), { story: 'ROLE|Authorization|Visitor|fix', as: 'requirement' }, 'an intended rule with no pair still leads a fix story');
});

test('buildStories: ids, priority, findings and draft criteria; replaced requirements are never criteria', () => {
  const { stories } = buildStories({ requirements: REQS, risks: RISKS, findings: FINDINGS });
  assert.deepEqual(stories.map((s) => [s.id, s.kind, s.requirements.join(' '), (s.replaces ?? []).join(' '), s.priority, s.findings.join(' ')]), [
    ['US-AUTH-001', 'keep', 'REQ-AUTH-001', '', 'P2', ''],
    ['US-AUTH-002', 'fix', 'REQ-AUTH-003', 'REQ-AUTH-002', 'P2', 'F-003'], // F-003 reaches the fix story through the pair's notes
    ['US-CART-001', 'keep', 'REQ-CART-001 REQ-CART-002', '', 'P2', 'F-001'], // the rejected F-R01 never counts
    ['US-ROLE-001', 'fix', 'REQ-ROLE-001', '', 'P1', ''],
  ]);
  const fix = stories[1];
  assert.deepEqual(fix.acceptance.map((a) => a.req), ['REQ-AUTH-003']);
  assert.ok(stories.every((s) => s.wording === 'draft' && STORY_LINE.test(s.story)));
  assert.deepEqual(draftAcceptance(REQS[0]), { req: 'REQ-AUTH-001', given: 'a visitor who is not logged in', when: 'a visitor submits login.php with a wrong password', then: 'the system shall show an error and set no session key' });
  assert.deepEqual(draftAcceptance(REQS[4]), { req: 'REQ-CART-002', given: 'a customer who is logged in', then: 'The system shall keep cart rows per customer' }, 'a statement with no trigger keeps its text as the outcome');
});

test('the check passes a fresh build and lists review items: kept behaviour that names a finding, a fix with no finding, drafts', () => {
  const { stories } = buildStories({ requirements: REQS, risks: RISKS, findings: FINDINGS });
  const { problems, review } = checkStories({ stories, requirements: REQS, risks: RISKS, findings: FINDINGS });
  assert.deepEqual(problems, []);
  assert.ok(review.includes('US-CART-001: keeps REQ-CART-002, which names F-001: confirm it is behaviour to keep, or write the intended requirement'));
  assert.ok(review.some((r) => r.startsWith('US-ROLE-001: a fix story with no finding behind it')));
  assert.equal(review.filter((r) => r.includes('draft wording')).length, 4);
});

test('the check catches every way the wording step could drift the structure', () => {
  const fresh = () => structuredClone(buildStories({ requirements: REQS, risks: RISKS, findings: FINDINGS }).stories);
  const cases = [
    ['a requirement moved to another story', (s) => { s[2].requirements.push('REQ-AUTH-001'); s[2].acceptance.push({ req: 'REQ-AUTH-001', then: 'x' }); }, /REQ-AUTH-001 is in two stories/],
    ['a requirement dropped', (s) => { s[2].requirements = ['REQ-CART-001']; s[2].acceptance = s[2].acceptance.slice(0, 1); }, /REQ-CART-002 is in no story/],
    ['a replaced requirement used as a criterion', (s) => { s[1].acceptance.push({ req: 'REQ-AUTH-002', then: 'x' }); }, /replaced requirement describes today's broken side/],
    ['a priority changed', (s) => { s[0].priority = 'P1'; }, /priority must be P2/],
    ['a finding removed', (s) => { s[1].findings = []; }, /findings must be \[F-003\]/],
    ['a story line not in story form', (s) => { s[0].story = 'Login works.'; }, /story must read "As a <role>/],
    ['a requirement with no criterion', (s) => { s[2].acceptance = s[2].acceptance.slice(0, 1); }, /REQ-CART-002 has no acceptance criterion/],
    ['a kind flipped', (s) => { s[0].kind = 'fix'; }, /REQ-AUTH-001 belongs under requirements of the keep story/],
    ['an unknown requirement', (s) => { s[3].requirements.push('REQ-ROLE-999'); }, /REQ-ROLE-999 is not in requirements.yaml/],
  ];
  for (const [name, mutate, expected] of cases) {
    const s = fresh();
    mutate(s);
    const { problems } = checkStories({ stories: s, requirements: REQS, risks: RISKS, findings: FINDINGS });
    assert.ok(problems.some((p) => expected.test(p)), `${name}: expected a problem matching ${expected}, got ${JSON.stringify(problems)}`);
  }
  const leak = checkStories({ stories: fresh(), requirements: REQS, risks: RISKS, findings: FINDINGS, text: 'story: mail jane@real.example', leakValues: ['jane@real.example'] });
  assert.ok(leak.problems.some((p) => /private value/.test(p)), 'seed data or a secret in stories.yaml fails the check');
});

test('a rebuild keeps ids and final wording, and redrafts a story whose requirements changed', () => {
  const first = buildStories({ requirements: REQS, risks: RISKS, findings: FINDINGS }).stories;
  for (const s of first) Object.assign(s, { wording: 'final', story: `As ${s.role === 'Customer' ? 'a customer' : 'a visitor'}, I want ${s.epic.toLowerCase()}, so that it works` });
  const more = [...REQS, { id: 'REQ-CART-003', statement: 'When a customer removes a book, the system shall delete its cart row.', role: 'Customer', kind: 'as-is' }];
  const moreRisks = [...RISKS, { req_id: 'REQ-CART-003', feature: 'Cart', priority: 'P3' }];
  const again = buildStories({ requirements: more, risks: moreRisks, findings: FINDINGS, previous: first });
  assert.deepEqual(again.stories.map((s) => s.id), first.map((s) => s.id), 'ids are stable');
  assert.equal(again.kept, 3);
  assert.equal(again.redrafted, 1);
  assert.equal(again.stories.find((s) => s.id === 'US-CART-001').wording, 'draft', 'the cart story gained a requirement, so its wording is redone');
  const added = buildStories({ requirements: [...more, { id: 'REQ-CART-004', statement: 'When an admin opens carts, the system shall list them.', role: 'Admin', kind: 'as-is' }], risks: [...moreRisks, { req_id: 'REQ-CART-004', feature: 'Cart', priority: 'P3' }], findings: FINDINGS, previous: again.stories });
  assert.equal(added.stories.find((s) => s.role === 'Admin').id, 'US-CART-002', 'a new story takes the next free number in its area');
});

test('outputs: the readable document shows what a fix replaces; the Jira JSON names no project and sends nothing', () => {
  const { stories } = buildStories({ requirements: REQS, risks: RISKS, findings: FINDINGS });
  const md = storiesMarkdown(stories, 'mini-shop', REQS);
  assert.match(md, /4 stories \(2 keep, 2 fix\) in 3 epics/);
  assert.match(md, /- Today \(REQ-AUTH-002\): When a visitor registers, the system shall store the password exactly as typed\./);
  assert.match(md, /Scenario: REQ-AUTH-003\n {2}Given a visitor who is not logged in\n {2}When a visitor registers\n {2}Then the system shall store a salted hash/);
  const jira = jiraStories(stories);
  assert.equal(jira.project_key, '');
  assert.match(jira.note, /Not sent anywhere/);
  assert.deepEqual(jira.issues[1].labels, ['reverse-qa', 'epic-authentication', 'fix', 'REQ-AUTH-003', 'F-003']);
});

test('CLI: builds the files, --check passes, a hand-made structural change exits 2, no requirements exits 1', () => {
  const { root, target } = tempProject();
  const out = path.join(target, 'output');
  assert.equal(runNode(SCRIPT, ['--target', 'mini-shop', '--root', root]).status, 1, 'no requirements.yaml yet');
  fs.writeFileSync(path.join(out, 'requirements.yaml'), YAML.stringify(REQS));
  fs.writeFileSync(path.join(out, 'risk-register.csv'), `req_id,feature,priority\n${RISKS.map((r) => `${r.req_id},${r.feature},${r.priority}`).join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'findings.csv'), `id,req_id,status\n${FINDINGS.map((f) => `${f.id},${f.req_id},${f.status}`).join('\n')}\n`);
  const r = runNode(SCRIPT, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /4 stories from 6 requirements/);
  for (const f of ['stories.yaml', 'docs/07-user-stories.md', 'stories/jira-stories.json', 'stories/review.md']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.equal(runNode(SCRIPT, ['--target', 'mini-shop', '--root', root, '--check']).status, 0);
  const file = path.join(out, 'stories.yaml');
  const stories = YAML.parse(fs.readFileSync(file, 'utf8'));
  stories[0].priority = 'P1';
  fs.writeFileSync(file, YAML.stringify(stories));
  const bad = runNode(SCRIPT, ['--target', 'mini-shop', '--root', root, '--check']);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /US-AUTH-001: priority must be P2/);
});
