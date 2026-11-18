// The technology-neutral path: app detection, the generic rule pack, the OpenAPI import, the crawl rules, and how
// their endpoints merge into one inventory. Fixture: tests/fixtures/mini-api (EXPECTED.md is the answer key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN } from '../helpers.mjs';
import { detect, capabilities, supportRows, packFor, KINDS } from '../../lib/platform.mjs';
import { extract, routeHints, sqlStatements, looksLikeSql, urlFacts, ROUTE_PATTERNS } from '../../rules/generic/extract.mjs';
import { endpointsFromSpec, specBasePath } from '../../lib/openapi.mjs';
import { relPath, pageKey, skipReason, scriptTargets, newCrawl, recordVisit, outcomeOf, crawlEndpoints, observedMatrix } from '../../lib/crawl.mjs';
import { validateRaw, normalize, pathShape, mergeEndpoints } from '../../lib/inventory.mjs';

const MINI_API = path.join(PLUGIN, 'tests', 'fixtures', 'mini-api');
const tree = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-detect-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};

test('detect: names the stack and the kind of app from project files, with the evidence', () => {
  const cases = [
    [{ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>', 'src/main/resources/templates/home.html': '<html>' }, 'java-spring', 'web'],
    [{ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>', 'src/main/resources/openapi.yaml': 'openapi: 3.0.0\n' }, 'java-spring', 'api'],
    [{ 'app/src/main/AndroidManifest.xml': '<manifest/>', 'app/build.gradle': 'android {}' }, 'android', 'mobile'],
    [{ 'pubspec.yaml': 'name: x\nflutter:\n  uses-material-design: true\n' }, 'flutter', 'mobile'],
    [{ 'package.json': '{"dependencies":{"react-native":"0.76.0"}}' }, 'react-native', 'mobile'],
    [{ 'App.xcodeproj/project.pbxproj': '' }, 'ios', 'mobile'],
    [{ 'package.json': '{"devDependencies":{"electron":"33.0.0"}}', 'index.html': '<html>' }, 'electron', 'desktop'],
    [{ 'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>' }, 'dotnet-desktop', 'desktop'],
    [{ 'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'Views/Home/Index.cshtml': '<h1>' }, 'dotnet', 'web'],
    [{ 'a.php': '<?php', 'b.php': '<?php', 'c.php': '<?php' }, 'php', 'web'],
    [{ 'requirements.txt': 'fastapi==0.115\n', 'openapi.json': '{"openapi":"3.1.0"}' }, 'python', 'api'],
    [{ 'main.c': 'int main(){}' }, 'unknown', 'web'],
  ];
  for (const [files, stack, kind] of cases) {
    const d = detect(tree(files));
    assert.deepEqual([d.stack, d.kind], [stack, kind], `${Object.keys(files).join(', ')}: ${d.reasons.join('; ')}`);
    assert.ok(d.reasons.length > 0, 'the reason is stated');
  }
  const api = detect(MINI_API);
  assert.deepEqual([api.stack, api.kind, api.openapi], ['unknown', 'api', 'openapi.yaml']);
  assert.equal(detect(tree({ 'docker-compose.yml': 'services: {}', 'index.html': '' })).compose, 'docker-compose.yml');
});

test('capabilities: what applies to a target, and the reason when something does not', () => {
  assert.equal(packFor('php'), 'php');
  assert.equal(packFor('java-spring'), 'generic', 'a stack with no dedicated pack is read by the generic one');
  const php = capabilities({ source: { dir_env: 'X', stack: 'php' }, runtime: { compose_file: 'c.yml', base_url: 'http://localhost/', php_error_log: '/l' }, database: { name: 'd' } });
  assert.deepEqual([php.kind, php.driver, php.automation, php.pack, php.runtime, php.database, php.server_log], ['web', 'web', true, 'php', 'compose', true, true]);
  const remote = capabilities({ app: { kind: 'api' }, source: { dir_env: 'X', stack: 'java-spring' }, runtime: { base_url: 'https://test.example.test/' }, api: { openapi: 'spec.yaml' } });
  assert.deepEqual([remote.driver, remote.automation, remote.pack, remote.runtime, remote.database, remote.openapi], ['api', true, 'generic', 'url', false, true]);
  const mobile = capabilities({ app: { kind: 'mobile' }, source: { dir_env: 'X', stack: 'android' } });
  assert.deepEqual([mobile.driver, mobile.automation], ['appium', false]);
  const rows = Object.fromEntries(supportRows(mobile).map((r) => [r.what, r]));
  assert.equal(rows['Requirements, user stories, risk register, test cases, bug reports'].ok, true, 'analysis works for every kind of app');
  assert.equal(rows['Automated tests'].ok, false);
  assert.match(rows['Automated tests'].note, /Appium driver/);
  assert.equal(supportRows(remote).find((r) => r.what.startsWith('Database')).note, 'no database configured (optional)');
  assert.throws(() => capabilities({ app: { kind: 'console' } }), /app.kind "console" is not one of web, api, mobile, desktop/);
  assert.deepEqual(Object.entries(KINDS).filter(([, k]) => k.status === 'built').map(([n]) => n), ['web', 'api']);
});

test('route hints: one example per framework syntax, with class-level prefixes', () => {
  const spring = ['package shop;', '@RestController', '@RequestMapping("/api/orders")', 'public class OrderController {', '  @GetMapping', '  public List<Order> all() {}', '  @GetMapping("/{id}")', '  public Order one() {}', '  @PostMapping(value = "/", consumes = "application/json")', '  public Order add() {}', '  @RequestMapping(path = "/export", method = RequestMethod.GET)', '  public void export() {}', '}'].join('\n');
  assert.deepEqual(routeHints(spring, '.java').map((r) => [r.method, r.path, r.line]), [['GET', '/api/orders', 5], ['GET', '/api/orders/{id}', 7], ['POST', '/api/orders', 9], ['GET', '/api/orders/export', 11]]);
  const aspnet = ['[ApiController]', '[Route("api/[controller]")]', 'public class OrdersController : ControllerBase {', '  [HttpGet("{id}")]', '  public IActionResult One(int id) {}', '  [HttpDelete]', '  public IActionResult All() {}', '}'].join('\n');
  assert.deepEqual(routeHints(aspnet, '.cs').map((r) => [r.method, r.path]), [['GET', '/api/orders/{id}'], ['DELETE', '/api/orders']]);
  const one = (line, ext) => routeHints(line, ext).map((r) => [r.framework, r.method, r.path]);
  assert.deepEqual(one('app.MapPost("/orders", (Order o) => o);', '.cs'), [['aspnet-minimal', 'POST', '/orders']]);
  assert.deepEqual(one("router.delete('/orders/:id', auth, handler)", '.js'), [['express', 'DELETE', '/orders/:id']]);
  assert.deepEqual(one("@app.route('/orders/<int:id>', methods=['POST'])", '.py'), [['flask-fastapi', 'POST', '/orders/<int:id>']]);
  assert.deepEqual(one('@router.get("/items/{item_id}")', '.py'), [['flask-fastapi', 'GET', '/items/{item_id}']]);
  assert.deepEqual(one("Route::post('/checkout', [CheckoutController::class, 'pay']);", '.php'), [['laravel', 'POST', '/checkout']]);
  assert.deepEqual(one('r.GET("/orders/:id", getOrder)', '.go'), [['go-http', 'GET', '/orders/:id']]);
  assert.deepEqual(one("@Controller('cats')\nexport class C {\n  @Get(':id')\n  one() {}\n}", '.ts'), [['nestjs', 'GET', '/cats/:id']]);
  assert.deepEqual(one('@Path("/orders")\npublic class R {\n  @Path("/{id}")\n  public O one() {}\n}', '.java').map((r) => r[2]), ['/orders/{id}']);
  assert.deepEqual(one("// app.get('/old', handler)", '.js'), [], 'a commented-out route is not a route');
  assert.deepEqual(one("app.get('/x', h)", '.py'), [], 'a pattern only runs on its own languages');
  assert.ok(ROUTE_PATTERNS.every((p) => p.framework && p.ext.length && p.re instanceof RegExp), 'the table is data: framework, extensions, pattern');
});

test('SQL in string literals: found in any language, prose is not', () => {
  const yes = ['SELECT * FROM book', 'SELECT id, name FROM users WHERE id = ?', 'select count(*) from orders where user_id = :id', 'INSERT INTO cart (user_id) VALUES (?)', 'UPDATE products SET price = ? WHERE id = ?', 'DELETE FROM cart WHERE user_id = ?', 'delete from cart where id = ?', 'SELECT name FROM products'];
  const no = ['Select a file from the list', 'Delete from cart', 'select a file from the list', 'Update your profile settings', 'UPDATE available', 'Insert into the slot', 'SELECT', 'delete from cart'];
  for (const s of yes) assert.equal(looksLikeSql(s), true, s);
  for (const s of no) assert.equal(looksLikeSql(s), false, s);
  const java = ['class Repo {', '  String Q = "SELECT id, name FROM users WHERE email = ?";', '  void x() { jdbc.update("DELETE FROM cart WHERE user_id = ?", id); }', '  String label = "Delete from cart";', '  String block = """', '      SELECT o.id, o.qty', '      FROM orders o JOIN products p ON p.id = o.product_id', '      """;', '}'].join('\n');
  assert.deepEqual(sqlStatements(java, '.java'), [
    { text: 'SELECT id, name FROM users WHERE email = ?', line: 2 },
    { text: 'DELETE FROM cart WHERE user_id = ?', line: 3 },
    { text: 'SELECT o.id, o.qty FROM orders o JOIN products p ON p.id = o.product_id', line: 6 },
  ]);
  const py = "cur.execute('INSERT INTO orders (user_id, qty) VALUES (%s, %s)', (u, q))\nname = 'it\\'s'\n";
  assert.deepEqual(sqlStatements(py, '.py'), [{ text: 'INSERT INTO orders (user_id, qty) VALUES (%s, %s)', line: 1 }]);
  const mapper = '<mapper>\n  <select id="byId" resultType="Order">\n    SELECT * FROM orders WHERE id = #{id}\n  </select>\n</mapper>';
  assert.deepEqual(sqlStatements(mapper, '.xml'), [{ text: 'SELECT * FROM orders WHERE id = #{id}', line: 3 }]);
});

test('URLs: code and asset references are told apart; namespaces, licences and comments are not outbound calls', () => {
  const text = ['const PAY = "https://pay.example.test/charge";', '<script src="https://cdn.example.test/app.js"></script>', '<beans xmlns="http://www.springframework.org/schema/beans">', '// see https://docs.example.test/guide', 'fetch("http://" + host + "/x")', ' * Licensed under http://www.apache.org/licenses/LICENSE-2.0'].join('\n');
  assert.deepEqual(urlFacts(text), [{ url: 'https://pay.example.test/charge', line: 1, context: 'code' }, { url: 'https://cdn.example.test/app.js', line: 2, context: 'asset' }]);
});

test('the generic pack on mini-api: passes the contract, is deterministic, finds every planted route and the outbound host', () => {
  const raw = extract(MINI_API);
  assert.deepEqual(validateRaw(raw), []);
  assert.deepEqual(raw, extract(MINI_API), 'the same source gives the same output');
  assert.deepEqual([raw.pack, raw.pages], ['generic', 'none']);
  assert.deepEqual(raw.files.map((f) => f.path), ['openapi.yaml', 'router.mjs', 'server.mjs']);
  const server = raw.files.find((f) => f.path === 'server.mjs');
  assert.deepEqual(server.routes.map((r) => `${r.method} ${r.path}`), ['GET /health', 'POST /login', 'GET /products', 'GET /products/:id', 'GET /orders', 'POST /orders', 'GET /orders/:id', 'GET /admin/report', 'GET /debug/config', 'POST /test/reset']);
  assert.ok(server.routes.every((r) => r.framework === 'express' && Number.isInteger(r.line)));
  const { inventory } = normalize(raw, null, {});
  assert.deepEqual(Object.keys(inventory.outbound_hosts), ['pay.example.test']);
  assert.equal(inventory.pages.length, 0, 'a source file is not a page for the generic pack');
  assert.equal(inventory.summary.includes, 0);
  const excluded = extract(MINI_API, { exclude: ['router.mjs'] });
  assert.deepEqual(excluded.files.map((f) => f.path), ['openapi.yaml', 'server.mjs']);
});

test('OpenAPI import on mini-api: endpoints, parameters, security and the spec line of each', () => {
  const text = fs.readFileSync(path.join(MINI_API, 'openapi.yaml'), 'utf8');
  const r = endpointsFromSpec(text, { file: 'openapi.yaml', baseUrl: 'http://127.0.0.1:8095/' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.endpoints.map((e) => `${e.methods.join('+')} ${e.path}`), ['GET admin/report', 'GET health', 'POST login', 'GET+POST orders', 'GET orders/{id}', 'GET products', 'GET products/{id}']);
  const by = Object.fromEntries(r.endpoints.map((e) => [e.path, e]));
  assert.deepEqual(by.orders.params, { BODY: ['product_id', 'qty'] }, 'body fields are read through the $ref');
  assert.deepEqual(by['orders/{id}'].params, { PATH: ['id'] });
  assert.equal(by['orders/{id}'].example_path, 'orders/1');
  assert.deepEqual(r.endpoints.filter((e) => e.guards.length).map((e) => e.path), ['admin/report', 'orders', 'orders/{id}']);
  const lines = text.split('\n');
  assert.equal(lines[Number(by.orders.evidence.split(':')[1]) - 1].trim(), '/orders:', 'the evidence line is the path in the spec');
  assert.equal(lines[by.orders.operations.find((o) => o.method === 'POST').line - 1].trim(), 'post:');
  assert.deepEqual(by['admin/report'].operations[0].responses, ['200', '401', '403']);
});

test('OpenAPI import: Swagger 2, a server prefix, JSON input and a document that is not a spec', () => {
  const swagger = JSON.stringify({ swagger: '2.0', basePath: '/api/v1', paths: { '/pets/{petId}': { get: { parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer', 'x-example': 7 }, { name: 'verbose', in: 'query', type: 'boolean' }], responses: { 200: {} } }, post: { parameters: [{ in: 'body', name: 'b', schema: { $ref: '#/definitions/Pet' } }], security: [{ key: [] }], responses: { 201: {} } } } }, definitions: { Pet: { properties: { name: {}, tag: {} } } } });
  const r = endpointsFromSpec(swagger, { file: 'swagger.json', baseUrl: 'http://localhost:8080/' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual([r.endpoints[0].path, r.endpoints[0].methods, r.endpoints[0].params, r.endpoints[0].example_path], ['api/v1/pets/{petId}', ['GET', 'POST'], { PATH: ['petId'], QUERY: ['verbose'], BODY: ['name', 'tag'] }, 'api/v1/pets/7']);
  assert.equal(endpointsFromSpec(swagger, { baseUrl: 'http://localhost:8080/api/v1/' }).endpoints[0].path, 'pets/{petId}', 'a prefix already in the base URL is not added twice');
  assert.equal(specBasePath({ servers: [{ url: 'https://x.example.test/shop/api' }] }), 'shop/api');
  assert.match(endpointsFromSpec('name: not-a-spec\n').problems.join(' '), /not an OpenAPI or Swagger document/);
});

test('crawl rules: stays in the app, one page per path and parameter set, skips destructive and session-ending links', () => {
  const base = 'http://localhost/shop/';
  assert.equal(relPath('http://localhost/shop/admin/a.php?x=1', base), 'admin/a.php');
  assert.equal(relPath('http://localhost/shop', base), '');
  assert.equal(relPath('http://localhost/other/a.php', base), null, 'same host, outside the app');
  assert.equal(relPath('https://pay.example.test/x', base), null);
  assert.equal(pageKey('book.php?id=2&cat=1', base), 'book.php?cat&id');
  assert.equal(pageKey('http://localhost/shop/book.php?id=9&cat=3', base), 'book.php?cat&id', 'other values, the same page');
  const why = (href, label) => skipReason({ href, label }, { baseUrl: base, skip: ['archive'] });
  assert.equal(why('books.php', 'Books'), null);
  assert.match(why('logout.php', 'Bye'), /ends the session \("logout"\)/);
  assert.match(why('comment.php?id=5', 'Delete'), /"delete"/, 'the label counts: a harmless-looking address can still delete');
  assert.match(why('order.php?action=remove_item&id=1', 'x'), /"remove"/);
  assert.match(why('report.php?archive=1', 'x'), /"archive"/, 'target.yaml crawl.skip adds words');
  assert.equal(why('reset-password.php', 'Forgot?') !== null, true);
  assert.equal(why('https://pay.example.test/x', 'Pay'), 'outside the app');
  assert.equal(why('javascript:void(0)', 'x'), 'not a page link');
  assert.equal(why('presets.php', 'Presets'), 'looks destructive or ends the session ("reset")', 'an address match is by substring: a false skip is safer than a followed delete');
});

test('crawl: navigation written as a click handler is read from its code, never run', () => {
  assert.deepEqual(scriptTargets("location.replace('search_items.php')"), ['search_items.php']);
  assert.deepEqual(scriptTargets('window.location.href = "admin/index.php?tab=1"'), ['admin/index.php?tab=1']);
  assert.deepEqual(scriptTargets("location='cart.php'; return false;"), ['cart.php']);
  assert.deepEqual(scriptTargets("if (ok) { document.location.assign('a.php') } else { window.open('b.php', '_blank') }"), ['a.php', 'b.php']);
  assert.deepEqual(scriptTargets('location.href = base + "/x.php"'), [], 'an address built from variables is not a literal: not guessed');
  assert.deepEqual(scriptTargets("toggleMenu(); this.classList.add('open')"), []);
  assert.deepEqual(scriptTargets(null), []);
  // a destructive handler is still skipped by its label or address
  assert.match(skipReason({ href: scriptTargets("location.replace('logout.php')")[0], label: 'Bye' }, { baseUrl: 'http://localhost/shop/' }), /logout/);
});

test('crawl record: per-role outcomes, forms, links to follow, and the endpoints and observed matrix it gives', () => {
  const base = 'http://localhost/shop/';
  const login = ['login.php'];
  assert.equal(outcomeOf({ requested: 'cart.php', finalUrl: `${base}login.php`, status: 200 }, base, login), 'redirect-login');
  assert.equal(outcomeOf({ requested: 'old.php', finalUrl: `${base}index.php`, status: 200 }, base, login), 'redirect');
  assert.equal(outcomeOf({ requested: 'x.php', finalUrl: `${base}x.php`, status: 500 }, base, login), 'error');
  const crawl = newCrawl({ baseUrl: base, start: ['index.php'], roles: ['Visitor', 'Customer'] });
  const found = recordVisit(crawl, 'Visitor', { requested: `${base}index.php`, finalUrl: `${base}index.php`, status: 200, title: 'Shop', links: [{ href: 'book.php?id=1', label: 'Notebook' }, { href: 'book.php?id=2', label: 'Pen' }, { href: 'cart.php', label: 'Cart' }, { href: 'logout.php', label: 'Log out' }, { href: 'https://cdn.example.test/x', label: 'CDN' }], forms: [{ action: 'login.php', method: 'post', fields: [{ name: 'email', type: 'email', required: true }, { name: 'password', type: 'password' }, { type: 'submit' }] }] }, { loginPaths: login });
  assert.deepEqual(found.map((f) => f.key), ['book.php?id', 'cart.php'], 'two values of one parameter are one page to visit');
  assert.deepEqual(crawl.skipped.map((s) => [s.href, s.reason]), [['logout.php', 'looks destructive or ends the session ("logout")']]);
  assert.deepEqual(Object.keys(crawl.external_hosts), ['cdn.example.test']);
  recordVisit(crawl, 'Visitor', { requested: `${base}book.php?id=1`, finalUrl: `${base}book.php?id=1`, status: 200, title: 'Notebook', links: [], forms: [] }, { loginPaths: login });
  const none = recordVisit(crawl, 'Visitor', { requested: `${base}cart.php`, finalUrl: `${base}login.php`, status: 200, title: 'Log in', links: [{ href: 'register.php', label: 'Sign up' }], forms: [] }, { loginPaths: login });
  assert.deepEqual(none, [{ key: 'login.php', url: `${base}login.php` }], 'the links of the login page are not taken as the cart page\'s; the page the role was sent to is returned as one to visit');
  assert.deepEqual(crawl.pages['cart.php'].links_to, [], 'nothing the login page shows is recorded on the cart page');
  // add to cart: the page does its work and moves the customer on to checkout. Not a login redirect: the customer may use it.
  const moved = recordVisit(crawl, 'Customer', { requested: `${base}add.php?item=1`, finalUrl: `${base}checkout.php`, status: 200, title: 'Checkout', links: [], forms: [] }, { loginPaths: login });
  assert.deepEqual(moved.map((f) => f.key), ['checkout.php']);
  assert.deepEqual(recordVisit(crawl, 'Visitor', { requested: `${base}down.php`, finalUrl: `${base}down.php`, status: 500, title: '', links: [], forms: [] }, { loginPaths: login }), [], 'an error page leads nowhere');
  const again = recordVisit(crawl, 'Customer', { requested: `${base}cart.php`, finalUrl: `${base}cart.php`, status: 200, title: 'Cart', links: [{ href: 'index.php', label: 'Home' }, { href: 'book.php?id=1', label: 'Notebook' }], forms: [] }, { loginPaths: login });
  assert.deepEqual(again.map((f) => f.key), ['index.php', 'book.php?id'], 'links to pages another role already found are still returned: each role keeps its own visited list');
  const e = Object.fromEntries(crawlEndpoints(crawl).map((x) => [x.path, x]));
  assert.deepEqual(Object.keys(e), ['add.php', 'book.php', 'cart.php', 'down.php', 'index.php']);
  assert.deepEqual([e['add.php'].reachable_by, e['add.php'].observed.Customer.landed_on], [['Customer'], 'checkout.php'], 'moved on to another page that is not the login: the role may use it');
  assert.deepEqual(e['down.php'].reachable_by, []);
  assert.deepEqual([e['book.php'].params, e['book.php'].seen_query, e['book.php'].example_query], [{ GET: ['id'] }, 'id=1', undefined], 'a query the crawl saw is information, never an example a test would use');
  assert.deepEqual([e['cart.php'].reachable_by, e['cart.php'].observed.Visitor], [['Customer'], { outcome: 'redirect-login', status: 200, landed_on: 'login.php' }]);
  assert.deepEqual(e['index.php'].forms[0].fields.map((f) => f.name), ['email', 'password']);
  assert.deepEqual(observedMatrix(crawl).filter((r) => r.page === 'cart.php').map((r) => [r.role, r.observed]), [['Visitor', 'redirect-login'], ['Customer', 'allowed']]);
});

test('a crawl merged into a parsed inventory: a folder address is its index page, and errors survive several query shapes', () => {
  const page = (path) => ({ path, url: path, includes: [], methods: ['GET'], params: {}, guards: [], session_writes: [], session_unsets: [], reads: [], writes: [], uploads: [], forms_targeting: [], redirects: [], js_redirects: [], redirect_risks: [], sources: ['pack'] });
  const pages = [page('admin/index.php'), page('index.php'), page('cart.php')];
  mergeEndpoints(pages, [
    { path: 'admin/', methods: ['GET'], params: {}, source: 'crawl', evidence: 'crawl-app', observed: { Admin: { outcome: 'allowed', status: 200 } }, reachable_by: ['Admin'], forms: [] },
    { path: '', methods: ['GET'], params: {}, source: 'crawl', evidence: 'crawl-app', observed: {}, reachable_by: [], forms: [] },
    { path: 'reports/', methods: ['GET'], params: {}, source: 'crawl', evidence: 'crawl-app', observed: {}, reachable_by: [], forms: [] },
  ]);
  assert.deepEqual(pages.map((p) => p.path), ['admin/index.php', 'cart.php', 'index.php', 'reports/'], 'no second page for a folder that has one index file');
  assert.deepEqual([pages[0].aliases, pages[0].sources, pages[0].reachable_by], [['admin/'], ['pack', 'crawl'], ['Admin']]);
  assert.deepEqual(pages[2].aliases, [''], 'the base URL is the root index page');
  assert.deepEqual(pages[3].sources, ['crawl'], 'a folder with no index file in the source stays its own page');

  const base = 'http://localhost/shop/';
  const crawl = newCrawl({ baseUrl: base, roles: ['Customer'] });
  const visit = (q, extra) => recordVisit(crawl, 'Customer', { requested: `${base}book.php?${q}`, finalUrl: `${base}book.php?${q}`, status: 200, title: 'Book', links: [], forms: [], ...extra }, {});
  visit('id=1');
  visit('bid=2', { serverErrors: ['Fatal: cart query failed'] });
  const book = crawlEndpoints(crawl).find((e) => e.path === 'book.php');
  assert.deepEqual(book.observed.Customer, { outcome: 'allowed', status: 200, server_errors: 1, server_error: 'Fatal: cart query failed' }, 'an error on one query shape is not lost when the page also opened cleanly with another');
  assert.deepEqual(book.params, { GET: ['bid', 'id'] });
});

test('one inventory from three sources: spec endpoints become pages, the crawl adds to them, undocumented routes show', () => {
  const raw = extract(MINI_API);
  const spec = endpointsFromSpec(fs.readFileSync(path.join(MINI_API, 'openapi.yaml'), 'utf8'), { file: 'openapi.yaml', baseUrl: 'http://127.0.0.1:8095/' }).endpoints;
  const crawled = [{ path: 'products', methods: ['GET'], params: { GET: ['sort'] }, source: 'crawl', evidence: 'crawl-app (2026-11-10)', seen_query: 'sort=name', observed: { Visitor: { outcome: 'allowed', status: 200 } }, reachable_by: ['Visitor'], forms: [] }];
  const { inventory } = normalize(raw, null, { endpoints: [...spec, ...crawled] });
  assert.deepEqual(inventory.pages.map((p) => p.path), ['admin/report', 'health', 'login', 'orders', 'orders/{id}', 'products', 'products/{id}']);
  assert.deepEqual(inventory.summary.pages_from, { pack: 0, openapi: 7, crawl: 1 });
  const products = inventory.pages.find((p) => p.path === 'products');
  assert.deepEqual([products.sources, products.params, products.seen_query, products.example_query, products.reachable_by], [['openapi', 'crawl'], { GET: ['sort'] }, 'sort=name', undefined, ['Visitor']]);
  const orders = inventory.pages.find((p) => p.path === 'orders');
  assert.deepEqual([orders.methods, orders.guards.map((g) => g.key), orders.redirects, orders.reads], [['GET', 'POST'], ['bearerAuth'], [], []], 'a page from a spec has every key a parsed page has');
  assert.deepEqual(inventory.route_hints.filter((r) => !r.matched).map((r) => r.path), ['/debug/config', '/test/reset'], 'routes in the code that the spec does not document');
  assert.equal(inventory.summary.route_hints_unmatched, 2);
  assert.equal(pathShape('/orders/:id'), pathShape('orders/{id}'));
  assert.equal(pathShape('/orders/<int:id>'), 'orders/{}');
  assert.notEqual(pathShape('orders/1'), pathShape('orders/{id}'), 'a literal segment is not a parameter');
});
