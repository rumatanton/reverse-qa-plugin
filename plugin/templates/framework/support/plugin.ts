// Locate the reverse-qa plugin and load its libraries, so the framework reuses the plugin's tested code (target
// loading, database, server log, snapshots, crawl rules) instead of copying it. Lookup order: RQA_PLUGIN_DIR, <repo>/plugin, then the
// path scaffold-framework wrote to .rqa-plugin-path (needed when the plugin is installed from a marketplace).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRAMEWORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET_DIR = path.resolve(FRAMEWORK, '..');
export const ROOT = path.resolve(TARGET_DIR, '..', '..');

function resolvePlugin(): string {
  const candidates = [process.env.RQA_PLUGIN_DIR, path.join(ROOT, 'plugin')];
  const pointer = path.join(FRAMEWORK, '.rqa-plugin-path');
  if (fs.existsSync(pointer)) candidates.push(fs.readFileSync(pointer, 'utf8').trim());
  const found = candidates.find((c) => c && fs.existsSync(path.join(c, 'lib', 'target.mjs')));
  if (!found) throw new Error(`reverse-qa plugin not found (tried ${candidates.filter(Boolean).join(', ')}); set RQA_PLUGIN_DIR`);
  return found;
}

export const PLUGIN = resolvePlugin();
const load = (rel: string) => import(pathToFileURL(path.join(PLUGIN, rel)).href);

export const targetLib = await load('lib/target.mjs');
export const csvLib = await load('lib/csv.mjs');
export const runtimeLib = await load('lib/runtime.mjs');
export const dbLib = await load('lib/db.mjs');
export const dockerLib = await load('lib/docker.mjs');
export const resetLib = await load('skills/db-reset/reset.mjs');
export const snapshotLib = await load('skills/db-snapshot/snapshot.mjs');
export const cleanupLib = await load('lib/cleanup.mjs');
export const pagesLib = await load('lib/pages.mjs');
export const platformLib = await load('lib/platform.mjs');
export const crawlLib = await load('lib/crawl.mjs');
export const YAML = (await load('lib/yaml.mjs')).default;
