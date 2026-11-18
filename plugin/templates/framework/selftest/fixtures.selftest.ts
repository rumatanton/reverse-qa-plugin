// Self-tests: before any suite counts, the framework proves its own fixtures work against the running app. A check
// exists only where it applies: database checks for a target with a database the plugin can reach, the log check
// where a server log is configured, browser checks for a web app, and for a desktop app the checks that it starts,
// that each copy of it is on its own, and that every role gets in through its login screen.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../support/fixtures.ts';
import { target, appService, baseURL, blockedHosts, accounts, loginPaths, storageStateFor, tokenHeaders, usesToken, isWeb, isDesktop, hasDatabase, hasServerLog } from '../support/target.ts';
import { launchApp, closeApp } from '../support/desktop.ts';
import { dbLib, runtimeLib, dockerLib } from '../support/plugin.ts';
import { openStill } from '../pages/base.page.ts';
import { resetToSeed } from '../support/seed.ts';

if (isDesktop) test('the app starts and its first window shows the start page', async ({ rolePage }) => {
  const page = await rolePage('Visitor');
  expect(page.url(), 'target.yaml runtime.app.start_page is the page the app opens first').toBe(new URL(path.basename(target.def.runtime.app.start_page), baseURL).href);
});

// one copy of the app per test is only isolation if each copy keeps its session and its data in a folder of its own
if (isDesktop) test('each copy of the app runs in its own data folder', async () => {
  const copies = [await launchApp(), await launchApp()];
  try {
    const used = await Promise.all(copies.map((c) => c.app.evaluate(({ app }) => app.getPath('userData'))));
    expect(used.map((d) => fs.realpathSync(d))).toEqual(copies.map((c) => fs.realpathSync(c.dataDir)));
    expect(used[0]).not.toBe(used[1]);
  } finally {
    for (const c of copies) await closeApp(c);
  }
});

