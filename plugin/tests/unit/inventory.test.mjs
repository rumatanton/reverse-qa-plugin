// The normalizer, on the recorded mini-shop pack output: every planted fact in EXPECTED.md must come out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifySql, resolveInclude, resolveTarget, validateRaw, normalize, crudCsv, erMermaid } from '../../lib/inventory.mjs';
import { parseDump } from '../../lib/sqldump.mjs';
import { parseCsv } from '../../lib/csv.mjs';
import { PLUGIN, FIXTURE_SRC } from '../helpers.mjs';

const RAW = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'tests', 'fixtures', 'scan', 'mini-shop.raw.json'), 'utf8'));
const DUMP = parseDump(fs.readFileSync(path.join(FIXTURE_SRC, 'seed.sql'), 'utf8'));

test('classifySql: verbs, written and read tables, joins, aliases, comma joins and subqueries', () => {
  assert.deepEqual(classifySql('SELECT * FROM `book` b JOIN category c ON c.cat_id = b.cat_id WHERE 1'), { verb: 'SELECT', writes: [], reads: ['book', 'category'] });
  assert.deepEqual(classifySql('select a.x from cart a, book b where a.bid=b.bid'), { verb: 'SELECT', writes: [], reads: ['cart', 'book'] });
  assert.deepEqual(classifySql("INSERT INTO payments (a) SELECT a FROM temp_payments WHERE id='?'"), { verb: 'INSERT', writes: ['payments'], reads: ['temp_payments'] });
  assert.deepEqual(classifySql('UPDATE customer SET name=? WHERE id IN (SELECT cus_id FROM cart)'), { verb: 'UPDATE', writes: ['customer'], reads: ['cart'] });
  assert.deepEqual(classifySql('DELETE FROM cart WHERE cus_id = ?'), { verb: 'DELETE', writes: ['cart'], reads: [] });
  assert.deepEqual(classifySql('REPLACE INTO db.stats VALUES (1)'), { verb: 'REPLACE', writes: ['stats'], reads: [] });
  assert.equal(classifySql('SHOW TABLES').verb, 'OTHER');
});

test('resolveInclude follows PHP relative lookup: the including folder first, then the root', () => {
  const known = new Set(['db.php', 'admin/header.php', 'includes/header.php']);
  assert.equal(resolveInclude('admin/index.php', 'header.php', known), 'admin/header.php');
  assert.equal(resolveInclude('admin/index.php', '../db.php', known), 'db.php');
  assert.equal(resolveInclude('index.php', 'includes/header.php', known), 'includes/header.php');
  assert.equal(resolveInclude('a.php', '?', known), null, 'dynamic include stays unresolved');
  assert.equal(resolveInclude('a.php', 'missing.php', known), null);
});

test('resolveTarget resolves form actions and redirects against their file', () => {
  assert.equal(resolveTarget('admin/x.php', '../login.php?err=1'), 'login.php');
  assert.equal(resolveTarget('admin/x.php', ''), 'admin/x.php');
  assert.equal(resolveTarget('admin/x.php', null), 'admin/x.php');
  assert.equal(resolveTarget('a.php', 'https://pay.example.test/p'), 'https://pay.example.test/p');
  assert.equal(resolveTarget('a/b.php', '/c.php'), 'c.php');
});

test('validateRaw accepts the recorded output and names each contract break', () => {
  assert.deepEqual(validateRaw(RAW), []);
  const broken = structuredClone(RAW);
  broken.files[0].sql = 'nope';
  broken.files[1].session.push({ key: 'X', op: 'read' });
  delete broken.pack;
  const problems = validateRaw(broken);
  assert.ok(problems.some((p) => p.includes('pack')));
  assert.ok(problems.some((p) => p.endsWith('sql is not an array')));
  assert.ok(problems.some((p) => p.includes('session item without a line')));
  assert.deepEqual(validateRaw(null), ['output is not a JSON object']);
});

test('normalize: pages, includes, guards and session keys match EXPECTED.md', () => {
  const { inventory: inv } = normalize(RAW, DUMP, { target: 'mini-shop' });
  assert.deepEqual(inv.pages.map((p) => p.path), ['admin/products.php', 'admin/report.php', 'cart.php', 'checkout.php', 'index.php', 'login.php']);
  assert.deepEqual(inv.includes.map((i) => [i.path, i.outputs_html]), [['admin/header.php', true], ['db.php', false]]);
  assert.deepEqual(inv.session_keys.UID, { check: ['cart.php:3', 'checkout.php:3'], write: ['login.php:9'], read: ['cart.php:9', 'checkout.php:8'], unset: [] });
  assert.deepEqual(inv.session_keys.ADMIN.check, ['admin/products.php:3', 'admin/report.php:4']);
  const page = (p) => inv.pages.find((x) => x.path === p);
  assert.deepEqual(page('index.php').guards, []);
  assert.deepEqual(page('admin/products.php').methods, ['GET', 'POST']);
  assert.deepEqual(page('login.php').forms_targeting, [{ file: 'login.php', line: 16, method: 'POST' }]);
  assert.deepEqual(page('checkout.php').writes, ['cart', 'orders']);
  assert.deepEqual(page('checkout.php').reads, ['cart', 'products']);
  assert.deepEqual(page('admin/report.php').includes, ['admin/header.php', 'db.php']);
});

