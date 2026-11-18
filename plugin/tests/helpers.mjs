// Shared test helpers: a throwaway project with the mini-shop fixture target, and a script runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_SRC = path.join(PLUGIN, 'tests', 'fixtures', 'mini-shop-php');
export const CHECK = path.join(PLUGIN, 'skills', 'check-citations', 'check.mjs');
export const PROTECT = path.join(PLUGIN, 'hooks', 'protect-target.mjs');

const slash = (p) => p.split(path.sep).join('/');

/** A temp project root holding targets/mini-shop (target.yaml, compose file, and a .env pointing at the fixture). */
export function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-test-'));
  const target = path.join(root, 'targets', 'mini-shop');
  const docs = path.join(target, 'output', 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const fixture = path.join(PLUGIN, 'tests', 'fixtures', 'targets', 'mini-shop');
  for (const f of fs.readdirSync(fixture)) fs.copyFileSync(path.join(fixture, f), path.join(target, f));
  fs.writeFileSync(path.join(target, '.env'), `MINI_SHOP_DIR=${slash(FIXTURE_SRC)}\nRQA_TEMPLATES=${slash(path.join(PLUGIN, 'templates'))}\n`);
  return { root, target, docs };
}

/** Run a plugin script with node; the parent's MINI_SHOP_DIR and CLAUDE_PROJECT_DIR never leak in. */
export function runNode(script, args = [], { input, env = {} } = {}) {
  const base = { ...process.env };
  delete base.MINI_SHOP_DIR;
  delete base.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [script, ...args], { input, env: { ...base, ...env }, encoding: 'utf8' });
}

/** Like runNode, but async, so an in-process mock server can answer the child's requests. */
export function runNodeAsync(script, args = [], { env = {} } = {}) {
  const base = { ...process.env };
  delete base.MINI_SHOP_DIR;
  delete base.CLAUDE_PROJECT_DIR;
  for (const k of Object.keys(base)) if (k.startsWith('XRAY_')) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Parse the YAML frontmatter of a Markdown file. */
export function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}
