#!/usr/bin/env node
// scan-repo: inventory a target. The source is read by its stack's rule pack (a dedicated pack runs in Docker; every
// other stack is read by the generic pack, in Node), pages are added from an OpenAPI spec (target.yaml api.openapi)
// and from a crawl of the running app (output/scan/crawl.json, written by crawl-app), and everything is normalized
// into output/inventory.json, output/crud-matrix.csv and output/er.mmd.
//   node scan.mjs --target <name> [--root <project>] [--raw <pack-output.json>] [--fetch-openapi]
//   exit 0 = written, 1 = usage or configuration problem, 2 = the rule pack failed or broke its contract
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { docker, ok, runWithFiles } from '../../lib/docker.mjs';
import { parseDump } from '../../lib/sqldump.mjs';
import { validateRaw, normalize, crudCsv, erMermaid } from '../../lib/inventory.mjs';
import { appendLedger, writeOutput, outputDir } from '../../lib/ledger.mjs';
import { packFor } from '../../lib/platform.mjs';
import { endpointsFromSpec } from '../../lib/openapi.mjs';
import { crawlEndpoints } from '../../lib/crawl.mjs';
import { extract as extractGeneric } from '../../rules/generic/extract.mjs';

const RULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'rules');
const slash = (p) => p.split(path.sep).join('/');

/** How each stack's pack is invoked (rules/CONTRACT.md): inside its image, or `local` in this process. */
export const PACKS = {
  php: {
    defaultVersion: '7.2',
    extensions: ['.php'],
    scripts: ['extract.php'],
    command: ({ version }) => ['php', '-d', 'display_errors=stderr', '/rules/extract.php', '/src', '--php-version', version],
  },
  // any language, no parser and no image: files, SQL in string literals, outbound URLs, route hints
  generic: {
    local: (target) => extractGeneric(target.sourceDir, { exclude: target.def.source?.scan_exclude ?? [] }),
  },
};

/**
 * Copy the files a pack reads (by extension, minus scan_exclude) and its scripts into a temp folder, which
 * runWithFiles then copies into the container. Only those files leave the clone (not its PDFs or images), and
 * nothing is bind-mounted, because Docker Desktop bind mounts from some Windows folders hang. The caller removes it.
 */
export function stage(target, stack) {
  const pack = PACKS[stack];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-scan-'));
  const exclude = (target.def.source?.scan_exclude ?? []).map((e) => e.replace(/^\/+|\/+$/g, ''));
  const src = path.join(dir, 'src');
  let files = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(target.sourceDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (exclude.some((x) => r === x || r.startsWith(`${x}/`)) || e.name === '.git') continue;
      if (e.isDirectory()) walk(r);
      else if (pack.extensions.includes(path.extname(e.name).toLowerCase())) {
        fs.mkdirSync(path.join(src, path.dirname(r)), { recursive: true });
        fs.copyFileSync(path.join(target.sourceDir, r), path.join(src, r));
        files++;
      }
    }
  };
  fs.mkdirSync(src, { recursive: true });
  walk('');
  fs.mkdirSync(path.join(dir, 'rules'));
  for (const s of pack.scripts) fs.copyFileSync(path.join(RULES, stack, s), path.join(dir, 'rules', s));
  return { dir, files };
}

/** Image tag that changes whenever any file in the pack folder changes, so edits force a rebuild. */
export function packImageTag(stack, rulesDir = RULES) {
  const dir = path.join(rulesDir, stack);
  const hash = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) hash.update(f).update(fs.readFileSync(p));
  }
  return `rqa-rules-${stack}:${hash.digest('hex').slice(0, 12)}`;
}

export function ensureImage(stack) {
  const tag = packImageTag(stack);
  if (docker(['image', 'inspect', tag]).status !== 0) ok(docker(['build', '-q', '-t', tag, path.join(RULES, stack)], { timeout: 1_800_000 }), `building ${tag}`);
  return tag;
}

export function runPack(target) {
  const stack = packFor(target.def.source?.stack); // a stack with no dedicated pack is read by the generic one
  const pack = PACKS[stack];
  if (pack.local) return pack.local(target);
  const tag = ensureImage(stack);
  const version = String(target.def.source?.language_version ?? pack.defaultVersion);
  const staged = stage(target, stack);
  try {
    const r = ok(
      runWithFiles(tag, pack.command({ version }), [
        { from: path.join(staged.dir, 'src'), to: '/src' },
        { from: path.join(staged.dir, 'rules'), to: '/rules' },
      ], { createArgs: ['--network', 'none'] }),
      `rule pack ${stack}`,
    );
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
}

/** Parse the seed dump(s) named by source.seed_dump (a path or a list, relative to the source root). */
export function loadDump(target) {
  const spec = target.def.source?.seed_dump;
  if (!spec) return null;
  const sql = [spec].flat().map((rel) => fs.readFileSync(path.join(target.sourceDir, rel), 'utf8')).join('\n;\n');
  return parseDump(sql);
}

export function basePathOf(def) {
  const url = def.runtime?.base_url;
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    return '';
  }
}

/**
 * Pages known from outside the source: the OpenAPI spec named by target.yaml api.openapi (a path under the source
 * root or the target folder, or, for a URL, the copy --fetch-openapi saved in output/scan/) and the crawl record
 * crawl-app wrote. Returns { endpoints, notes }.
 */
