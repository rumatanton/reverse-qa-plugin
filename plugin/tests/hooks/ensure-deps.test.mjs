// The SessionStart hook installs dependencies only when they are missing or older than the lock file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN, runNode } from '../helpers.mjs';
import { depsState } from '../../hooks/ensure-deps.mjs';

const HOOK = path.join(PLUGIN, 'hooks', 'ensure-deps.mjs');

test('depsState: missing, stale (lock newer than node_modules), ok', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-deps-'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.equal(depsState(root), 'missing');
  fs.mkdirSync(path.join(root, 'node_modules'));
  const marker = path.join(root, 'node_modules', '.package-lock.json');
  fs.writeFileSync(marker, '{}');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(marker, past, past);
  assert.equal(depsState(root), 'stale');
  fs.utimesSync(marker, new Date(), new Date());
  assert.equal(depsState(root), 'ok');
});

test('the hook does nothing when the plugin is installed, and only reports in --dry-run when it is not', () => {
  assert.equal(depsState(PLUGIN), 'ok', 'this checkout has its dependencies');
  const ok = runNode(HOOK, ['--plugin-root', PLUGIN]);
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, '', '']);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-deps-'));
  const dry = runNode(HOOK, ['--plugin-root', bare, '--dry-run']);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /ensure-deps: missing: would run npm ci --omit=dev/);
});
