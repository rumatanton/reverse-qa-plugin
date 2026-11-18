import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromMarkdown, extractFromRequirements, verify } from '../../lib/citations.mjs';
import { FIXTURE_SRC } from '../helpers.mjs';

const cite = (file, line, quote) => ({ doc: 'd.md', docLine: 1, file, line, quote });
const reasons = (cs) => verify(cs, FIXTURE_SRC).map((f) => f.reason);

test('extractFromMarkdown finds citations with their doc line, and unescapes quotes', () => {
  const md = 'Intro\nOrders are written [cite: checkout.php:9 "INSERT INTO orders"] and [cite: cart.php:9 "INSERT INTO cart"].\n' +
    'Escaped [cite: login.php:14 "echo \\"Invalid login\\""]';
  const { citations, problems } = extractFromMarkdown(md, 'd.md');
  assert.equal(problems.length, 0);
  assert.equal(citations.length, 3);
  assert.deepEqual(citations[0], { doc: 'd.md', docLine: 2, file: 'checkout.php', line: 9, quote: 'INSERT INTO orders' });
  assert.equal(citations[2].quote, 'echo "Invalid login"');
});

test('extractFromMarkdown flags a malformed marker', () => {
  const { citations, problems } = extractFromMarkdown('Bad [cite: checkout.php "no line"] here', 'd.md');
  assert.equal(citations.length, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /malformed citation/);
});

test('verify passes a correct citation and one within 2 lines', () => {
  assert.deepEqual(reasons([cite('checkout.php', 9, 'INSERT INTO orders')]), []);
  assert.deepEqual(reasons([cite('checkout.php', 11, 'INSERT INTO orders')]), []); // 2 lines away
  assert.deepEqual(reasons([cite('admin/products.php', 9, 'move_uploaded_file')]), []);
});

test('verify normalizes whitespace in the quote and the line', () => {
  assert.deepEqual(reasons([cite('login.php', 9, '$_SESSION["UID"]   =   $row["id"]')]), []);
});

test('verify rejects each kind of bad citation with a specific reason', () => {
  assert.match(reasons([cite('checkout.php', 12, 'INSERT INTO orders')])[0], /not found within 2 lines/);
  assert.match(reasons([cite('missing.php', 1, 'anything here')])[0], /file not found/);
  assert.match(reasons([cite('checkout.php', 999, 'INSERT INTO orders')])[0], /line out of range \(file has \d+ lines\)/);
  assert.match(reasons([cite('../helpers.mjs', 1, 'Shared test helpers')])[0], /stay inside/);
  assert.match(reasons([cite('abc', 1, 'abc')])[0], /quote must be 5-80 characters/);
  assert.match(reasons([cite('checkout.php', 9, 'x'.repeat(81))])[0], /quote must be 5-80 characters/);
  assert.match(reasons([cite('checkout.php', 0, 'INSERT INTO orders')])[0], /line out of range/);
});

test('verify rejects an absolute path even when it points inside the source', () => {
  const abs = `${FIXTURE_SRC}/checkout.php`.split('\\').join('/');
  assert.match(reasons([cite(abs, 9, 'INSERT INTO orders')])[0], /relative to the source root/);
});

test('extractFromRequirements reads evidence and flags requirements without any', () => {
  const yaml = [
    '- id: REQ-PAY-001',
    '  statement: "When a customer checks out, the system shall create an order."',
    '  evidence:',
    '    - { file: checkout.php, line: 9, quote: "INSERT INTO orders" }',
    '- id: REQ-PAY-002',
    '  statement: "No evidence."',
  ].join('\n');
  const { citations, problems } = extractFromRequirements(yaml, 'requirements.yaml');
  assert.equal(citations.length, 1);
  assert.equal(citations[0].reqId, 'REQ-PAY-001');
  assert.deepEqual(verify(citations, FIXTURE_SRC), []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /REQ-PAY-002 has no evidence/);
});

test('extractFromRequirements reports unparseable YAML and a non-list document', () => {
  assert.match(extractFromRequirements('- id: [unclosed', 'r.yaml').problems[0].reason, /does not parse/);
  assert.match(extractFromRequirements('id: REQ-1', 'r.yaml').problems[0].reason, /must be a list/);
});
