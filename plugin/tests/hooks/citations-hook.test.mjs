import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, runNode, CHECK } from '../helpers.mjs';

// Recorded PostToolUse input shape (Claude Code hooks reference): tool_name + tool_input.file_path.
const hookInput = (root, file) =>
  JSON.stringify({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Write', tool_input: { file_path: file } });

test('a written doc with a bad citation: exit 2, reason on stderr for Claude', () => {
  const { root, docs } = tempProject();
  const doc = path.join(docs, '02-security.md');
  fs.writeFileSync(doc, 'Bad [cite: cart.php:1 "INSERT INTO cart"].\n');
  const r = runNode(CHECK, ['--hook'], { input: hookInput(root, doc), env: { CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /do not resolve/);
  assert.match(r.stderr, /cart\.php:1 "INSERT INTO cart": quote not found within 2 lines/);
});

test('a written doc whose citations resolve: exit 0, silent', () => {
  const { root, docs } = tempProject();
  const doc = path.join(docs, '04-workflows.md');
  fs.writeFileSync(doc, 'Cart insert [cite: cart.php:9 "INSERT INTO cart"].\n');
  const r = runNode(CHECK, ['--hook'], { input: hookInput(root, doc), env: { CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('files outside output/docs and requirements.yaml are ignored', () => {
  const { root, target } = tempProject();
  const notes = path.join(target, 'notes.md');
  fs.writeFileSync(notes, 'Bad [cite: cart.php:1 "INSERT INTO cart"].\n');
  const r = runNode(CHECK, ['--hook'], { input: hookInput(root, notes), env: { CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0);
});

test('a relative file_path resolves against the project root', () => {
  const { root, docs } = tempProject();
  fs.writeFileSync(path.join(docs, '03-roles.md'), 'Bad [cite: login.php:1 "password_verify"].\n');
  const r = runNode(CHECK, ['--hook'], {
    input: hookInput(root, 'targets/mini-shop/output/docs/03-roles.md'),
    env: { CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 2);
});

test('unparseable or empty hook input never blocks', () => {
  assert.equal(runNode(CHECK, ['--hook'], { input: 'not json' }).status, 0);
  assert.equal(runNode(CHECK, ['--hook'], { input: '' }).status, 0);
});
