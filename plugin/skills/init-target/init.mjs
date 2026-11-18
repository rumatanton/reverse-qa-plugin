#!/usr/bin/env node
// init-target: put a new app under reverse-qa. Looks at the source, says what kind of app it is and what the tool can
// do for it today, writes targets/<name>/target.yaml (and .env with the source path), and checks the prerequisites.
//   node init.mjs --name <app> --source <dir> [--url <base url>] [--compose <file>] [--openapi <file|url>]
//                 [--kind web|api|mobile|desktop] [--root <project>] [--force]
//   node init.mjs --detect --source <dir>            only say what the app is
//   node init.mjs --doctor --target <name>           check an existing target's prerequisites
//   exit 0 = done / all checks pass, 2 = a required check failed, 1 = usage or configuration problem
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget, targetDir } from '../../lib/target.mjs';
import { detect, capabilities, supportRows, packFor, KINDS } from '../../lib/platform.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);
const slash = (p) => p.split(path.sep).join('/');
/** Written once into targets/<name>/: what must never be committed from a target folder, wherever the workspace is. */
export const TARGET_GITIGNORE = [
  '# Written by init-target. Secrets, per-machine state and run archives stay out of git.',
  '.env',
  '*.env',
  '!.env.example',
  '.runtime/',
  '**/.auth/',
  'output/runs/',
  'output/bugs/publish-preview.json',
  '',
].join('\n');

/** The target.yaml text for a new target. Comments say what each block is for; only blocks that apply are written. */
export function targetYaml({ name, detected, kind, url = null, compose = null, openapi = null, date }) {
  const stack = detected.stack;
  const pack = packFor(stack);
  const host = url ? new URL(url).hostname : null;
  const hosts = ['localhost', '127.0.0.1', ...(host && !LOCAL.has(host) ? [host] : [])];
  const found = detected.stacks.find((s) => s.stack === stack);
  const electron = kind === 'desktop' && stack === 'electron';
  const startPage = electron ? detected.electron?.start_page ?? null : null;
  const lines = [
    `# reverse-qa target, written by init-target on ${date}. What is here is yours to state (where the app is and how to`,
    '# reach it). What the app does is discovered by /reverse-qa:recon. Lines marked TODO need you.',
    '',
    `name: ${name}`,
    'description: "TODO: one line about the app"',
    '',
    'app:',
    `  kind: ${kind}   # web | api | mobile | desktop. Detected: ${detected.reasons.join('; ')}`,
    ...(electron ? ['  driver: electron   # tests start the app itself and drive its windows (no Appium, no emulator)'] : []),
    '',
    'source:',
    `  dir_env: TARGET_DIR   # absolute path of the source, set in targets/${name}/.env. The plugin only reads it`,
    `  stack: ${stack}   # ${found ? `${found.label}, from ${found.evidence}` : 'no project file names a framework'}; read by the ${pack} pack`,
    '  scan_exclude: [.git]   # folders the scan skips (binary assets, generated code)',
    '',
  ];
  if (electron && !url && !compose) {
    lines.push(
      'runtime:   # how tests reach the app: each test starts its own copy of it on this machine',
      '  app:',
      startPage ? `    start_page: ${startPage}   # the page the app opens first, relative to the source. Every screen address is under its folder` : '    # start_page: renderer/index.html   # TODO: the page the app opens first, relative to the source. Tests need it',
      '    # main: .   # what Electron is given to run, relative to the source (default: the folder with package.json)',
      '    # executable: dist/MyApp.exe   # a packaged app to start instead of the source',
      '',
    );
  } else if (url || compose) {
    lines.push('runtime:   # how tests reach the app');
    if (url) lines.push(`  base_url: ${url.endsWith('/') ? url : `${url}/`}`);
    if (compose) lines.push(`  compose_file: ${compose}   # lets the plugin start, stop and reset the app`, '  services: { app: TODO }   # the compose service that serves the app (add db: <service> for database checks)');
    else lines.push('  # compose_file: docker-compose.yml   # add this to let the plugin start, stop and reset the app');
    lines.push('  # error_log: /path/in/the/app/container.log   # a server log to watch during tests (needs compose_file)', '');
  } else lines.push('# runtime:   # no URL given: analysis, requirements, user stories and test cases still work.', '#   base_url: http://localhost:8080/   # add this to crawl the app and run tests', '');
  if (openapi) lines.push('api:', `  openapi: ${openapi}   # endpoints are read from this spec`, '');
  lines.push(
    '# database:   # optional: lets tests reset the data, snapshot rows and check database effects',
    '#   engine: mariadb:10.4',
    '#   name: TODO',
    '#   user: TODO',
    '',
    'test_accounts: {}   # TODO: one entry per role that logs in. See the README, "Test accounts"',
    '',
    'safety:',
    `  allowed_test_hosts: [${hosts.join(', ')}]   # tests may only reach these hosts`,
    '  never_test: []   # TODO: production hosts, so no test can ever reach them',
    '',
  );
  return lines.join('\n');
}

