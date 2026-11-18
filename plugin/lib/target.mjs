// Shared helpers: locate the project root, load a target definition, resolve its source directory.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import YAML from 'yaml';

/** Project root: explicit argument, else CLAUDE_PROJECT_DIR (set for hooks), else the working directory. */
export function projectRoot(explicit) {
  return path.resolve(explicit || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

export function targetDir(root, name) {
  return path.join(root, 'targets', name);
}

/** Names of every folder under targets/ that holds a target.yaml. */
export function listTargets(root) {
  const dir = path.join(root, 'targets');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'target.yaml')))
    .map((d) => d.name)
    .sort();
}

/**
 * Load targets/<name>/target.yaml and resolve the source directory from the variable named by source.dir_env.
 * The process environment wins over targets/<name>/.env, so CI can override a local value.
 */
export function loadTarget(root, name) {
  const dir = targetDir(root, name);
  const file = path.join(dir, 'target.yaml');
  if (!fs.existsSync(file)) throw new Error(`no target definition at ${file}`);
  const def = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  const envFile = path.join(dir, '.env');
  const env = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const key = def.source?.dir_env;
  if (!key) throw new Error(`${file}: source.dir_env is missing`);
  const value = process.env[key] || env[key];
  if (!value) throw new Error(`${key} is not set (expected in ${envFile} or the environment)`);
  return { name, dir, def, env, sourceDir: path.resolve(value) };
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows, like the file system. */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Read all of stdin (hook input). */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
