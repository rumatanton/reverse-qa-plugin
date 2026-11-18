// The desktop driver, the parts with no app in them: which driver a target gets, how an Electron app's start page is
// found, the target.yaml written for it, and the crawl and safety rules on an app's own files. The driver itself is
// proven against the running fixture app in tests/e2e/desktop-electron.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN } from '../helpers.mjs';
import { detect, capabilities, driverFor, supportRows, electronStart, KINDS, DRIVERS } from '../../lib/platform.mjs';
import { targetYaml } from '../../skills/init-target/init.mjs';
import { relPath, pageKey, outcomeOf, newCrawl, recordVisit } from '../../lib/crawl.mjs';
import { assertSafeUrls } from '../../lib/runtime.mjs';

const MINI_DESKTOP = path.join(PLUGIN, 'tests', 'fixtures', 'mini-desktop');

test('an Electron project is a desktop app with the electron driver; other desktop apps still wait for Appium', () => {
  const d = detect(MINI_DESKTOP);
  assert.deepEqual([d.stack, d.kind, d.electron], ['electron', 'desktop', { main: 'main.js', start_page: 'renderer/index.html' }]);
  const def = { app: { kind: 'desktop' }, source: { dir_env: 'TARGET_DIR', stack: 'electron' }, runtime: { app: { start_page: 'renderer/index.html' } } };
  const caps = capabilities(def);
  assert.deepEqual([caps.driver, caps.automation, caps.runtime, caps.pack], ['electron', true, 'app', 'generic']);
  assert.equal(driverFor({ app: { kind: 'desktop', driver: 'electron' }, source: { stack: 'unknown' } }).driver, 'electron', 'named in target.yaml');
  const wpf = capabilities({ app: { kind: 'desktop' }, source: { dir_env: 'X', stack: 'dotnet-desktop' } });
  assert.deepEqual([wpf.driver, wpf.automation], ['appium', false]);
  assert.throws(() => driverFor({ app: { kind: 'web', driver: 'electron' } }), /app\.driver "electron" is not a driver for a web app/);
  assert.deepEqual(Object.keys(DRIVERS), ['electron']);
  assert.equal(KINDS.desktop.status, 'planned', 'the default desktop driver is still the planned one');
  // without the start page nothing can be started: the support table says what is missing
  const noStart = capabilities({ ...def, runtime: {} });
  assert.equal(noStart.runtime, null);
  assert.match(supportRows(noStart).find((r) => r.what === 'Automated tests').note, /needs runtime\.app\.start_page/);
});

test('electronStart reads the first page from loadFile, and gives null when the code names none', () => {
  assert.deepEqual(electronStart(MINI_DESKTOP), { main: 'main.js', start_page: 'renderer/index.html' });
  assert.deepEqual(electronStart(path.join(PLUGIN, 'tests', 'fixtures', 'mini-api')), { main: 'index.js', start_page: null });
});

test('init-target writes a target.yaml for an Electron app that names the driver and the start page', () => {
  const d = detect(MINI_DESKTOP);
  const def = YAML.parse(targetYaml({ name: 'mini-desktop', detected: d, kind: d.kind, date: '2026-11-11' }));
  assert.deepEqual([def.app, def.runtime], [{ kind: 'desktop', driver: 'electron' }, { app: { start_page: 'renderer/index.html' } }]);
  assert.equal(capabilities(def).runtime, 'app');
  // start page not found in the code: the line is a TODO comment, and the file still loads
  const unknown = YAML.parse(targetYaml({ name: 'x', detected: { ...d, electron: { main: 'main.js', start_page: null } }, kind: 'desktop', date: '2026-11-11' }));
  assert.equal(unknown.runtime.app, null);
  assert.equal(capabilities(unknown).runtime, null);
});

test("the crawl stays inside a desktop app's own pages", () => {
  const base = 'file:///C:/apps/notes/renderer/';
  assert.equal(relPath('file:///C:/apps/notes/renderer/notes.html', base), 'notes.html');
  assert.equal(relPath('admin/report.html?x=1', base), 'admin/report.html');
  assert.equal(relPath('file:///C:/apps/notes/main.js', base), null, "the app's own file, but outside the pages folder");
  assert.equal(relPath('file:///C:/Windows/win.ini', base), null);
  assert.equal(relPath('https://updates.example.test/latest.json', base), null, 'another host');
  assert.equal(relPath('http://localhost/shop/a.php', 'http://localhost/shop/'), 'a.php', 'a web app is unchanged');
  assert.equal(relPath('file:///C:/x/a.html', 'http://localhost/shop/'), null, 'a web app never follows a link to a file on disk');
  assert.equal(pageKey('file:///C:/apps/notes/renderer/notes.html?tab=2', base), 'notes.html?tab');
  // a guard in the page's own script: the file answers 200 and the window ends on the login screen
  assert.equal(outcomeOf({ requested: `${base}notes.html`, finalUrl: `${base}login.html`, status: 200 }, base, ['login.html']), 'redirect-login');
  const crawl = newCrawl({ baseUrl: base, start: ['index.html'], roles: ['Visitor'] });
  const links = [{ href: `${base}about.html`, label: 'About' }, { href: `${base}clear.html`, label: 'Delete all notes' }, { href: 'https://updates.example.test/x', label: 'Updates' }];
  const next = recordVisit(crawl, 'Visitor', { requested: `${base}index.html`, finalUrl: `${base}index.html`, status: 200, title: 'Home', forms: [], links }, { loginPaths: ['login.html'] });
  assert.deepEqual(next.map((n) => n.key), ['about.html']);
  assert.deepEqual(crawl.skipped.map((s) => s.label), ['Delete all notes']);
  assert.deepEqual(Object.keys(crawl.external_hosts), ['updates.example.test']);
});

test("a desktop app's own files have no host to refuse; every other address is still checked", () => {
  const def = { safety: { allowed_test_hosts: ['localhost'], never_test: ['prod.example.test'] } };
  assert.doesNotThrow(() => assertSafeUrls(def, ['file:///C:/apps/notes/renderer/']));
  assert.throws(() => assertSafeUrls(def, ['https://prod.example.test/']), /never_test/);
  assert.throws(() => assertSafeUrls(def, ['app://notes/']), /not in safety\.allowed_test_hosts/);
});
