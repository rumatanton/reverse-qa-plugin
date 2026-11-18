// Before any test: the app answers; where the target has a database the plugin can reach, it is back at the seed
// (counts proven, personal data masked); the server log starts empty where one is configured; the accounts marked
// `register:` in target.yaml are signed up with fresh data; and every role with credentials logs in once to prove
// its credentials work (form logins leave their storage state in .auth/<Role>.json, for UI mode and codegen). Tests
// do not reuse that session: each logs in on its own (support/target.ts).
import fs from 'node:fs';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import { target, baseURL, appService, accounts, logIn, tokenHeaders, AUTH_DIR, isDesktop, hasContainers, hasDatabase, hasServerLog } from './target.ts';
import { runtimeLib, cleanupLib } from './plugin.ts';
import { assertAppReady } from './desktop.ts';
import { MANIFEST } from './global-teardown.ts';
import { resetToSeed, maskPersonalData, registerAccounts } from './seed.ts';

// With a health path the app must answer 200 there. Without one, any answer that is not a server error means it is up
// (an API often has nothing at its root).
const UP = target.def.runtime?.health_path === undefined ? Array.from({ length: 300 }, (_, i) => 200 + i) : [200];

export default async function globalSetup(_config: FullConfig) {
  if (process.env.RQA_SKIP_SETUP === '1') return; // the unit project needs no app
  if (isDesktop) {
    // a desktop app is started by each test, with a data folder of its own: there is no server to wait for, no shared
    // state to reset and no session to keep. Each role's login is proven by the self-tests, through the login screen.
    assertAppReady();
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, '[]');
    return;
  }
  await runtimeLib.waitForHttp(runtimeLib.healthUrl(target.def, baseURL), { timeoutMs: 120_000, expect: UP });
  // The files already in the app's writable folders, listed before anything is signed up: global teardown deletes
  // only what the run adds (a sign-up may store a file too).
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(hasContainers ? cleanupLib.listWritableFiles(target, appService) : []));
  if (hasDatabase && process.env.RQA_NO_RESET !== '1') await resetToSeed(); // counts proven, personal data masked, accounts signed up
  else {
    if (hasDatabase) maskPersonalData();
    await registerAccounts();
  }
  if (hasServerLog) runtimeLib.truncateServerLog(target, appService);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const f of fs.readdirSync(AUTH_DIR)) fs.rmSync(path.join(AUTH_DIR, f)); // no session left over from an earlier run
  for (const a of accounts()) {
    const ctx = await request.newContext({ baseURL });
    if (a.login.json) await tokenHeaders(ctx, a.role); // a token login: proving it works is enough, there is no state to keep
    else {
      await logIn(ctx, a.role);
      await ctx.storageState({ path: path.join(AUTH_DIR, `${a.role}.json`) });
    }
    await ctx.dispose();
  }
}
