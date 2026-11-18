#!/usr/bin/env node
// scaffold-framework: create targets/<name>/framework from plugin/templates/framework, install it (pinned Playwright,
// axe, Xray JUnit reporter, browsers), add the test agents and skills (Playwright planner/generator/healer with
// prompts, the playwright-cli and playwright-trace skills, Grafana's k6 skills without the paid Grafana Cloud ones),
// then prove the framework loads (`playwright test --list`).
//   node scaffold.mjs --target <name> [--force] [--no-install] [--no-agents]
//   exit 0 = ready, 1 = usage or a step failed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { appendLedger } from '../../lib/ledger.mjs';
import { capabilities } from '../../lib/platform.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'templates', 'framework');
const K6_CLOUD_SKILLS = new Set(['k6-cloud-investigate-test', 'k6-manage', 'k6-trend-analysis']); // need paid Grafana Cloud
const TEXT = /\.(ts|mjs|js|json|md|ya?ml|txt|gitignore)$|^\.gitignore$/;

/** Template folders only a browser can run: left out for an API target (templates/DRIVERS.md). */
export const BROWSER_ONLY = ['tests/a11y/', 'tests/visual/', 'tests/t0-smoke/', 'crawl/'];
/**
 * Template folders a desktop app has no use for: it has no HTTP surface of its own (the API tier, and the role matrix
 * asked over HTTP), and the visual tier is not built for app windows yet.
 */
export const NOT_FOR_DESKTOP = ['tests/api/', 'tests/t3-roles/', 'tests/visual/'];

/**
 * Copy the template; never overwrite an existing file unless force. Returns { dir, written, skipped, kind }.
 * The app kind (target.yaml app.kind) decides what is copied: a web app gets every tier, an API gets the HTTP tiers
 * only, a desktop app built with Electron gets the tiers that open its windows, and a kind with no driver yet (mobile,
 * other desktop apps) is refused with the reason.
 */
export function renderTemplate(target, { force = false, templateDir = TEMPLATE } = {}) {
  const caps = capabilities(target.def);
  if (!caps.automation) throw new Error(`no test framework for a ${caps.kind} app yet: ${caps.automation_note}. Everything up to the test cases works without it.`);
  const leftOut = (r) => (caps.kind === 'api' && BROWSER_ONLY.some((p) => r.startsWith(p))) || (caps.driver === 'electron' && NOT_FOR_DESKTOP.some((p) => r.startsWith(p)));
  const dir = path.join(target.dir, 'framework');
  const written = [];
  const skipped = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(templateDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      if (leftOut(r)) continue;
      const dest = path.join(dir, r);
      if (fs.existsSync(dest) && !force) {
        skipped.push(r);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const raw = fs.readFileSync(path.join(templateDir, r));
      fs.writeFileSync(dest, TEXT.test(e.name) ? raw.toString('utf8').replaceAll('__TARGET__', target.name) : raw);
      written.push(r);
    }
  };
  walk('');
  // A plugin installed from a marketplace is not at <repo>/plugin: tell the framework where it is (machine-specific, gitignored).
  const pointer = path.join(dir, '.rqa-plugin-path');
  if (path.resolve(target.dir, '..', '..', 'plugin') !== PLUGIN_ROOT) fs.writeFileSync(pointer, `${PLUGIN_ROOT}\n`);
  else if (fs.existsSync(pointer)) fs.rmSync(pointer);
  return { dir, written, skipped, kind: caps.kind, driver: caps.driver };
}

