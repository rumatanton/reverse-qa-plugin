#!/usr/bin/env node
// crawl-app: record what a user can reach in the running app, as every role, by following links in a real browser.
// It runs the framework's "crawl" project (templates/framework/crawl/crawl.spec.ts), which keeps the rules in
// lib/crawl.mjs: GET only, inside the app only, no destructive or session-ending links. Writes
// output/scan/crawl.json and output/scan/observed-matrix.csv; run scan-repo afterwards to merge them.
//   node crawl.mjs --target <name> [--root <project>] [--max-pages <n>] [--summary]
//   exit 0 = recorded, 2 = the crawl failed, 1 = usage or configuration problem
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { appendLedger, outputDir } from '../../lib/ledger.mjs';
import { capabilities } from '../../lib/platform.mjs';
import { crawlEndpoints } from '../../lib/crawl.mjs';

/** What a crawl record holds, in numbers a person can check: pages, per-role outcomes, links left alone. */
export function crawlSummary(crawl) {
  const endpoints = crawlEndpoints(crawl);
  const roles = Object.fromEntries(crawl.roles.map((role) => {
    const got = endpoints.map((e) => e.observed[role]?.outcome).filter(Boolean);
    const counts = Object.fromEntries(['allowed', 'redirect-login', 'redirect', 'error'].map((o) => [o, got.filter((x) => x === o).length]));
    return [role, { ...counts, server_errors: endpoints.filter((e) => e.observed[role]?.server_errors).length }];
  }));
  return { pages: endpoints.length, forms: endpoints.reduce((n, e) => n + e.forms.length, 0), roles, skipped_links: crawl.skipped.length, files: (crawl.files ?? []).length, external_hosts: Object.keys(crawl.external_hosts).sort(), truncated: crawl.truncated };
}

export function summaryLines(s) {
  const lines = [`crawl-app: ${s.pages} page(s), ${s.forms} form(s)${s.truncated ? '; stopped at the page limit (raise crawl.max_pages to see the rest)' : ''}`];
  for (const [role, o] of Object.entries(s.roles)) lines.push(`crawl-app:   ${role}: ${o.allowed} opened, ${o['redirect-login']} sent to log in, ${o.redirect} redirected elsewhere, ${o.error} answered with an error${o.server_errors ? `; on ${o.server_errors} page(s) the server logged an error` : ''}`);
  lines.push(`crawl-app: ${s.skipped_links} link(s) left alone (they look destructive or end the session); ${s.files} link(s) to files, not opened; links to other hosts: [${s.external_hosts.join(', ')}]`);
  return lines;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, 'max-pages': { type: 'string' }, summary: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: crawl.mjs --target <name> [--root <project>] [--max-pages <n>] [--summary]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const caps = capabilities(target.def);
    const file = path.join(outputDir(target.dir), 'scan', 'crawl.json');
    if (!values.summary) {
      const desktop = caps.driver === 'electron'; // its windows are pages: the crawl follows links in them the same way
      if (caps.kind !== 'web' && !desktop) throw new Error(`crawl-app follows links in a browser, so it is for web apps and desktop apps built with Electron; this target is a ${caps.kind} app${caps.kind === 'api' ? ' (its endpoints come from api.openapi)' : ''}`);
      if (!caps.runtime) throw new Error(desktop ? 'target.yaml has no runtime.app.start_page: the crawl needs the page the app opens first' : 'target.yaml has no runtime.base_url: the crawl needs the running app');
      const dir = path.join(target.dir, 'framework');
      if (!fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test'))) throw new Error(`${dir} is not installed: run scaffold-framework first (the crawl uses the framework's browser, logins and outbound guard)`);
      const env = { ...process.env, RQA_REPORT: 'crawl', ...(values['max-pages'] ? { RQA_CRAWL_MAX: values['max-pages'] } : {}) };
      const r = spawnSync('npx playwright test --project=crawl', { cwd: dir, shell: true, stdio: 'inherit', env });
      if (r.status !== 0) {
        process.stderr.write(`crawl-app: the crawl failed (exit ${r.status}); see ${path.join('framework', 'test-results', 'crawl-artifacts')}\n`);
        return 2;
      }
    }
    if (!fs.existsSync(file)) throw new Error('no output/scan/crawl.json yet');
    const summary = crawlSummary(JSON.parse(fs.readFileSync(file, 'utf8')));
    appendLedger(target.dir, 'crawl-app', summary);
    for (const l of summaryLines(summary)) process.stdout.write(`${l}\n`);
    process.stdout.write('crawl-app: next, run scan-repo to merge these pages into the inventory\n');
    return 0;
  } catch (err) {
    process.stderr.write(`crawl-app: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