export function loadEndpoints(target) {
  const endpoints = [];
  const notes = [];
  const out = outputDir(target.dir);
  const spec = target.def.api?.openapi;
  if (spec) {
    const isUrl = /^https?:/i.test(spec);
    const saved = ['openapi.json', 'openapi.yaml'].map((f) => path.join(out, 'scan', f)).find((f) => fs.existsSync(f));
    const local = isUrl ? saved : [path.resolve(target.sourceDir, spec), path.resolve(target.dir, spec)].find((f) => fs.existsSync(f));
    if (!local) throw new Error(isUrl ? `api.openapi is a URL (${spec}): save it first with "scan.mjs --fetch-openapi" while the app is running` : `api.openapi: no file at ${spec} (looked under the source root and the target folder)`);
    const inSource = !path.relative(target.sourceDir, local).startsWith('..');
    const cite = inSource ? slash(path.relative(target.sourceDir, local)) : `output/scan/${path.basename(local)}`;
    const r = endpointsFromSpec(fs.readFileSync(local, 'utf8'), { file: cite, baseUrl: target.def.runtime?.base_url ?? null });
    if (r.problems.length) throw new Error(`api.openapi (${cite}): ${r.problems.join('; ')}`);
    endpoints.push(...r.endpoints);
    notes.push(`${r.endpoints.length} endpoint(s) from ${cite}`);
  }
  const crawlFile = path.join(out, 'scan', 'crawl.json');
  if (fs.existsSync(crawlFile)) {
    const pages = crawlEndpoints(JSON.parse(fs.readFileSync(crawlFile, 'utf8')));
    endpoints.push(...pages);
    notes.push(`${pages.length} page(s) from the crawl`);
  }
  return { endpoints, notes };
}

/** Save the spec at a URL (api.openapi) to output/scan/, so scans cite a file that does not change under them. */
export async function fetchOpenapi(target) {
  const spec = target.def.api?.openapi;
  if (!/^https?:/i.test(spec ?? '')) throw new Error('api.openapi is not a URL: nothing to fetch');
  const { assertSafeUrls } = await import('../../lib/runtime.mjs');
  assertSafeUrls(target.def, [spec]);
  const res = await fetch(spec, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${spec}: HTTP ${res.status}`);
  const text = await res.text();
  let name = 'openapi.yaml';
  let body = text;
  try {
    body = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    name = 'openapi.json';
  } catch { /* YAML: keep it as served */ }
  for (const old of ['openapi.json', 'openapi.yaml']) fs.rmSync(path.join(outputDir(target.dir), 'scan', old), { force: true });
  return writeOutput(target.dir, path.join('scan', name), body);
}

/** Normalize raw pack output for a target and write the three output files. Returns the inventory. */
export function writeInventory(target, raw) {
  const problems = validateRaw(raw);
  if (problems.length) throw Object.assign(new Error(`rule pack output breaks the contract:\n  ${problems.join('\n  ')}`), { contract: true });
  const dump = loadDump(target);
  const extra = loadEndpoints(target);
  const { inventory, crudRows } = normalize(raw, dump, {
    endpoints: extra.endpoints,
    target: target.name,
    commit: target.def.commit ?? null,
    allowedHosts: target.def.safety?.allowed_test_hosts,
    basePath: basePathOf(target.def),
    outputBuffering: target.def.runtime?.output_buffering ?? null,
  });
  writeOutput(target.dir, 'scan/raw.json', `${JSON.stringify(raw, null, 2)}\n`);
  writeOutput(target.dir, 'inventory.json', `${JSON.stringify(inventory, null, 2)}\n`);
  writeOutput(target.dir, 'crud-matrix.csv', crudCsv(crudRows));
  writeOutput(target.dir, 'er.mmd', erMermaid(inventory.tables));
  appendLedger(target.dir, 'scan-repo', { pack: raw.pack, summary: inventory.summary, endpoints: extra.notes });
  return inventory;
}

export function summaryLine(s) {
  const names = { pack: 'the source', openapi: 'the API spec', crawl: 'the crawl' };
  const from = Object.entries(s.pages_from ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} from ${names[k]}`).join(', ');
  const hints = s.route_hints ? `, ${s.route_hints} route hints (${s.route_hints_unmatched} matched no page)` : '';
  const line = `scan-repo: ${s.files} files (${s.pages} pages${from ? `: ${from}` : ''}, ${s.includes} includes, ${s.parse_errors} parse errors), ${s.sql_statements} SQL statements, ${s.tables} tables, ${s.forms} forms, ${s.uploads} uploads, session keys [${s.session_keys.join(', ')}], outbound hosts [${s.outbound_hosts.join(', ')}], ${s.redirect_risks} redirect risks${hints}`;
  if (s.pages > 0) return line;
  return `${line}\nscan-repo: no pages yet. The generic pack does not read pages from source: run crawl-app on the running app, or set api.openapi in target.yaml, then scan again.`;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, raw: { type: 'string' }, 'fetch-openapi': { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: scan.mjs --target <name> [--root <project>] [--raw <pack-output.json>] [--fetch-openapi]\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
  } catch (err) {
    process.stderr.write(`scan-repo: ${err.message}\n`);
    return 1;
  }
  let raw;
  try {
    if (values['fetch-openapi']) process.stdout.write(`scan-repo: saved the API spec to output/${slash(path.relative(outputDir(target.dir), await fetchOpenapi(target)))}\n`);
    raw = values.raw ? JSON.parse(fs.readFileSync(values.raw, 'utf8')) : runPack(target);
  } catch (err) {
    process.stderr.write(`scan-repo: ${err.message}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${summaryLine(writeInventory(target, raw).summary)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`scan-repo: ${err.message}\n`);
    return err.contract ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
