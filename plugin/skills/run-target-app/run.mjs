#!/usr/bin/env node
// run-target-app: build and start a target's app and database from its compose file, seed the database, wait until
// the app answers, and start the PHP error log clean. Refuses any URL outside safety.allowed_test_hosts.
//   node run.mjs --target <name> [--upgrade] [--no-build] [--no-reset] [--timeout <ms>]
//   node run.mjs --target <name> --down
//   exit 0 = running (or stopped), 1 = refused or failed, 2 = up but the seed row counts differ
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { compose, ok } from '../../lib/docker.mjs';
import { assertSafeUrls, appVariant, healthUrl, waitForHttp, truncatePhpLog } from '../../lib/runtime.mjs';
import { appendLedger } from '../../lib/ledger.mjs';
import { resetDatabase, summaryLine as resetLine } from '../db-reset/reset.mjs';

export async function start(target, { upgrade = false, build = true, reset = true, timeoutMs = 300_000 } = {}) {
  const variant = appVariant(target.def, { upgrade });
  assertSafeUrls(target.def, [variant.baseUrl]);
  const db = target.def.runtime?.services?.db ?? 'db';
  ok(compose(target, ['up', '-d', ...(build ? ['--build'] : []), '--wait', db, variant.service], { profiles: variant.profiles, timeout: 3_600_000 }), 'docker compose up');
  const resetResult = reset ? resetDatabase(target) : null;
  const health = await waitForHttp(healthUrl(target.def, variant.baseUrl), { timeoutMs });
  truncatePhpLog(target, variant.service);
  const result = { service: variant.service, baseUrl: variant.baseUrl, health, reset: resetResult };
  appendLedger(target.dir, 'run-target-app', { service: variant.service, baseUrl: variant.baseUrl, healthMs: health.ms, reset: resetResult && { tables: resetResult.tables, rows: resetResult.rows, mismatches: resetResult.mismatches } });
  return result;
}

export function stop(target) {
  const profiles = target.def.runtime?.services?.app_upgrade ? appVariant(target.def, { upgrade: true }).profiles : [];
  ok(compose(target, ['down', '--remove-orphans'], { profiles, timeout: 600_000 }), 'docker compose down');
  appendLedger(target.dir, 'run-target-app', { down: true });
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      root: { type: 'string' },
      upgrade: { type: 'boolean' },
      'no-build': { type: 'boolean' },
      'no-reset': { type: 'boolean' },
      down: { type: 'boolean' },
      timeout: { type: 'string' },
    },
  });
  if (!values.target) {
    process.stderr.write('usage: run.mjs --target <name> [--upgrade] [--no-build] [--no-reset] [--timeout ms] | --down\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
    if (values.down) {
      stop(target);
      process.stdout.write(`run-target-app: ${target.name} stopped\n`);
      return 0;
    }
    const r = await start(target, { upgrade: values.upgrade, build: !values['no-build'], reset: !values['no-reset'], timeoutMs: Number(values.timeout ?? 300_000) });
    process.stdout.write(`run-target-app: ${r.service} up at ${r.baseUrl} (HTTP ${r.health.status} after ${(r.health.ms / 1000).toFixed(1)} s)\n`);
    if (r.reset) process.stdout.write(`${resetLine(r.reset)}\n`);
    return r.reset?.mismatches.length ? 2 : 0;
  } catch (err) {
    process.stderr.write(`run-target-app: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