test('normalize: SQL, CRUD, upload, hosts, forms and the one redirect risk match EXPECTED.md', () => {
  const { inventory: inv, crudRows } = normalize(RAW, DUMP, { target: 'mini-shop' });
  const sql = (file, line) => inv.sql.find((s) => s.file === file && s.line === line);
  assert.deepEqual([sql('cart.php', 9).verb, sql('cart.php', 9).writes], ['INSERT', ['cart']]);
  assert.deepEqual([sql('checkout.php', 9).writes, sql('checkout.php', 9).reads], [['orders'], ['cart', 'products']]);
  assert.equal(sql('checkout.php', 10).verb, 'DELETE');
  assert.equal(sql('admin/products.php', 14).verb, 'UPDATE');
  assert.equal(inv.summary.uploads, 1);
  assert.deepEqual(Object.keys(inv.outbound_hosts), ['pay.example.test']);
  assert.deepEqual(inv.outbound_hosts['pay.example.test'], ['checkout.php:12']);
  assert.deepEqual(Object.keys(inv.asset_hosts), ['cdn.example.test']);
  const login = inv.forms.find((f) => f.file === 'login.php');
  assert.deepEqual([login.line, login.method, login.target, login.fields.map((f) => f.name).filter(Boolean)], [16, 'POST', 'login.php', ['email', 'password']]);
  assert.deepEqual(inv.forms.find((f) => f.file === 'checkout.php').fields.map((f) => f.name).filter(Boolean), ['order']);
  assert.deepEqual(inv.redirect_risks.map((r) => [r.file, r.line, r.exits, r.code_follows, r.after_output]), [['admin/report.php', 5, false, true, true]]);
  assert.ok(inv.redirect_risks[0].output_sources[0].startsWith('admin/header.php'));
  assert.deepEqual(inv.redirect_risks[0].kinds, ['execution-after-redirect', 'output-before-redirect'], 'buffer size unknown');
  assert.equal(inv.redirect_risks[0].headers_already_sent, null);
  assert.deepEqual(inv.tables.cart.used_by, { C: ['cart.php'], R: ['checkout.php'], U: [], D: ['checkout.php'] });
  assert.deepEqual(inv.undeclared_tables, []);
  const csv = parseCsv(crudCsv(crudRows));
  assert.deepEqual(csv.find((r) => r.file === 'checkout.php' && r.table === 'cart'), { file: 'checkout.php', table: 'cart', C: '', R: 'R', U: '', D: 'D', lines: '9 10' });
});

test('output_buffering decides between execution-after-redirect and headers-already-sent', () => {
  const buffered = normalize(RAW, DUMP, { outputBuffering: 4096 }).inventory.redirect_risks[0];
  assert.deepEqual([buffered.kinds, buffered.headers_already_sent, buffered.output_bytes], [['execution-after-redirect'], false, 225]);
  const unbuffered = normalize(RAW, DUMP, { outputBuffering: 0 }).inventory.redirect_risks[0];
  assert.deepEqual([unbuffered.kinds, unbuffered.headers_already_sent], [['execution-after-redirect', 'headers-already-sent'], true]);
});

test('normalize without a dump still classifies SQL and lists the tables as undeclared', () => {
  const { inventory } = normalize(RAW, null);
  assert.deepEqual(inventory.undeclared_tables, ['cart', 'orders', 'products', 'users']);
  assert.equal(inventory.summary.tables, 0);
});

test('normalize prefixes page URLs with the app base path', () => {
  const { inventory } = normalize(RAW, DUMP, { basePath: 'shop/' });
  assert.equal(inventory.pages.find((p) => p.path === 'cart.php').url, 'shop/cart.php');
});

test('erMermaid draws every table with PK/FK markers and one edge per foreign key', () => {
  const er = erMermaid(normalize(RAW, DUMP).inventory.tables);
  assert.ok(er.startsWith('erDiagram\n'));
  assert.match(er, /int\(11\) user_id FK/);
  assert.match(er, /users \|\|--o\{ cart : "user_id"/);
  assert.equal((er.match(/\|\|--o\{/g) ?? []).length, 3);
});
