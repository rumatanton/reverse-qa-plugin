#!/usr/bin/env node
// SessionStart hook: make sure the plugin's Node dependencies are installed. A plugin installed from a marketplace is
// copied without node_modules, and every script needs them. Runs `npm ci --omit=dev` in the plugin folder only when
// node_modules is missing or older than package-lock.json; otherwise it does nothing. Never blocks the session.
//   node ensure-deps.mjs [--plugin-root <dir>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 'missing' | 'stale' | 'ok' for a plugin folder. */
export function depsState(root) {
  const lock = path.join(root, 'package-lock.json');
  const marker = path.join(root, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(marker)) return 'missing';
  return fs.existsSync(lock) && fs.statSync(lock).mtimeMs > fs.statSync(marker).mtimeMs ? 'stale' : 'ok';
}

function main(argv) {
  const i = argv.indexOf('--plugin-root');
  const root = path.resolve(i >= 0 ? argv[i + 1] : process.env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const state = depsState(root);
  if (state === 'ok') return 0;
  if (argv.includes('--dry-run')) {
    process.stdout.write(`ensure-deps: ${state}: would run npm ci --omit=dev in ${root}\n`);
    return 0;
  }
  const r = spawnSync('npm ci --omit=dev --no-audit --no-fund', { cwd: root, shell: true, encoding: 'utf8' });
  // SessionStart: a message on stderr is shown to the user; the session continues either way.
  if (r.status !== 0) process.stderr.write(`reverse-qa: could not install its Node dependencies (${state}); run "npm ci" in ${root}\n${(r.stderr || '').slice(-500)}\n`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
