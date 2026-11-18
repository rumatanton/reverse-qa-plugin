import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, runNode, PROTECT, FIXTURE_SRC } from '../helpers.mjs';
import { decide } from '../../hooks/protect-target.mjs';

// Recorded PreToolUse input shape (Claude Code hooks reference).
const input = (root, tool, file) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, tool_name: tool, tool_input: { file_path: file } });

const run = (root, tool, file) => runNode(PROTECT, [], { input: input(root, tool, file), env: { CLAUDE_PROJECT_DIR: root } });

test('Write into the target source is denied with a reason', () => {
  const { root } = tempProject();
  const r = run(root, 'Write', path.join(FIXTURE_SRC, 'index.php'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /inside the source of target "mini-shop"/);
});

test('Edit in a subfolder of the source is denied', () => {
  const { root } = tempProject();
  const out = JSON.parse(run(root, 'Edit', path.join(FIXTURE_SRC, 'admin', 'products.php')).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a path that walks back into the source through .. is still denied', () => {
  const { root } = tempProject();
  const sneaky = path.join(FIXTURE_SRC, 'admin', '..', 'cart.php');
  assert.equal(JSON.parse(run(root, 'Write', sneaky).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the same path in different letter case is denied on Windows', { skip: process.platform !== 'win32' }, () => {
  const { root } = tempProject();
  const r = run(root, 'Write', path.join(FIXTURE_SRC, 'INDEX.PHP').toUpperCase());
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('writes to recon output, and to a sibling folder with a similar name, are allowed (no output)', () => {
  const { root, docs } = tempProject();
  const allowed = run(root, 'Write', path.join(docs, '01-architecture.md'));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  const sibling = run(root, 'Write', `${FIXTURE_SRC}-copy${path.sep}index.php`);
  assert.equal(sibling.stdout, '');
});

test('input without a file path, or unparseable input, is allowed', () => {
  const { root } = tempProject();
  assert.equal(runNode(PROTECT, [], { input: JSON.stringify({ tool_name: 'Write', tool_input: {} }), env: { CLAUDE_PROJECT_DIR: root } }).stdout, '');
  assert.equal(runNode(PROTECT, [], { input: 'garbage' }).status, 0);
});

test('decide(): a target whose source variable is unset is skipped, not a crash', () => {
  const { root, target } = tempProject();
  fs.writeFileSync(path.join(target, '.env'), '');
  delete process.env.MINI_SHOP_DIR;
  assert.equal(decide({ tool_input: { file_path: path.join(FIXTURE_SRC, 'index.php') } }, root), null);
});
