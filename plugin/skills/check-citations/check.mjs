#!/usr/bin/env node
// check-citations: every citation in recon docs and requirements must resolve in the target source.
//   node check.mjs --target <name> [--root <project>] [--file <doc>]...   exit 0 = all resolve, 2 = failures, 1 = usage
//   node check.mjs --hook   (PostToolUse) reads the hook JSON on stdin and checks only the file just written
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, listTargets, loadTarget, isInside, readStdin } from '../../lib/target.mjs';
import { extractFromFile, verify, formatIssue } from '../../lib/citations.mjs';
import { secretValues } from '../../lib/bugs.mjs';
import { capabilities } from '../../lib/platform.mjs';
import { TEST_TYPES_DOC, loadCatalogue, checkTestTypesDoc } from '../../lib/testtypes.mjs';

/** Recon documents a target currently has: output/docs/*.md and output/requirements.yaml. */
export function defaultDocs(targetDirPath) {
  const out = path.join(targetDirPath, 'output');
  const docs = [];
  const docsDir = path.join(out, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir).sort()) if (f.endsWith('.md')) docs.push(path.join(docsDir, f));
  }
  for (const f of ['requirements.yaml', 'findings.csv']) if (fs.existsSync(path.join(out, f))) docs.push(path.join(out, f));
  const bugsDir = path.join(out, 'bugs');
  if (fs.existsSync(bugsDir)) for (const f of fs.readdirSync(bugsDir).sort()) if (/^BUG-.*\.md$/.test(f)) docs.push(path.join(bugsDir, f));
  return docs;
}

/**
 * True for files the rule covers: output/docs/*.md and output/requirements.yaml (citations and private values),
 * output/findings.csv and output/bugs/BUG-*.md (private values; their citations are checked by their own skills).
 */
export function isCheckedDoc(file, targetDirPath) {
  const out = path.join(targetDirPath, 'output');
  if (!isInside(file, out)) return false;
  const rel = path.relative(out, file).split(path.sep).join('/');
  return /^docs\/[^/]+\.md$/i.test(rel) || /^requirements\.ya?ml$/i.test(rel) || rel === 'findings.csv' || /^bugs\/BUG-[^/]+\.md$/.test(rel);
}

/**
 * Values no document may contain: email addresses in the seed dump (real people's contact data in many legacy dumps)
 * and the target's secrets from .env (passwords, keys, tokens). A citation quotes the code line, never a data row.
 */
export function privateValues(target) {
  // secretValues leaves out a "secret" that is also a plain setting (a demo password equal to its user name)
  const values = new Set(secretValues({ ...target.env }));
  const dump = target.def.source?.seed_dump && path.resolve(target.sourceDir, target.def.source.seed_dump);
  if (dump && fs.existsSync(dump)) for (const m of fs.readFileSync(dump, 'utf8').matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) values.add(m[0].toLowerCase());
  return [...values];
}

/** Lines of a document that contain a private value. The value itself is never printed. */
export function findLeaks(text, doc, values) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    const hits = values.filter((v) => low.includes(v.toLowerCase()));
    if (hits.length) issues.push({ doc, docLine: i + 1, reason: `contains ${hits.length} private value(s) from the seed data or .env: quote the code, never a data row or a secret` });
  });
  return issues;
}

/** Check documents for one target. Returns { checked, files, issues }. */
export function checkDocs(target, docs) {
  let checked = 0;
  const issues = [];
  const values = privateValues(target);
  for (const doc of docs) {
    if (!/\.csv$/i.test(doc)) {
      const { citations, problems } = extractFromFile(doc);
      checked += citations.length;
      issues.push(...problems, ...verify(citations, target.sourceDir));
    }
    const text = fs.readFileSync(doc, 'utf8');
    issues.push(...findLeaks(text, doc, values));
    // the analyst's list of test types must agree with what the tool really runs (skills/recon/test-types.yaml)
    if (path.basename(doc) === TEST_TYPES_DOC) issues.push(...checkTestTypesDoc(text, doc, loadCatalogue(), capabilities(target.def).driver));
  }
  return { checked, files: docs.length, issues };
}

function report(result, stream) {
  for (const issue of result.issues) stream.write(`${formatIssue(issue)}\n`);
  stream.write(`check-citations: ${result.checked} citation(s) in ${result.files} file(s), ${result.issues.length} problem(s)\n`);
}

async function hookMode() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return 0; // not our input; never block on a parse problem
  }
  const file = input?.tool_input?.file_path;
  if (!file) return 0;
  const root = projectRoot(input.cwd && !process.env.CLAUDE_PROJECT_DIR ? input.cwd : undefined);
  const abs = path.resolve(root, file);
  for (const name of listTargets(root)) {
    let target;
    try {
      target = loadTarget(root, name);
    } catch {
      continue;
    }
    if (!isCheckedDoc(abs, target.dir)) continue;
    const result = checkDocs(target, [abs]);
    if (result.issues.length === 0) return 0;
    process.stderr.write('Citations that do not resolve. Fix each citation or remove the claim (do not change the checker):\n');
    report(result, process.stderr);
    return 2;
  }
  return 0;
}

async function cliMode(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { target: { type: 'string' }, root: { type: 'string' }, file: { type: 'string', multiple: true } },
  });
  if (!values.target) {
    process.stderr.write('usage: check.mjs --target <name> [--root <project>] [--file <doc>]...\n');
    return 1;
  }
  const root = projectRoot(values.root);
  let target;
  try {
    target = loadTarget(root, values.target);
  } catch (err) {
    process.stderr.write(`check-citations: ${err.message}\n`);
    return 1;
  }
  const docs = values.file?.length ? values.file.map((f) => path.resolve(root, f)) : defaultDocs(target.dir);
  if (docs.length === 0) {
    process.stdout.write('check-citations: no recon documents yet, nothing to check\n');
    return 0;
  }
  const missing = docs.filter((d) => !fs.existsSync(d));
  if (missing.length) {
    process.stderr.write(`check-citations: not found: ${missing.join(', ')}\n`);
    return 1;
  }
  const result = checkDocs(target, docs);
  report(result, result.issues.length ? process.stderr : process.stdout);
  return result.issues.length ? 2 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const code = argv.includes('--hook') ? await hookMode() : await cliMode(argv);
  process.exitCode = code;
}
