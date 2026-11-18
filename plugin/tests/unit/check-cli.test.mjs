import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, runNode, CHECK } from '../helpers.mjs';

const GOOD = 'Checkout writes an order [cite: checkout.php:9 "INSERT INTO orders"] and clears the cart [cite: checkout.php:10 "DELETE FROM cart"].\n';
const BAD = 'Wrong line [cite: checkout.php:2 "INSERT INTO orders"].\n';

test('no recon documents yet: exit 0, nothing to check', () => {
  const { root } = tempProject();
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to check/);
});

test('all citations resolve: exit 0 with the count', () => {
  const { root, docs } = tempProject();
  fs.writeFileSync(path.join(docs, '01-architecture.md'), GOOD);
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 citation\(s\) in 1 file\(s\), 0 problem\(s\)/);
});

test('a bad citation: exit 2 with the reason on stderr', () => {
  const { root, docs } = tempProject();
  fs.writeFileSync(path.join(docs, '01-architecture.md'), GOOD);
  fs.writeFileSync(path.join(docs, '02-security.md'), BAD);
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /02-security\.md:1 -> checkout\.php:2 "INSERT INTO orders": quote not found within 2 lines/);
  assert.match(r.stderr, /3 citation\(s\) in 2 file\(s\), 1 problem\(s\)/);
});

test('a seed email or an .env secret in a document or findings.csv fails without printing the value', () => {
  // the tech-analyst once quoted a real customer's email from a seed dump; a citation quotes code, never a data row
  const { root, docs } = tempProject();
  const target = path.join(root, 'targets', 'mini-shop');
  fs.appendFileSync(path.join(target, '.env'), 'ADMIN_USER=admin\nADMIN_PASSWORD=admin\nXRAY_CLIENT_SECRET=s3cr3t-value-123\n');
  fs.writeFileSync(path.join(docs, '01-architecture.md'), `${GOOD}The first customer is Ann@Example.test.\nadmin/report.php is the admin page.\n`);
  fs.writeFileSync(path.join(target, 'output', 'findings.csv'), 'id,title\nF-001,"token s3cr3t-value-123 in config"\n');
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /01-architecture\.md:2: contains 1 private value/, 'a seed email, matched case-insensitively');
  assert.doesNotMatch(r.stderr, /01-architecture\.md:3/, 'a demo password equal to its user name is public: "admin/" paths do not count');
  assert.match(r.stderr, /findings\.csv:2: contains 1 private value/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ann@example|s3cr3t-value/i, 'the value itself is never printed');
});

test('requirements.yaml is checked too', () => {
  const { root, target } = tempProject();
  fs.writeFileSync(path.join(target, 'output', 'requirements.yaml'), '- id: REQ-CART-001\n  statement: "x"\n  evidence: []\n');
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REQ-CART-001 has no evidence/);
});

test('--file limits the check to the named documents', () => {
  const { root, docs } = tempProject();
  fs.writeFileSync(path.join(docs, '01-architecture.md'), GOOD);
  fs.writeFileSync(path.join(docs, '02-security.md'), BAD);
  const r = runNode(CHECK, ['--target', 'mini-shop', '--root', root, '--file', path.join(docs, '01-architecture.md')]);
  assert.equal(r.status, 0, r.stderr);
});

test('usage and configuration problems: exit 1', () => {
  const { root } = tempProject();
  assert.equal(runNode(CHECK, []).status, 1);
  const unknown = runNode(CHECK, ['--target', 'nope', '--root', root]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no target definition/);
  const missing = runNode(CHECK, ['--target', 'mini-shop', '--root', root, '--file', 'nope.md']);
  assert.equal(missing.status, 1);
});
