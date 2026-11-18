#!/usr/bin/env node
// security-second-opinion: an independent review to corroborate (or contradict) the tech-analyst's security findings.
//   node second.mjs --target <name> --prepare     scratch git copy where the whole app is one pending change
//   node second.mjs --target <name> --review      run Claude Code's built-in /security-review headless in that copy
//                                                  (costs model tokens; writes output/security/second-opinion.md)
//   node second.mjs --target <name> --match       match the review against findings.csv and the scanner results
// The match is deterministic: a finding is corroborated when the review cites the same file within 5 lines.
//   exit 0 = done, 1 = usage or a step could not run
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { parseCsv } from '../../lib/csv.mjs';

const CODE = new Set(['.php', '.inc', '.phtml', '.js', '.html', '.htm', '.sql', '.css', '.json', '.xml', '.ini', '.htaccess']);
export const scratchDir = (target) => path.join(os.tmpdir(), `rqa-second-opinion-${target.name}`);

/** Copy the source's code files (no binaries) into a fresh git repo and stage them all as one pending change. */
export function prepare(target) {
  const dir = scratchDir(target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let files = 0;
  const walk = (relDir) => {
    for (const e of fs.readdirSync(path.join(target.sourceDir, relDir), { withFileTypes: true })) {
      const r = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(r);
      else if (CODE.has(path.extname(e.name).toLowerCase()) || e.name === '.htaccess') {
        fs.mkdirSync(path.join(dir, relDir), { recursive: true });
        fs.copyFileSync(path.join(target.sourceDir, r), path.join(dir, r));
        files++;
      }
    }
  };
  walk('');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q');
  git('-c', 'user.name=reverse-qa', '-c', 'user.email=reverse-qa@localhost', 'commit', '-q', '--allow-empty', '-m', 'empty base for /security-review');
  git('add', '-A');
  return { dir, files };
}

export function review(target) {
  const dir = scratchDir(target);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('run --prepare first');
  const r = spawnSync('claude -p /security-review', { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`headless /security-review did not run (exit ${r.status}). Run it by hand: open Claude Code in ${dir}, type /security-review, and save the answer to ${path.join(outputDir(target.dir), 'security', 'second-opinion.md')}`);
  }
  return writeOutput(target.dir, 'security/second-opinion.md', r.stdout);
}

/** file:line references in free text, e.g. "admin/index.php:8" or "`login.php` line 39". */
export function references(text) {
  const out = [];
  for (const m of text.matchAll(/([\w./-]+\.(?:php|inc|phtml|js|html?))(?::|`?\s+(?:line|lines|L)\s*)(\d+)/gi)) out.push({ file: m[1].replace(/^\.?\//, ''), line: Number(m[2]) });
  const seen = new Set();
  return out.filter((r) => !seen.has(`${r.file}:${r.line}`) && seen.add(`${r.file}:${r.line}`));
}

const near = (a, b, tolerance = 5) => a.file === b.file && Math.abs(a.line - b.line) <= tolerance;

/** Locations a finding rests on: the path:line citations in its root_cause and evidence columns. */
export function findingLocations(f) {
  return references(`${f.root_cause ?? ''} ${f.evidence ?? ''}`);
}

export function matchSecondOpinion(text, findings, scannerFindings = []) {
  const refs = references(text);
  const result = { corroborated: [], single_source: [], second_opinion_only: [] };
  for (const f of findings) {
    const locs = findingLocations(f);
    const hit = refs.find((r) => locs.some((l) => near(r, l)));
    (hit ? result.corroborated : result.single_source).push(hit ? { id: f.id, at: `${hit.file}:${hit.line}` } : { id: f.id });
  }
  for (const r of refs) {
    if (findings.some((f) => findingLocations(f).some((l) => near(r, l)))) continue;
    const scanner = scannerFindings.filter((s) => s.file && near(r, { file: s.file, line: s.line })).map((s) => `${s.tool}:${s.rule.split('.').pop()}`);
    result.second_opinion_only.push({ at: `${r.file}:${r.line}`, also_flagged_by: [...new Set(scanner)] });
  }
  return result;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, prepare: { type: 'boolean' }, review: { type: 'boolean' }, match: { type: 'boolean' } } });
  if (!values.target || !(values.prepare || values.review || values.match)) {
    process.stderr.write('usage: second.mjs --target <name> (--prepare | --review | --match)\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    if (values.prepare) {
      const p = prepare(target);
      process.stdout.write(`security-second-opinion: ${p.files} code files staged as one pending change in ${p.dir}\n`);
    }
    if (values.review) process.stdout.write(`security-second-opinion: review saved to ${review(target)}\n`);
    if (values.match) {
      const out = outputDir(target.dir);
      const mdFile = path.join(out, 'security', 'second-opinion.md');
      if (!fs.existsSync(mdFile)) throw new Error(`${mdFile} not found: run --review (or save a manual /security-review there)`);
      const findings = fs.existsSync(path.join(out, 'findings.csv')) ? parseCsv(fs.readFileSync(path.join(out, 'findings.csv'), 'utf8')) : [];
      const resultsDir = path.join(out, 'security', 'results');
      const scanner = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).flatMap((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'))) : [];
      const m = matchSecondOpinion(fs.readFileSync(mdFile, 'utf8'), findings, scanner);
      writeOutput(target.dir, 'security/second-opinion.json', `${JSON.stringify(m, null, 2)}\n`);
      appendLedger(target.dir, 'security-second-opinion', { corroborated: m.corroborated.length, single_source: m.single_source.length, second_opinion_only: m.second_opinion_only.length });
      process.stdout.write(`security-second-opinion: ${m.corroborated.length} finding(s) corroborated, ${m.single_source.length} single-source, ${m.second_opinion_only.length} location(s) only the review flagged\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`security-second-opinion: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
