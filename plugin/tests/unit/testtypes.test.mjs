import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, CHECK, tempProject, runNode } from '../helpers.mjs';
import { loadCatalogue, checkTestTypesDoc, tableRows, TEST_TYPES_DOC } from '../../lib/testtypes.mjs';

const catalogue = loadCatalogue();
const HEAD = '| type | status | why | evidence | tool |\n|---|---|---|---|---|\n';
const row = (type, status, why = 'checked', evidence = '-', tool = '-') => `| ${type} | ${status} | ${why} | ${evidence} | ${tool} |\n`;
/** A document that agrees with the catalogue for one driver; `change` may replace or drop a row by its type id. */
function doc(driver, change = {}) {
  let text = `# Test types\n\n${HEAD}`;
  for (const t of catalogue) {
    if (t.id in change) { text += change[t.id] ?? ''; continue; }
    const runsHere = t.status === 'built' && (!t.drivers || t.drivers.includes(driver));
    text += row(t.id, t.status === 'not-built' ? 'not built' : runsHere ? 'have' : 'not applicable', runsHere ? 'runs today' : 'does not apply to this driver');
  }
  return text + (change.extra ?? '');
}
const reasons = (text, driver = 'web') => checkTestTypesDoc(text, 'd.md', catalogue, driver).map((i) => i.reason);

test('the test-type catalogue is true to the repo: built types name a skill and a template that exist, and no tier or run skill is left out', () => {
  const ids = catalogue.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const t of catalogue) {
    assert.match(t.id, /^[a-z][a-z0-9-]+$/, `${t.id}: a lower-case id`);
    assert.ok(t.area && t.name, `${t.id}: area and name`);
    assert.ok(['built', 'not-built'].includes(t.status), `${t.id}: status is built or not-built`);
    for (const d of t.drivers ?? []) assert.ok(['web', 'api', 'electron'].includes(d), `${t.id}: driver ${d} is one that is built`);
    if (t.status === 'built') {
      assert.ok(fs.existsSync(path.join(PLUGIN, 'skills', t.by, 'SKILL.md')), `${t.id}: "by" names a skill that exists (${t.by})`);
      if (t.template) assert.ok(fs.existsSync(path.join(PLUGIN, 'templates', t.template)), `${t.id}: templates/${t.template} exists`);
      assert.equal(t.gap, undefined, `${t.id}: a built type has no gap line`);
    } else {
      assert.ok(t.gap && t.gap.length > 10, `${t.id}: a type that is not built says what is missing`);
      assert.equal(t.by, undefined, `${t.id}: a type that is not built is run by nothing`);
    }
  }
  // nothing the tool runs is missing from the list: every tier in the framework template, every run-* skill
  const templates = new Set(catalogue.map((t) => t.template));
  for (const tier of fs.readdirSync(path.join(PLUGIN, 'templates', 'framework', 'tests'))) assert.ok(templates.has(`framework/tests/${tier}`), `the template tier tests/${tier} is in the catalogue`);
  const by = new Set(catalogue.map((t) => t.by));
  for (const s of fs.readdirSync(path.join(PLUGIN, 'skills'))) if (/^run-/.test(s) && s !== 'run-target-app') assert.ok(by.has(s), `skill ${s} runs a test type and is in the catalogue`);
});

test('08-test-types.md must agree with the catalogue: no "have" the tool cannot run, no proposal without evidence, no type left out', () => {
  assert.deepEqual(reasons(doc('web')), [], 'a document that agrees passes');
  assert.deepEqual(reasons(doc('electron'), 'electron'), [], 'the same for a desktop app');
  // a proposed type the catalogue lacks is welcome, with the code that creates the need and a tool
  const proposed = row('websocket', 'proposed', 'the app pushes prices over a socket', '[cite: ws.js:3 "new WebSocket(url || fallback)"]', 'Playwright page.on("websocket")');
  assert.deepEqual(reasons(doc('web', { extra: proposed })), []);
  assert.equal(tableRows(proposed)[0].evidence, '[cite: ws.js:3 "new WebSocket(url || fallback)"]', 'a "|" inside a quoted line does not split the cell');

  assert.match(reasons(doc('web', { smoke: null })).join('\n'), /"smoke" from the catalogue has no row/);
  assert.match(reasons(doc('web', { smoke: row('smoke', 'not built') })).join('\n'), /"smoke" is built \(run by run-suites\)/);
  assert.match(reasons(doc('web', { 'perf-stress': row('perf-stress', 'have') })).join('\n'), /"perf-stress" is not built/);
  assert.match(reasons(doc('electron', { visual: row('visual', 'have') }), 'electron').join('\n'), /"visual" does not run on the electron driver/);
  assert.match(reasons(doc('web', { smoke: row('smoke', 'proposed') })).join('\n'), /already in the catalogue/);
  assert.match(reasons(doc('web', { extra: row('websocket', 'have') })).join('\n'), /not in the catalogue.*"proposed"/);
  assert.match(reasons(doc('web', { extra: row('websocket', 'proposed', 'sockets', '-', 'Playwright') })).join('\n'), /has no citation/);
  assert.match(reasons(doc('web', { extra: row('websocket', 'proposed', 'sockets', '[cite: ws.js:3 "new WebSocket"]', '-') })).join('\n'), /names no tool/);
  assert.match(reasons(doc('web', { extra: row('smoke', 'have') })).join('\n'), /listed twice/);
  assert.match(reasons(doc('web', { smoke: row('smoke', 'done') })).join('\n'), /status "done" is not one of/);
  assert.match(reasons(doc('web', { database: row('database', 'not applicable', '-') })).join('\n'), /say why/);
});

test('check-citations refuses an 08-test-types.md that disagrees with the catalogue, and still resolves its citations', () => {
  const { root, docs } = tempProject();
  const file = path.join(docs, TEST_TYPES_DOC);
  const run = () => runNode(CHECK, ['--target', 'mini-shop', '--root', root]);

  fs.writeFileSync(file, doc('web', { extra: row('order-email', 'proposed', 'checkout writes an order nobody is told about', '[cite: checkout.php:9 "INSERT INTO orders"]', 'a mail catcher') }));
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /1 citation\(s\) in 1 file\(s\), 0 problem\(s\)/);

  fs.writeFileSync(file, doc('web', { 'perf-stress': row('perf-stress', 'have'), extra: row('order-email', 'proposed', 'no code names it', '[cite: checkout.php:9 "this line is not there"]', 'a mail catcher') }));
  const bad = run();
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /"perf-stress" is not built/);
  assert.match(bad.stderr, /checkout\.php:9/, 'the proposal\'s citation is checked like any other');
  fs.rmSync(root, { recursive: true, force: true });
});
