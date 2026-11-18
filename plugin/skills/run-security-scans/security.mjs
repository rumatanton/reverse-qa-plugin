#!/usr/bin/env node
// run-security-scans: Semgrep (PHP + secrets rules), Psalm taint analysis and an OWASP ZAP passive baseline, all in
// Docker, all on the local copy. Source files are copied into the scanner containers (never mounted); ZAP joins the
// target's own compose network and scans the app by its service name, so no outside host is ever touched.
// Findings are normalized to one shape and compared with output/security/baseline.json: only NEW findings fail CI.
//   node security.mjs --target <name> [--tools semgrep,psalm,zap] [--update-baseline]
//   exit 0 = no new findings, 2 = new findings, 1 = usage or a scanner could not run
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { runWithFiles, ok } from '../../lib/docker.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { stage, ensureImage } from '../scan-repo/scan.mjs';

export const IMAGES = {
  semgrep: 'semgrep/semgrep:1.183.0@sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0',
  zap: process.env.RQA_ZAP_IMAGE || 'zaproxy/zap-stable@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af', // pulled 2026-11-09
};
const PSALM_XML = `<?xml version="1.0"?>
<psalm errorLevel="8" resolveFromConfigFile="false" findUnusedCode="false" findUnusedBaselineEntry="false">
  <projectFiles><directory name="/src" /></projectFiles>
</psalm>
`;