/** Prerequisite checks for a target: [{ level: 'PASS' | 'FAIL' | 'NOTE', what, detail }]. */
export async function doctor(target, { fetchImpl = fetch } = {}) {
  const out = [];
  const add = (level, what, detail = '') => out.push({ level, what, detail });
  const def = target.def;
  let caps;
  try {
    caps = capabilities(def);
  } catch (err) {
    return [{ level: 'FAIL', what: 'target.yaml', detail: err.message }];
  }
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'PASS' : 'FAIL', 'Node.js 22 or newer', `found ${process.versions.node}`);
  add(fs.existsSync(path.join(PLUGIN, 'node_modules', 'yaml')) ? 'PASS' : 'FAIL', 'plugin dependencies installed', 'run "npm ci" in the plugin folder if this fails');
  add(fs.existsSync(target.sourceDir) && fs.statSync(target.sourceDir).isDirectory() ? 'PASS' : 'FAIL', 'source folder exists', target.sourceDir);
  const needsDocker = caps.pack !== 'generic' || caps.runtime === 'compose';
  if (needsDocker) add(dockerAvailable() ? 'PASS' : 'FAIL', 'Docker engine running', caps.pack !== 'generic' ? `the ${caps.pack} pack runs in a container` : 'runtime.compose_file starts the app in containers');
  else add('NOTE', 'Docker not needed', `the generic pack runs in Node and the app is ${caps.driver === 'electron' ? 'started on this machine' : 'reached by URL'}`);
  if (caps.runtime === 'compose') {
    const file = path.resolve(target.dir, def.runtime.compose_file);
    add(fs.existsSync(file) ? 'PASS' : 'FAIL', 'compose file exists', file);
  }
  if (def.runtime?.base_url) {
    const url = def.runtime.base_url;
    const host = new URL(url).hostname.toLowerCase();
    const allowed = (def.safety?.allowed_test_hosts ?? ['localhost', '127.0.0.1']).map((h) => h.toLowerCase());
    const never = (def.safety?.never_test ?? []).map((h) => h.toLowerCase());
    add(allowed.includes(host) && !never.includes(host) ? 'PASS' : 'FAIL', 'base URL host is allowed for tests', `${host} must be in safety.allowed_test_hosts and not in safety.never_test`);
    if (!LOCAL.has(host)) add('NOTE', `tests will send requests to ${host}`, 'use a test environment, never production');
    if (allowed.includes(host) && !never.includes(host)) {
      try {
        const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
        add('PASS', 'the app answers at the base URL', `HTTP ${res.status}`);
      } catch (err) {
        add(caps.runtime === 'compose' ? 'NOTE' : 'FAIL', 'the app answers at the base URL', caps.runtime === 'compose' ? 'not running yet: run-target-app starts it' : `no answer from ${url} (${err.cause?.code ?? err.message})`);
      }
    }
  } else if (caps.driver === 'electron') {
    const app = def.runtime?.app ?? {};
    const start = app.start_page ? path.resolve(target.sourceDir, app.start_page) : null;
    add(start && fs.existsSync(start) ? 'PASS' : 'FAIL', "the app's start page exists", start ?? 'set runtime.app.start_page in target.yaml: the page the app opens first');
    const program = app.executable ? path.resolve(target.sourceDir, app.executable) : path.join(target.sourceDir, 'node_modules', 'electron');
    add(fs.existsSync(program) ? 'PASS' : 'FAIL', app.executable ? 'the packaged app exists' : 'Electron is installed in the source folder', app.executable ? program : 'run "npm install" in the source folder if this fails');
  } else add('NOTE', 'no runtime.base_url', 'analysis, requirements, user stories and test cases work; crawling and tests need a URL');
  if (def.api?.openapi && !/^https?:/i.test(def.api.openapi)) {
    const found = [path.resolve(target.sourceDir, def.api.openapi), path.resolve(target.dir, def.api.openapi)].some((f) => fs.existsSync(f));
    add(found ? 'PASS' : 'FAIL', 'API spec exists', def.api.openapi);
  }
  if (!caps.automation) add('NOTE', `no driver built yet for ${caps.kind} apps`, `${caps.automation_note}; everything up to test cases works`);
  if (caps.automation && (def.runtime?.base_url || caps.runtime === 'app') && Object.keys(def.test_accounts ?? {}).length === 0) add('NOTE', 'no test accounts', 'only what a visitor can reach will be crawled and tested');
  const tool = (cmd) => spawnSync(`${cmd} --version`, { shell: true, encoding: 'utf8' }).status === 0; // cmd is a fixed name
  add(tool('git') ? 'PASS' : 'NOTE', 'git available', 'used to pin the commit under test');
  if (def.perf) add(tool('k6') ? 'PASS' : 'NOTE', 'k6 available', 'run-perf needs it');
  return out;
}