/** Run a command line in dir (shell form so npm/npx .cmd shims work on Windows). Throws on failure. */
export function sh(cmd, dir, { env = {}, quiet = false } = {}) {
  const r = spawnSync(cmd, { cwd: dir, shell: true, env: { ...process.env, ...env }, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`"${cmd}" failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-1500)}`);
  return r.stdout ?? '';
}

/** Install the framework. An API target sends HTTP requests only, and a desktop app is its own browser: neither needs browsers. */
export function install(dir, { browsers = true } = {}) {
  sh('npm install --no-audit --no-fund', dir);
  if (browsers) sh('npx playwright install chromium firefox webkit', dir);
}

const LESSONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-lessons');
// The section's heading, with or without "- Memory": a target scaffolded before the section was renamed carries the older one.
const LESSONS_HEAD = /^## Lessons from real runs[^\n]*\(reverse-qa\)[ \t]*\r?$/m;

/**
 * Add the plugin's lessons (agent-lessons/<role>.md) to each Playwright agent init-agents wrote. The section is
 * replaced on every run, so regenerating the agents keeps them and nothing is added twice. Returns the agents updated.
 */
export function applyAgentLessons(dir) {
  const done = [];
  for (const role of ['planner', 'generator', 'healer']) {
    const agent = path.join(dir, '.claude', 'agents', `playwright-test-${role}.md`);
    const lessons = path.join(LESSONS_DIR, `${role}.md`);
    if (!fs.existsSync(agent) || !fs.existsSync(lessons)) continue;
    const text = fs.readFileSync(agent, 'utf8');
    const at = text.search(LESSONS_HEAD);
    const base = (at === -1 ? text : text.slice(0, at)).trimEnd();
    fs.writeFileSync(agent, `${base}\n\n${fs.readFileSync(lessons, 'utf8').trim()}\n`);
    done.push(role);
  }
  return done;
}

/** Playwright's agents and skills, plus Grafana's k6 skills merged in (one .mcp.json for both). */
export function initAgents(dir) {
  sh('npx playwright init-agents --loop=claude --prompts', dir);
  applyAgentLessons(dir);
  sh('npx playwright cli install --skills', dir);
  const trace = path.join(dir, 'node_modules', 'playwright-core', 'lib', 'tools', 'skills', 'playwright-trace');
  if (fs.existsSync(trace)) fs.cpSync(trace, path.join(dir, '.claude', 'skills', 'playwright-trace'), { recursive: true });
  const k6 = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-k6-'));
  const copied = [];
  try {
    sh('k6 x agent init claude-code', k6, { quiet: true });
    const skills = path.join(k6, '.claude', 'skills');
    for (const s of fs.existsSync(skills) ? fs.readdirSync(skills) : []) {
      if (K6_CLOUD_SKILLS.has(s)) continue;
      fs.cpSync(path.join(skills, s), path.join(dir, '.claude', 'skills', s), { recursive: true });
      copied.push(s);
    }
    const mcpFile = path.join(dir, '.mcp.json');
    const mcp = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : { mcpServers: {} };
    const k6Mcp = path.join(k6, '.mcp.json');
    if (fs.existsSync(k6Mcp)) Object.assign(mcp.mcpServers, JSON.parse(fs.readFileSync(k6Mcp, 'utf8')).mcpServers);
    fs.writeFileSync(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`);
  } finally {
    fs.rmSync(k6, { recursive: true, force: true });
  }
  return { k6Skills: copied };
}

/** The framework loads and the unit project collects (no browser, no app needed). Returns the test count. */
export function verify(dir) {
  const out = sh('npx playwright test --list --project=unit', dir, { env: { RQA_SKIP_SETUP: '1' }, quiet: true });
  const m = out.match(/Total: (\d+) tests? in (\d+) files?/);
  if (!m) throw new Error(`playwright test --list gave no total:\n${out.slice(-800)}`);
  return Number(m[1]);
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, force: { type: 'boolean' }, 'no-install': { type: 'boolean' }, 'no-agents': { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: scaffold.mjs --target <name> [--force] [--no-install] [--no-agents]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const r = renderTemplate(target, { force: values.force });
    process.stdout.write(`scaffold-framework: ${r.written.length} file(s) written, ${r.skipped.length} kept as they were, in ${r.dir}\n`);
    let agents = null;
    let unitTests = null;
    if (!values['no-install']) {
      const web = r.kind === 'web';
      install(r.dir, { browsers: web });
      process.stdout.write(`scaffold-framework: dependencies${web ? ' and browsers' : ''} installed${web ? '' : r.driver === 'electron' ? ' (a desktop app is started itself: no browser needed)' : ' (an API target needs no browser)'}\n`);
      if (!values['no-agents'] && web) { // Playwright's planner, generator and healer drive a browser
        agents = initAgents(r.dir);
        process.stdout.write(`scaffold-framework: Playwright agents, prompts and skills added; k6 skills: ${agents.k6Skills.join(', ') || 'none'}\n`);
      }
      unitTests = verify(r.dir);
      process.stdout.write(`scaffold-framework: playwright test --list OK (${unitTests} unit tests collected)\n`);
    }
    const lessoned = applyAgentLessons(r.dir); // also refreshes agents an earlier run installed, with --no-install too
    if (lessoned.length) process.stdout.write(`scaffold-framework: lessons from real runs added to the Playwright ${lessoned.join(', ')} agents\n`);
    appendLedger(target.dir, 'scaffold-framework', { written: r.written.length, skipped: r.skipped.length, k6Skills: agents?.k6Skills ?? null, unitTests });
    return 0;
  } catch (err) {
    process.stderr.write(`scaffold-framework: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