const rel = (p) => String(p ?? '').replace(/^\/src\//, '');

// ---- normalizers (pure; unit-tested with real scanner output) ----------------------------------------------------

export function normalizeSemgrep(json) {
  const sev = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
  return (json?.results ?? []).map((r) => ({
    tool: 'semgrep',
    rule: r.check_id,
    severity: sev[r.extra?.severity] ?? 'low',
    file: rel(r.path),
    line: r.start?.line ?? null,
    message: (r.extra?.message ?? '').replace(/\s+/g, ' ').trim(),
    cwe: [r.extra?.metadata?.cwe].flat().filter(Boolean).join('; ') || null,
  }));
}

export function normalizePsalm(json) {
  return (Array.isArray(json) ? json : []).map((i) => ({
    tool: 'psalm',
    rule: i.type,
    severity: /^Tainted/.test(i.type) ? 'high' : i.severity === 'error' ? 'medium' : 'low',
    file: rel(i.file_name ?? i.file_path),
    line: i.line_from ?? null,
    message: i.message,
    cwe: null,
  }));
}

export function normalizeZap(json) {
  const risk = { 3: 'high', 2: 'medium', 1: 'low', 0: 'info' };
  return (json?.site ?? []).flatMap((s) =>
    (s.alerts ?? []).map((a) => ({
      tool: 'zap',
      rule: `${a.pluginid}`,
      severity: risk[Number(a.riskcode)] ?? 'info',
      file: null,
      line: null,
      url: [...new Set((a.instances ?? []).map((x) => x.uri.replace(/^https?:\/\/[^/]+/, '')))].sort().slice(0, 20),
      message: a.alert ?? a.name,
      cwe: a.cweid && a.cweid !== '-1' ? `CWE-${a.cweid}` : null,
    })),
  );
}

/**
 * Stable identity of a finding for the baseline. Code findings: tool, rule, file and line (the target is pinned to one
 * commit). URL findings (ZAP): tool and rule only, because ZAP lists a sample of affected URLs that changes from run to
 * run (books.php?id=3 one run, ?id=9 the next), so a new alert means a new kind of problem.
 */
export const fingerprint = (f) => [f.tool, f.rule, f.file ?? '', f.file ? f.line ?? '' : '', ''].join('|');

/** Baselines written before URL findings dropped their URL sample still match. */
const normalizeKnown = (k) => {
  const p = k.split('|');
  return p[2] ? k : [p[0], p[1], '', '', ''].join('|');
};

export function compareBaseline(findings, baseline) {
  const known = new Set((baseline ?? []).map(normalizeKnown));
  return findings.map((f) => ({ ...f, new: !known.has(fingerprint(f)) }));
}

// ---- runners ---------------------------------------------------------------------------------------------------

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runSemgrep(target) {
  const staged = stage(target, 'php');
  const out = tmp('rqa-semgrep-');
  try {
    const r = runWithFiles(IMAGES.semgrep, ['semgrep', 'scan', '--config', 'p/php', '--config', 'p/secrets', '--json', '--metrics', 'off', '--no-git-ignore', '--quiet', '--output', '/out/semgrep.json', '/src'], [{ from: path.join(staged.dir, 'src'), to: '/src' }], {
      createArgs: ['--workdir', '/', '--entrypoint', ''],
      copyOut: [{ from: '/out/semgrep.json', to: path.join(out, 'semgrep.json') }],
    });
    const file = path.join(out, 'semgrep.json');
    if (!fs.existsSync(file)) throw new Error(`semgrep wrote no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-600)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(staged.dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

export function runPsalm(target) {
  const tag = ensureImage('php');
  const staged = stage(target, 'php');
  fs.writeFileSync(path.join(staged.dir, 'rules', 'psalm.xml'), PSALM_XML);
  const out = tmp('rqa-psalm-');
  try {
    const r = runWithFiles(tag, ['sh', '-c', 'mkdir -p /out && cd /src && psalm --config=/rules/psalm.xml --taint-analysis --no-cache --no-progress --threads=4 --report=/out/psalm.json >/dev/null 2>/out/psalm.err; echo "psalm exit $?" >&2; cat /out/psalm.err >&2'], [
      { from: path.join(staged.dir, 'src'), to: '/src' },
      { from: path.join(staged.dir, 'rules'), to: '/rules' },
    ], { createArgs: ['--network', 'none'], copyOut: [{ from: '/out/psalm.json', to: path.join(out, 'psalm.json') }] });
    const file = path.join(out, 'psalm.json');
    if (!fs.existsSync(file)) throw new Error(`psalm wrote no report: ${(r.stderr || r.stdout).slice(-600)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
  } finally {
    fs.rmSync(staged.dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** ZAP passive baseline against the app's compose service, from inside the target's own network. */
export function zapTarget(target) {
  const composeFile = path.join(target.dir, target.def.runtime?.compose_file ?? 'docker-compose.yml');
  const project = YAML.parse(fs.readFileSync(composeFile, 'utf8'))?.name;
  if (!project) throw new Error(`${composeFile} has no top-level "name"; ZAP needs the compose network name`);
  const service = target.def.runtime?.services?.app ?? 'web';
  const basePath = new URL(target.def.runtime.base_url).pathname;
  return { network: `${project}_default`, url: `http://${service}${basePath}` };
}

export function runZap(target) {
  const { network, url } = zapTarget(target);
  const wrk = tmp('rqa-zap-');
  const out = tmp('rqa-zap-out-');
  try {
    const r = runWithFiles(IMAGES.zap, ['zap-baseline.py', '-t', url, '-J', 'zap.json', '-I', '-m', '2'], [{ from: wrk, to: '/zap/wrk' }], {
      createArgs: ['--network', network, '--user', 'root'],
      copyOut: [{ from: '/zap/wrk/zap.json', to: path.join(out, 'zap.json') }],
      timeout: 1_800_000,
    });
    const file = path.join(out, 'zap.json');
    if (!fs.existsSync(file)) throw new Error(`ZAP wrote no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-600)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(wrk, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const RUNNERS = { semgrep: [runSemgrep, normalizeSemgrep], psalm: [runPsalm, normalizePsalm], zap: [runZap, normalizeZap] };

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, tools: { type: 'string' }, 'update-baseline': { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: security.mjs --target <name> [--tools semgrep,psalm,zap] [--update-baseline]\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
  } catch (err) {
    process.stderr.write(`run-security-scans: ${err.message}\n`);
    return 1;
  }
  const tools = (values.tools ?? 'semgrep,psalm,zap').split(',').map((t) => t.trim()).filter(Boolean);
  const baseFile = path.join(outputDir(target.dir), 'security', 'baseline.json');
  const baseline = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : null;
  const all = [];
  const summary = { tools: [] };
  let failedToRun = false;
  for (const tool of tools) {
    const entry = RUNNERS[tool];
    if (!entry) {
      process.stderr.write(`run-security-scans: unknown tool ${tool}\n`);
      return 1;
    }
    const started = Date.now();
    try {
      const raw = entry[0](target);
      writeOutput(target.dir, `security/raw/${tool}.json`, `${JSON.stringify(raw, null, 2)}\n`);
      const findings = compareBaseline(entry[1](raw), baseline);
      writeOutput(target.dir, `security/results/${tool}.json`, `${JSON.stringify(findings, null, 2)}\n`);
      all.push(...findings);
      const row = { tool, ran: true, findings: findings.length, new: baseline ? findings.filter((f) => f.new).length : 'no baseline', by_severity: Object.fromEntries(['high', 'medium', 'low', 'info'].map((s) => [s, findings.filter((f) => f.severity === s).length])), seconds: Math.round((Date.now() - started) / 100) / 10 };
      summary.tools.push(row);
      process.stdout.write(`run-security-scans: ${tool}: ${row.findings} finding(s) (${Object.entries(row.by_severity).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}), new vs baseline: ${row.new}, ${row.seconds} s\n`);
    } catch (err) {
      failedToRun = true;
      summary.tools.push({ tool, ran: false, error: err.message.slice(0, 500) });
      process.stderr.write(`run-security-scans: ${tool} could not run: ${err.message}\n`);
    }
  }
  if (values['update-baseline']) {
    writeOutput(target.dir, 'security/baseline.json', `${JSON.stringify([...new Set(all.map(fingerprint))].sort(), null, 2)}\n`);
    process.stdout.write(`run-security-scans: baseline written with ${all.length} finding(s)\n`);
  }
  writeOutput(target.dir, 'security/summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  appendLedger(target.dir, 'run-security-scans', { tools: summary.tools.map(({ tool, ran, findings, new: n }) => ({ tool, ran, findings, new: n })) });
  if (failedToRun) return 1;
  return baseline && !values['update-baseline'] && all.some((f) => f.new) ? 2 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
