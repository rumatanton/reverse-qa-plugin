// The test database: back to the seed, personal data masked (target.yaml safety.mask_personal_data), so no test,
// screenshot, video or trace ever shows a real person's data, and the per-run test accounts signed up again, so a
// reset in the middle of a run never leaves later tests without their login. Every reset in the framework goes
// through resetToSeed().
import crypto from 'node:crypto';
import { request } from '@playwright/test';
import { target, baseURL, hasDatabase } from './target.ts';
import { resetLib, dbLib } from './plugin.ts';

export function maskPersonalData() {
  const m = target.def.safety?.mask_personal_data;
  if (!m) return;
  for (const sql of m.sql ?? []) dbLib.execSql(target, sql);
  if (m.check) {
    const left = Number(dbLib.execSql(target, m.check).trim());
    if (left !== 0) throw new Error(`personal data is still in the test database after masking (${left} row(s)): fix safety.mask_personal_data in target.yaml`);
  }
}

/**
 * Sign up each account that has a `register:` block and no credentials in .env. The first call in a run makes new
 * values ({run} = a unique id, {password} = upper, lower, digit and symbol), so no test ever logs in as a real
 * person; they reach the workers through process.env. A later call (after a reset) signs the same account up again
 * with the same values. Global teardown's clean-up deletes the rows.
 */
export async function registerAccounts() {
  for (const a of Object.values<any>(target.def.test_accounts ?? {})) {
    if (!a.register || target.env[a.user_env]) continue; // a standing account from .env is never signed up
    const marker = `RQA_SIGNUP_${a.user_env}`; // set once this run has signed the account up
    if (process.env[a.user_env] && !process.env[marker]) continue; // credentials given from outside the run
    const run = process.env[marker] ?? `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const password = process.env[marker] ? process.env[a.password_env]! : `Rq#${crypto.randomBytes(4).toString('hex')}A7`;
    const fields = Object.fromEntries(Object.entries<string>(a.register.fields).map(([k, v]) => [k, String(v).replaceAll('{run}', run).replaceAll('{password}', password)]));
    const ctx = await request.newContext({ baseURL });
    // register.json: true sends the fields as a JSON body (an API sign-up); otherwise a form, multipart when it has a file field
    const res = await ctx.post(a.register.path, { [a.register.json ? 'data' : a.register.multipart ? 'multipart' : 'form']: fields, maxRedirects: 0 });
    await ctx.dispose();
    if (res.status() >= 400) throw new Error(`sign-up as ${a.role} at ${a.register.path} failed (HTTP ${res.status()})`);
    process.env[marker] = run;
    process.env[a.user_env] = fields[a.register.user_field];
    process.env[a.password_env] = password;
  }
}

export async function resetToSeed() {
  if (!hasDatabase) return null; // no database the plugin can reach: nothing to put back, and the accounts are still there
  const r = resetLib.resetDatabase(target);
  if (r.mismatches.length) throw new Error(`seed row counts differ: ${JSON.stringify(r.mismatches)}`);
  maskPersonalData();
  await registerAccounts();
  return r;
}
