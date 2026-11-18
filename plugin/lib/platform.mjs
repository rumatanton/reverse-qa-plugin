// What reverse-qa can do for an app, decided from its files and its target.yaml. Two plug points, nothing else is
// tied to a technology:
//   pack    how the source becomes an inventory. `php` parses PHP; `generic` reads any language (files, SQL strings,
//           outbound URLs, route hints) and pages then come from the running app (crawl-app) or an OpenAPI spec.
//   driver  how tests drive the app. `web` (browser), `api` (HTTP) and `electron` (a desktop app built with Electron,
//           driven through its own windows) are built on Playwright; `appium` (mobile, and desktop apps that are not
//           Electron) is described in templates/DRIVERS.md and not built yet.
// Analysis, requirements, user stories, test cases and bug reports need neither: they work for every app.
import fs from 'node:fs';
import path from 'node:path';

/** App kinds and the driver each one uses by default. status: built = tested here; planned = contract written, not built. */
export const KINDS = {
  web: { driver: 'web', status: 'built', automation: 'browser tests on every tier (Playwright)' },
  api: { driver: 'api', status: 'built', automation: 'HTTP tests: endpoints, authorization, security (Playwright request)' },
  mobile: { driver: 'appium', status: 'planned', automation: 'needs the Appium driver (templates/DRIVERS.md)' },
  desktop: { driver: 'appium', status: 'planned', automation: 'needs the Appium driver (templates/DRIVERS.md), unless the app is built with Electron (app.driver: electron)' },
};

/**
 * Drivers a kind does not get by default. A desktop app built with Electron needs no Appium and no emulator: its
 * windows are web pages, so Playwright starts the app and drives them. Chosen by target.yaml `app.driver: electron`,
 * or by `source.stack: electron` when no driver is named.
 */
export const DRIVERS = {
  electron: { kinds: ['desktop'], status: 'built', automation: 'the app is started and driven through its own windows (Playwright): smoke, accessibility, journeys, crawl' },
};

/** The driver for a target, as { driver, status, automation }: the kind's default, or the one target.yaml names. */
export function driverFor(def) {
  const kind = def.app?.kind ?? 'web';
  const k = KINDS[kind];
  if (!k) throw new Error(`target.yaml app.kind "${kind}" is not one of ${Object.keys(KINDS).join(', ')}`);
  const named = def.app?.driver ?? (kind === 'desktop' && def.source?.stack === 'electron' ? 'electron' : k.driver);
  if (named === k.driver) return { driver: k.driver, status: k.status, automation: k.automation };
  const d = DRIVERS[named];
  if (!d || !d.kinds.includes(kind)) throw new Error(`target.yaml app.driver "${named}" is not a driver for a ${kind} app (${[k.driver, ...Object.keys(DRIVERS).filter((n) => DRIVERS[n].kinds.includes(kind))].join(', ')})`);
  return { driver: named, status: d.status, automation: d.automation };
}

/** Stacks with a dedicated rule pack. Every other stack is scanned by the generic pack. */
export const DEDICATED_PACKS = { php: 'php' };
export const packFor = (stack) => DEDICATED_PACKS[stack] ?? 'generic';

/**
 * Where the server log is inside the app container, or null when none is configured: runtime.error_log
 * (runtime.php_error_log is its older name). A PHP target started from the plugin's runtime template logs to
 * /var/log/php/error.log without being told.
 */
export function serverLogPath(def) {
  const rt = def.runtime ?? {};
  return rt.error_log ?? rt.php_error_log ?? (packFor(def.source?.stack) === 'php' && rt.compose_file ? '/var/log/php/error.log' : null);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', '.idea', '.vscode', 'Pods', '__pycache__', '.venv', 'venv', '.next', 'coverage']);
const read = (file, max = 200_000) => {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

/** Relative paths of the files under dir, at most `depth` folders deep, skipping dependency and build folders. */
export function listFiles(dir, depth = 5, limit = 20_000) {
  const out = [];
  const walk = (rel, d) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) out.push(`${r}/`);
        else if (!SKIP_DIRS.has(e.name) && d < depth) walk(r, d + 1);
      } else out.push(r);
    }
  };
  walk('', 0);
  return out;
}