const table = (rows) => rows.map((r) => `  ${r.ok ? 'yes' : 'no '}  ${r.what}${r.note ? ` (${r.note})` : ''}`).join('\n');

/** What to run next, in order, for a new target. */
export function nextSteps(name, caps) {
  const s = [`Fill the TODO lines in targets/${name}/target.yaml (description, test accounts, production hosts).`];
  if (caps.runtime === 'compose') s.push('run-target-app: start the app.');
  const crawls = caps.kind === 'web' || caps.driver === 'electron'; // an app with pages a role can walk
  if (caps.runtime && caps.automation && crawls) s.push('scaffold-framework, then crawl-app: record the pages each role can reach.');
  s.push(`scan-repo: build the inventory${caps.pack === 'generic' ? ' (generic pack' + (caps.openapi ? ', API spec' : '') + (caps.runtime && crawls ? ', crawl' : '') + ')' : ''}.`);
  s.push(`/reverse-qa:recon ${name}: architecture, security, roles, workflows, requirements, user stories, then the review gate.`);
  s.push(caps.automation && caps.runtime ? 'After the review: test cases, the test framework, the runs and the reports.' : `After the review: test cases. Automated tests: ${caps.automation ? (caps.driver === 'electron' ? 'add runtime.app.start_page' : 'add runtime.base_url') : caps.automation_note}.`);
  return s;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { name: { type: 'string' }, source: { type: 'string' }, url: { type: 'string' }, compose: { type: 'string' }, openapi: { type: 'string' }, kind: { type: 'string' }, root: { type: 'string' }, target: { type: 'string' }, force: { type: 'boolean' }, detect: { type: 'boolean' }, doctor: { type: 'boolean' } } });
  const usage = 'usage: init.mjs --name <app> --source <dir> [--url <base url>] [--compose <file>] [--openapi <file|url>] [--kind web|api|mobile|desktop] [--force]\n       init.mjs --detect --source <dir>\n       init.mjs --doctor --target <name>\n';
  try {
    const root = projectRoot(values.root);
    if (values.doctor) {
      if (!values.target) { process.stderr.write(usage); return 1; }
      const checks = await doctor(loadTarget(root, values.target));
      for (const c of checks) process.stdout.write(`${c.level}  ${c.what}${c.detail ? `: ${c.detail}` : ''}\n`);
      const failed = checks.filter((c) => c.level === 'FAIL').length;
      process.stdout.write(`init-target: ${failed ? `${failed} check(s) failed` : 'ready'}\n`);
      return failed ? 2 : 0;
    }
    if (!values.source) { process.stderr.write(usage); return 1; }
    const source = path.resolve(values.source);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`no folder at ${source}`);
    const detected = detect(source);
    const kind = values.kind ?? detected.kind;
    if (!KINDS[kind]) throw new Error(`--kind must be one of ${Object.keys(KINDS).join(', ')}`);
    const openapi = values.openapi ?? detected.openapi;
    process.stdout.write(`init-target: ${detected.stacks.length ? detected.stacks.map((s) => `${s.label} (${s.evidence})`).join(', ') : 'no known project file'}; a ${kind} app${values.kind ? ' (as you said)' : ` (${detected.reasons.join('; ')})`}${openapi ? `; API spec ${openapi}` : ''}\n`);
    if (values.detect) return 0;
    if (!values.name || !/^[a-z0-9][a-z0-9-]*$/.test(values.name)) throw new Error('--name is required: lower-case letters, digits and dashes');
    if (values.url) new URL(values.url); // throws on a malformed URL
    const dir = targetDir(root, values.name);
    const file = path.join(dir, 'target.yaml');
    if (fs.existsSync(file) && !values.force) throw new Error(`${slash(path.relative(root, file))} already exists (use --force to replace it)`);
    const compose = values.compose ? slash(path.resolve(values.compose)) : null;
    const text = targetYaml({ name: values.name, detected, kind, url: values.url ?? null, compose, openapi, date: new Date().toISOString().slice(0, 10) });
    const def = YAML.parse(text); // the file must load before it is written
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    fs.writeFileSync(path.join(dir, '.env'), `TARGET_DIR=${slash(source)}\n`);
    fs.writeFileSync(path.join(dir, '.env.example'), '# Copy to .env (never committed) and set the path of the app\'s source on this machine.\nTARGET_DIR=\n');
    // The workspace may be any folder, with no .gitignore of its own: the target folder keeps its secrets out of git.
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, TARGET_GITIGNORE);
    const caps = capabilities(def);
    process.stdout.write(`init-target: wrote ${slash(path.relative(root, file))}, .env and .gitignore (the source path and test accounts stay out of git)\n\nWhat works for this app today:\n${table(supportRows(caps))}\n\nNext:\n${nextSteps(values.name, caps).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`);
    const host = values.url ? new URL(values.url).hostname : null;
    if (host && !LOCAL.has(host)) process.stdout.write(`\ninit-target: tests will send requests to ${host}. Use a test environment, never production, and list production hosts under safety.never_test.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`init-target: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
