// The desktop driver: the app itself is the browser. Each test starts its own copy of the app with its own data
// folder, so no test sees another's session or data; its windows are Playwright pages, so every helper written for a
// web page works on them; then the app is closed and its data folder removed. Built for apps made with Electron
// (target.yaml app.driver: electron). The contract every driver keeps is in the plugin's templates/DRIVERS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { target, runtime, baseURL, account, blockedHosts } from './target.ts';

export type RunningApp = { app: ElectronApplication; page: Page; dataDir: string; tracing: boolean };

/**
 * The program to start, from target.yaml runtime.app:
 *   start_page  the page the app opens first, relative to the source (required: every screen address is under it)
 *   main        what Electron is given to run, relative to the source (default ".": the folder with package.json)
 *   executable  a packaged app to start instead (a path relative to the source); `main` is then not used
 *   args        extra arguments for the app
 * Blocked hosts (stubbed integrations, safety.never_test) are made unresolvable for the app's windows and for
 * Electron's own network calls in its main process, so not even a request sent while it starts can reach them. Not
 * covered: Node's own networking in the main process (Node's fetch, http), which does not ask Chromium for names.
 */
export function appCommand(dataDir: string): { executablePath: string; args: string[]; cwd: string } {
  const cfg = runtime.app ?? {};
  const cwd = target.sourceDir;
  const blocked = blockedHosts().map((h) => `MAP ${h} ~NOTFOUND`).join(', ');
  const switches = [...(cfg.args ?? []), `--user-data-dir=${dataDir}`, ...(blocked ? [`--host-resolver-rules=${blocked}`] : [])];
  if (cfg.executable) return { executablePath: path.resolve(cwd, cfg.executable), args: switches, cwd };
  let exe: string;
  try {
    exe = createRequire(path.join(cwd, 'package.json'))('electron'); // the Electron the app itself is built with
  } catch {
    throw new Error(`Electron is not installed in ${cwd}: run "npm install" there, or name a packaged app in target.yaml runtime.app.executable`);
  }
  return { executablePath: exe, args: [path.resolve(cwd, cfg.main ?? '.'), ...switches], cwd };
}

/** Before any test: the app can be started (Electron or the packaged app is there) and its start page exists. */
export function assertAppReady() {
  const { executablePath } = appCommand(os.tmpdir());
  if (!fs.existsSync(executablePath)) throw new Error(`the app to start is not at ${executablePath} (target.yaml runtime.app)`);
  const start = new URL(path.basename(runtime.app.start_page), baseURL);
  if (start.protocol === 'file:' && !fs.existsSync(fileURLToPath(start))) throw new Error(`target.yaml runtime.app.start_page: no file at ${fileURLToPath(start)}`);
}

/**
 * Start the app and return its first window. A browser context resolves a relative address against its base URL; an
 * app window has none, so the window's goto does the same against the app's base.
 */
export async function launchApp(): Promise<RunningApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-app-'));
  const app = await electron.launch({ ...appCommand(dataDir), timeout: 90_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(new URL(url, baseURL).href, options);
  // the steps of a failed test: Playwright records a trace for a browser it starts itself, not for an app
  const tracing = await app.context().tracing.start({ screenshots: true, snapshots: true }).then(() => true, () => false);
  return { app, page, dataDir, tracing };
}

/** Close the app and remove its data folder. On a failed test, first keep what was on screen and the steps. */
export async function closeApp(running: RunningApp, testInfo?: TestInfo, n = 0) {
  const failed = testInfo ? testInfo.status !== testInfo.expectedStatus : false;
  if (failed && testInfo) {
    for (const [i, win] of running.app.windows().entries()) {
      const file = testInfo.outputPath(`app-${n}-window-${i}.png`);
      if (await win.screenshot({ path: file }).then(() => true, () => false)) await testInfo.attach(`screenshot (app ${n}, window ${i})`, { path: file, contentType: 'image/png' });
    }
  }
  if (running.tracing) {
    const file = failed && testInfo ? testInfo.outputPath(`app-${n}-trace.zip`) : undefined;
    await running.app.context().tracing.stop(file ? { path: file } : {}).catch(() => {});
    if (file && fs.existsSync(file)) await testInfo!.attach(`trace (app ${n})`, { path: file, contentType: 'application/zip' });
  }
  await running.app.close().catch(() => {});
  fs.rmSync(running.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Log in through the app's own login screen (target.yaml test_accounts.<name>.login: `path` is the login screen,
 * `user_field` and `password_field` are the names of its inputs). Returns the address the app moves the role to,
 * which is where that role's own menu is.
 */
export async function uiLogIn(page: Page, role: string): Promise<string> {
  const a = account(role);
  const login = new URL(a.login.path, baseURL).href;
  await page.goto(login);
  await page.locator(`[name="${a.login.user_field}"]`).fill(a.user);
  await page.locator(`[name="${a.login.password_field}"]`).fill(a.password);
  await page.locator(`[name="${a.login.password_field}"]`).press('Enter');
  await page.waitForURL((u) => u.href !== login, { timeout: 15_000 }).catch(() => {
    throw new Error(`login as ${role} on ${a.login.path} did not leave the login screen (wrong credentials, or the form is not submitted with Enter)`);
  });
  await page.waitForLoadState('load');
  return page.url();
}