// Each rule: the stack it names, the kind of app it points to (null = no hint), and how it is recognised.
// `files` = relative paths; `text(rel)` = the start of a file's content.
const RULES = [
  { stack: 'flutter', kind: 'mobile', label: 'Flutter', find: (f, text) => f.filter((p) => path.basename(p) === 'pubspec.yaml' && /^\s*flutter\s*:/m.test(text(p))) },
  { stack: 'react-native', kind: 'mobile', label: 'React Native', find: (f, text) => f.filter((p) => path.basename(p) === 'package.json' && /"react-native"\s*:/.test(text(p))) },
  { stack: 'android', kind: 'mobile', label: 'Android (native)', find: (f) => f.filter((p) => path.basename(p) === 'AndroidManifest.xml') },
  { stack: 'ios', kind: 'mobile', label: 'iOS (native)', find: (f) => f.filter((p) => /\.xc(odeproj|workspace)\/$/.test(p)) },
  { stack: 'electron', kind: 'desktop', label: 'Electron', find: (f, text) => f.filter((p) => path.basename(p) === 'package.json' && /"electron"\s*:/.test(text(p))) },
  { stack: 'dotnet-desktop', kind: 'desktop', label: '.NET desktop (WPF or Windows Forms)', find: (f, text) => f.filter((p) => /\.(cs|vb)proj$/.test(p) && /<UseWPF>\s*true|<UseWindowsForms>\s*true/i.test(text(p))) },
  { stack: 'java-desktop', kind: 'desktop', label: 'Java desktop (Swing or JavaFX)', find: (f, text) => f.filter((p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p) && /javafx|org\.openjfx/i.test(text(p))) },
  { stack: 'php', kind: null, label: 'PHP', find: (f) => { const php = f.filter((p) => p.endsWith('.php')); return php.length >= 3 || f.includes('composer.json') ? [f.includes('composer.json') ? 'composer.json' : php[0]] : []; } },
  { stack: 'java-spring', kind: null, label: 'Java (Spring)', find: (f, text) => f.filter((p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p) && /spring-boot|org\.springframework/i.test(text(p))) },
  { stack: 'java', kind: null, label: 'Java', find: (f) => f.filter((p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p)) },
  { stack: 'dotnet', kind: null, label: '.NET (ASP.NET)', find: (f, text) => f.filter((p) => /\.(cs|vb)proj$/.test(p) && /Microsoft\.NET\.Sdk\.Web/i.test(text(p))) },
  { stack: 'python', kind: null, label: 'Python', find: (f, text) => f.filter((p) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(p) && /django|flask|fastapi/i.test(text(p))) },
  { stack: 'node', kind: null, label: 'Node.js', find: (f, text) => f.filter((p) => path.basename(p) === 'package.json' && /"(express|fastify|koa|next|@nestjs\/core|hapi|@hapi\/hapi)"\s*:/.test(text(p))) },
  { stack: 'ruby', kind: null, label: 'Ruby (Rails)', find: (f, text) => f.filter((p) => path.basename(p) === 'Gemfile' && /rails/i.test(text(p))) },
  { stack: 'go', kind: null, label: 'Go', find: (f) => f.filter((p) => path.basename(p) === 'go.mod') },
];

const SPEC_NAME = /(^|\/)(openapi|swagger|api-docs)[^/]*\.(ya?ml|json)$/i;
const PAGE_FILE = /\.(html?|php|jsp|jspx|cshtml|razor|erb|twig|ftl|vue|tsx|jsx|svelte)$/i;

/**
 * Look at a source tree and say what it is. Returns { stacks: [{ stack, label, kind, evidence }], stack, kind,
 * openapi, compose, reasons }: `stack` is the first match (most specific rules come first), `kind` is a hint the
 * person can override, `reasons` says in plain words why.
 */