if (isDesktop) for (const a of accounts()) test(`${a.role} gets in through the app's login screen`, async ({ rolePage }) => {
  const page = await rolePage(a.role); // throws when the login screen does not accept the account
  expect(loginPaths().some((l) => page.url().split(/[?#]/)[0].endsWith(l)), 'the app moved the role off the login screen').toBe(false);
});

if (!isDesktop) test('the app answers at the base URL', async ({ request }) => {
  const res = await request.get(runtimeLib.healthUrl(target.def, baseURL));
  // with a health path it must answer 200; without one, any answer that is not a server error means the app is up
  if (target.def.runtime?.health_path !== undefined) expect(res.status()).toBe(200);
  else expect(res.status(), 'the base URL answers without a server error').toBeLessThan(500);
});

if (hasDatabase) test('db fixture reads exact counts for every table', async ({ db }) => {
  const counts = db.counts();
  expect(Object.keys(counts).length).toBeGreaterThan(0);
  for (const n of Object.values(counts)) expect(Number.isInteger(n) && n >= 0).toBe(true);
});

if (hasDatabase) test('snapshot fixture records exactly one added row', async ({ db, snapshot }) => {
  db.exec('CREATE TABLE IF NOT EXISTS rqa_selftest (id INT PRIMARY KEY, note VARCHAR(40));');
  try {
    snapshot.take('before');
    db.exec("INSERT INTO rqa_selftest VALUES (1, 'selftest');");
    snapshot.take('after');
    const d = snapshot.diff('before', 'after');
    expect(Object.keys(d.tables)).toEqual(['rqa_selftest']);
    expect(d.tables.rqa_selftest.added).toEqual([{ id: 1, note: 'selftest' }]);
  } finally {
    db.exec('DROP TABLE IF EXISTS rqa_selftest;');
  }
});

if (hasServerLog) test('the server log can be read and a new warning is seen', async () => {
  const patterns = runtimeLib.logPatterns(target.def);
  const line = patterns.sample.warning; // a line in this stack's log format that its patterns class as a warning
  const before = runtimeLib.serverLog(target, appService).length;
  dockerLib.compose(target, ['exec', '-T', appService, 'sh', '-c', `echo "${line}" >> ${runtimeLib.serverLogPath(target.def)}`]);
  const added = runtimeLib.serverLog(target, appService).slice(before);
  expect(runtimeLib.classifyServerLog(added, patterns).warning).toEqual([line]);
  runtimeLib.truncateServerLog(target, appService);
});

// only for an app with pages (a web app, or a desktop app's windows) and hosts to block (target.yaml integrations
// with test_policy: stub, or safety.never_test). A desktop app's window is already on its start page.
const hosts = isWeb || isDesktop ? blockedHosts() : [];
if (hosts.length) test('requests to stubbed integrations and never-test hosts are blocked and recorded', async ({ rolePage, gateway }) => {
  const page = await rolePage('Visitor');
  if (!isDesktop) await page.goto(runtimeLib.healthUrl(target.def, baseURL));
  const outcome = await page.evaluate(async (h) => fetch(`https://${h}/rqa-selftest`, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked'), hosts[0]);
  expect(outcome).toBe('blocked');
  expect(gateway.blocked).toEqual([`https://${hosts[0]}/rqa-selftest`]);
});

// a logged-in role page is guarded the same way and hands blocked requests to the test's stub (gateway.handle)
const role = accounts()[0]?.role;
const token = role ? usesToken(role) : false;
if (hosts.length && role && !token) test(`a ${role} page sends blocked requests to the test's gateway stub`, async ({ rolePage, gateway }) => {
  gateway.handle((route) => route.fulfill({ status: 200, body: 'stubbed', headers: { 'access-control-allow-origin': '*' } }));
  const page = await rolePage(role);
  if (!isDesktop) await page.goto(runtimeLib.healthUrl(target.def, baseURL));
  const body = await page.evaluate(async (h) => fetch(`https://${h}/rqa-selftest-role`).then((r) => r.text(), () => 'blocked'), hosts[0]);
  expect(body, 'the stub answered, not the real host and not a blind block').toBe('stubbed');
  expect(gateway.blocked).toEqual([`https://${hosts[0]}/rqa-selftest-role`]);
});

// visual tier: a page opened still has its timers paused and its animated images (an <img>, a CSS background) on frame
// one. a.gif is served as image/jpeg (apps mislabel images; the format is read from the bytes); c.gif stands for an
// image from another site without CORS: shown by the <img>, refused to the page's own fetch, so it is listed as
// unreadable, never swallowed (route.fulfill would add CORS headers itself, so the fetch is aborted instead).
const TWO_FRAME_GIF = Buffer.from('R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABQAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQABQAAACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7', 'base64');
if (isWeb) test('openStill pauses page timers and holds animated images on their first frame', async ({ page }) => {
  await page.route('https://rqa-other.test/**', (route) => route.request().resourceType() === 'fetch' ? route.abort() : route.fulfill({ contentType: 'image/gif', body: TWO_FRAME_GIF }));
  await page.route('**/rqa-still/**', (route) => {
    const file = route.request().url().split('/').pop();
    if (file === 'a.gif') return route.fulfill({ contentType: 'image/jpeg', body: TWO_FRAME_GIF });
    if (file === 'b.gif') return route.fulfill({ contentType: 'image/gif', body: TWO_FRAME_GIF });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><img id="i" src="a.gif"><img src="https://rqa-other.test/c.gif"><div id="b" style="width:8px;height:8px;background-image:url(b.gif)"></div><p id="t">0</p><script>let n = 0; setInterval(() => { document.getElementById("t").textContent = String(++n); }, 100);</script>' });
  });
  const { res, frozen, unreadable } = await openStill(page, 'rqa-still/page.html');
  expect(res?.status()).toBe(200);
  expect(frozen.map((u) => u.split('/').pop()).sort()).toEqual(['a.gif', 'b.gif']);
  expect(unreadable).toEqual(['https://rqa-other.test/c.gif']);
  await expect(page.locator('#i')).toHaveAttribute('src', /^blob:/);
  expect(await page.locator('#b').evaluate((el) => el.style.backgroundImage)).toMatch(/blob:/);
  await expect(page.locator('#t'), 'start-up timers ran for the 2 s the clock was run').toHaveText('20');
  await page.waitForTimeout(500); // real time passes; the page's own timers must not
  await expect(page.locator('#t'), 'no page timer fires after that').toHaveText('20');
});

// each login is its own server session, so a test that opens a logout page cannot log out any other test
if (role && !token && !isDesktop) test(`each ${role} login gets its own server session`, async ({ roleRequest }) => {
  const sessionOf = async () => (await (await roleRequest(role)).storageState()).cookies.map((c) => `${c.name}=${c.value}`).sort().join('; ');
  const first = await sessionOf();
  expect(first, 'the login set a session cookie').not.toBe('');
  expect(await sessionOf(), 'a second login is a different session').not.toBe(first);
});

// a token login: the login answers with a token, and a request that carries it is treated as that role
if (role && token) test(`a ${role} token login gives a token that requests then carry`, async ({ request, roleRequest }) => {
  const headers = await tokenHeaders(request, role);
  expect(Object.values(headers)[0], 'the login answered with a token').toMatch(/\S{8,}/);
  expect(await roleRequest(role), 'a request context for the role is created with the token header').toBeTruthy();
});

// a reset in the middle of a run (the API tier puts the seed back after its POST tests) must not delete the per-run
// accounts: resetToSeed() signs them up again with the same credentials, so later tests can still log in
const signedUp = Object.values<any>(target.def.test_accounts ?? {}).find((a) => a.register && process.env[`RQA_SIGNUP_${a.user_env}`]);
if (signedUp && hasDatabase) test(`a reset in the middle of a run keeps the per-run ${signedUp.role} account`, async ({ roleRequest }) => {
  const user = process.env[signedUp.user_env];
  await resetToSeed();
  expect(process.env[signedUp.user_env], 'the same account, not a new one').toBe(user);
  await roleRequest(signedUp.role); // throws when the login form does not accept the account
});

const formLogins = isDesktop ? [] : accounts().filter((a) => !a.login.json); // a desktop app keeps no login between tests
if (formLogins.length) test('every account with a form login has a logged-in storage state', async () => {
  for (const a of formLogins) expect(storageStateFor(a.role), `${a.role} storage state`).not.toBeNull();
});

if (hasDatabase) test('the database configuration matches target.yaml', async () => {
  expect(dbLib.dbConfig(target).name).toBe(target.def.database?.name);
});