export function detect(sourceDir) {
  const files = listFiles(sourceDir);
  const text = (rel) => read(path.join(sourceDir, rel));
  const stacks = [];
  for (const r of RULES) {
    const hits = r.find(files, text);
    if (hits.length && !stacks.some((s) => s.stack === r.stack)) stacks.push({ stack: r.stack, label: r.label, kind: r.kind, evidence: hits[0] });
  }
  const openapi = files.find((p) => SPEC_NAME.test(p) && /["']?(openapi|swagger)["']?\s*:/.test(text(p).slice(0, 2000))) ?? null;
  const compose = files.find((p) => /^(docker-)?compose\.ya?ml$/.test(p)) ?? null;
  const pageFiles = files.filter((p) => PAGE_FILE.test(p)).length;
  const reasons = [];
  let kind = stacks.find((s) => s.kind)?.kind ?? null;
  if (kind) reasons.push(`${stacks.find((s) => s.kind).label} project (${stacks.find((s) => s.kind).evidence})`);
  else if (openapi && pageFiles === 0) {
    kind = 'api';
    reasons.push(`an API spec (${openapi}) and no page templates`);
  } else {
    kind = 'web';
    reasons.push(pageFiles ? `${pageFiles} page template file(s)` : 'no mobile or desktop project files, so a web app is assumed');
  }
  return { stacks, stack: stacks[0]?.stack ?? 'unknown', kind, openapi, compose, reasons, ...(stacks[0]?.stack === 'electron' ? { electron: electronStart(sourceDir, stacks[0].evidence) } : {}) };
}

/**
 * How an Electron app starts, read from its files: { main, start_page }. `main` is the script package.json names;
 * `start_page` is the page that script opens first with loadFile('…'), relative to the source folder, or null when
 * the code builds the path some other way (the person then writes it in target.yaml).
 */
export function electronStart(sourceDir, packageFile = 'package.json') {
  const appDir = path.dirname(path.join(sourceDir, packageFile));
  let main = 'index.js';
  try {
    main = JSON.parse(read(path.join(sourceDir, packageFile))).main ?? main;
  } catch { /* no readable package.json: keep the default */ }
  const call = read(path.join(appDir, main)).match(/\.loadFile\(([^;]*?)\)\s*;?/);
  const parts = call ? [...call[1].matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]) : [];
  const page = parts.length && /\.html?$/i.test(parts.at(-1)) ? path.join(path.dirname(path.join(appDir, main)), ...parts) : null;
  return { main, start_page: page && fs.existsSync(page) ? path.relative(sourceDir, page).split(path.sep).join('/') : null };
}

/**
 * What applies to a target, from its target.yaml: which steps can run and why not. Scripts use it to answer with a
 * clear reason instead of failing somewhere deep ("no database configured", not a stack trace).
 */
export function capabilities(def) {
  const kind = def.app?.kind ?? 'web';
  const d = driverFor(def);
  const rt = def.runtime ?? {};
  return {
    kind,
    driver: d.driver,
    automation: d.status === 'built',
    automation_note: d.automation,
    pack: packFor(def.source?.stack),
    source: Boolean(def.source?.dir_env),
    // how tests reach the app: containers the plugin starts, a URL, or (a desktop app) the app started on this machine
    runtime: rt.compose_file ? 'compose' : rt.base_url ? 'url' : d.driver === 'electron' && rt.app?.start_page ? 'app' : null,
    database: Boolean(def.database?.name),
    server_log: Boolean(serverLogPath(def)),
    upgrade: Boolean(rt.upgrade_base_url),
    openapi: Boolean(def.api?.openapi),
  };
}

/** The support table, as rows a script can print: what works for this kind of app today. */
export function supportRows(caps) {
  const yes = (ok, note) => ({ ok, note });
  const needs = caps.driver === 'electron' ? 'needs runtime.app.start_page (the page the app opens first)' : 'needs runtime.base_url';
  return [
    ['Architecture, security, roles, workflows (cited)', yes(caps.source, caps.source ? 'any language' : 'needs the source (source.dir_env)')],
    ['Requirements, user stories, risk register, test cases, bug reports', yes(caps.source, caps.source ? 'any language' : 'needs the source')],
    ['Inventory from the source', yes(caps.source, caps.pack === 'generic' ? 'generic pack: files, SQL, outbound URLs, route hints' : `${caps.pack} pack: parsed`)],
    ['Inventory from the running app', yes(caps.runtime !== null && caps.automation, caps.runtime === null ? needs : caps.kind === 'api' || caps.openapi ? 'OpenAPI spec' + (caps.kind === 'web' ? ' and crawl' : '') : caps.automation ? 'crawl-app' : 'needs the driver')],
    ['Automated tests', yes(caps.automation && caps.runtime !== null, caps.runtime === null && caps.automation ? needs : caps.automation_note)],
    ['Database reset, snapshots and data checks', yes(caps.database && caps.runtime === 'compose', caps.database ? (caps.runtime === 'compose' ? 'through the db container' : 'needs runtime.compose_file') : 'no database configured (optional)')],
    ['Server log watched during tests', yes(caps.server_log && caps.runtime === 'compose', caps.server_log ? 'runtime.error_log' : 'no log configured (optional)')],
    ['Upgrade comparison (two versions, same tests)', yes(caps.upgrade, caps.upgrade ? 'runtime.upgrade_base_url' : 'no second version configured (optional)')],
  ].map(([what, v]) => ({ what, ...v }));
}
