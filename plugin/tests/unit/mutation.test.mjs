import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { flipGuard, noOpWhere, buildMutants, applyMutant, grepFor, judge, score, mutationMarkdown, pagesFor, relatedFindings } from '../../lib/mutation.mjs';

const MUTATE = path.join(PLUGIN, 'skills', 'run-mutation', 'mutate.mjs');

const FILES = {
  'admin/list.php': ['<?php', 'session_start();', 'if(!isset($_SESSION["AID"])){', '  header("Location: ../login.php");', '}', '$sql="DELETE FROM item where id={$_GET[\'id\']};";'].join('\n'),
  'login.php': ['<?php', 'if (isset($_SESSION["UID"]))', '  header("Location: index.php");'].join('\n'),
  'edit.php': ['<?php', 'include "header.php";', 'if(isset($_POST["update"]))', '{', '  $sql = "UPDATE item', '          SET name = \'{$_POST["name"]}\'', '          WHERE item.id = {$_GET[\'id\']}";', '}'].join('\n'),
  'purge.php': ['<?php', '$sql = "DELETE FROM log";', '$sql2 = "SELECT * FROM log where id = 1";'].join('\n'),
  'header.php': '<?php // menu',
};
const inventory = {
  pages: [
    { path: 'admin/list.php', includes: ['header.php'], guards: [{ key: 'AID', file: 'admin/list.php', line: 3 }] },
    { path: 'login.php', includes: [], guards: [{ key: 'UID', file: 'login.php', line: 2 }] },
    { path: 'edit.php', includes: ['header.php'], guards: [{ key: 'UID', file: 'edit.php', line: 2 }] }, // line 2 is no session check
    { path: 'purge.php', includes: [], guards: [] },
  ],
  sql: [
    { file: 'admin/list.php', line: 6, verb: 'DELETE' },
    { file: 'edit.php', line: 3, verb: 'UPDATE' }, // cited a line above the statement, on a form field named "update"
    { file: 'edit.php', line: 5, verb: 'UPDATE' }, // the same statement again
    { file: 'purge.php', line: 2, verb: 'DELETE' }, // no WHERE at all
    { file: 'admin/list.php', line: 6, verb: 'SELECT' },
  ],
};

test('mutants come from the inventory: a session check is turned around, a write is made to change nothing, and a line no pattern fits is said so', () => {
  assert.equal(flipGuard('if(!isset($_SESSION["AID"])){'), 'if(isset($_SESSION["AID"])){');
  assert.equal(flipGuard('if (isset($_SESSION[\'CUS_ID\']))'), 'if (!isset($_SESSION[\'CUS_ID\']))');
  assert.equal(flipGuard('include "header.php";'), null);
  const lines = FILES['edit.php'].split('\n');
  assert.deepEqual(noOpWhere(lines, 2, 'UPDATE'), { index: 6, text: '          WHERE 1=0 and item.id = {$_GET[\'id\']}";' }, 'the form field named "update" is not taken for the statement');
  assert.equal(noOpWhere(FILES['purge.php'].split('\n'), 1, 'DELETE'), null, 'the SELECT on the next line is not this statement');

  const mutants = buildMutants(inventory, (f) => FILES[f]);
  assert.deepEqual(mutants.map((m) => [m.id, m.operator, `${m.file}:${m.line}`, m.na ? 'n/a' : m.after]), [
    ['M-001', 'guard-flip', 'admin/list.php:3', 'if(isset($_SESSION["AID"])){'],
    ['M-002', 'guard-flip', 'edit.php:2', 'n/a'],
    ['M-003', 'guard-flip', 'login.php:2', 'if (!isset($_SESSION["UID"]))'],
    ['M-004', 'write-no-op', 'admin/list.php:6', '$sql="DELETE FROM item where 1=0 and id={$_GET[\'id\']};";'],
    ['M-005', 'write-no-op', 'edit.php:7', 'WHERE 1=0 and item.id = {$_GET[\'id\']}";'],
    ['M-006', 'write-no-op', 'purge.php:2', 'n/a'],
  ], 'two facts on one statement make one mutant; a SELECT is never mutated');
  assert.deepEqual(pagesFor(inventory, 'header.php'), ['admin/list.php', 'edit.php'], 'a shared file belongs to every page that includes it');

  // only the one line changes, and a file that moved on since is refused
  const mutated = applyMutant(FILES['admin/list.php'], mutants[0]);
  assert.deepEqual(mutated.split('\n').filter((l, i) => l !== FILES['admin/list.php'].split('\n')[i]), ['if(isset($_SESSION["AID"])){']);
  assert.throws(() => applyMutant(FILES['login.php'], mutants[0]), /not the line this mutant was built from/);
  assert.ok(new RegExp(grepFor(['index.php', 'admin/list.php'])).test('opens @page:admin/list.php @role:Admin'));
  assert.ok(!new RegExp(grepFor(['index.php'])).test('opens @page:admin/index.php'), 'a page name is not matched inside a longer one');
  assert.ok(!new RegExp(grepFor(['list.php'])).test('opens @page:list.phpx'));
});

test('a mutant is killed only by a test whose result changed; a test that already failed without it proves nothing', () => {
  const row = (title, outcome, project = 'chromium') => ({ file: 'a.spec.ts', title, project, outcome });
  const baseline = [row('page as Visitor → redirect @authz', 'passed'), row('known hole F-009 @security', 'known-defect'), row('flaky journey @e2e', 'failed'), row('loads @smoke', 'passed')];
  const j = (after, opts) => judge(baseline, after, opts);

  assert.deepEqual(j([row('page as Visitor → redirect @authz', 'failed'), row('loads @smoke', 'passed')]), { state: 'killed', killed_by: ['page as Visitor → redirect (passed → failed)'], ran: 2 });
  assert.equal(j([row('known hole F-009 @security', 'fixed-defect')]).state, 'killed', 'a known defect that stops failing is a changed result too');
  assert.deepEqual(j([row('loads @smoke', 'passed'), row('known hole F-009 @security', 'known-defect')]), { state: 'survived', killed_by: [], ran: 2 });
  assert.equal(j([row('flaky journey @e2e', 'failed')]).state, 'no-tests', 'it failed without the mutant as well');
  assert.equal(j([row('loads @smoke', 'skipped')]).state, 'no-tests', 'a test that did not run saw nothing');
  assert.equal(j([row('a test the baseline never ran @smoke', 'failed')]).state, 'no-tests');
  assert.deepEqual(j([], { setupFailed: 'Error: login failed' }), { state: 'killed', killed_by: ['the suite could not start: Error: login failed'], ran: 0 });

  const results = [{ state: 'killed' }, { state: 'killed' }, { state: 'survived' }, { state: 'no-tests' }, { state: 'not-applicable' }];
  assert.deepEqual(score(results), { total: 5, killed: 2, survived: 1, no_tests: 1, not_applicable: 1, score_pct: 50 }, 'not applicable is outside the score; no test counts against it');
  const md = mutationMarkdown({ summary: score(results), mutants: [{ id: 'M-001', state: 'survived', file: 'cart.php', line: 12, operator: 'write-no-op', after: 'DELETE from cart where 1=0 and bid=1', ran: 4, pages: ['cart.php'], killed_by: [] }] });
  assert.match(md, /## Survived: a defect no test noticed/);
  // a survivor in a file a known finding names may be code that already does nothing: the finding is listed beside it
  const findings = [
    { id: 'F-008', status: 'confirmed', root_cause: 'admin/index.php:8 header() after output, no exit', evidence: 'admin/transaction.php:6; admin/header.php:3' },
    { id: 'F-030', status: 'rejected', root_cause: 'admin/index.php:9 not a defect', evidence: '' },
    { id: 'F-002', status: 'new', root_cause: 'index.php:40 unescaped output', evidence: '' },
  ];
  assert.deepEqual(relatedFindings({ file: 'admin/index.php', line: 7 }, findings), ['F-008'], 'a rejected finding is not listed, and index.php is not admin/index.php');
  assert.deepEqual(relatedFindings({ file: 'admin/transaction.php', line: 5 }, findings), ['F-008']);
  assert.deepEqual(relatedFindings({ file: 'index.php', line: 38 }, findings), ['F-002']);
  assert.deepEqual(relatedFindings({ file: 'index.php', line: 27 }, findings), [], 'the same file, thirteen lines away: not this spot');
  assert.deepEqual(relatedFindings({ file: 'cart.php', line: 12 }, findings), []);
  assert.match(mutationMarkdown({ summary: score(results), mutants: [{ id: 'M-011', state: 'survived', file: 'admin/index.php', line: 7, operator: 'guard-flip', after: 'if(isset($_SESSION["AID"])){', ran: 7, pages: ['admin/index.php'], killed_by: [], findings: ['F-008'] }] }), /\| 7 \| F-008 \|/);
  assert.match(md, /\| M-001 \| cart\.php:12 \| write-no-op \|/);
});

test('run-mutation --dry-run lists the mutants of a target and changes nothing; a real run refuses without a baseline', () => {
  const { root, target } = tempProject();
  const src = fs.mkdtempSync(path.join(root, 'src-'));
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), text);
  }
  fs.writeFileSync(path.join(target, '.env'), `MINI_SHOP_DIR=${src.replace(/\\/g, '/')}\n`);
  fs.writeFileSync(path.join(target, 'output', 'inventory.json'), JSON.stringify(inventory));
  const before = fs.readFileSync(path.join(src, 'admin/list.php'), 'utf8');
  const run = (...args) => runNode(MUTATE, ['--target', 'mini-shop', '--root', root, ...args]);

  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /M-001 guard-flip admin\/list\.php:3 {2}if\(!isset\(\$_SESSION\["AID"\]\)\)\{ {2}→ {2}if\(isset\(\$_SESSION\["AID"\]\)\)\{/);
  assert.match(dry.stdout, /6 mutant\(s\) \(2 not applicable\); nothing was changed or run/);
  assert.match(run('--dry-run', '--only', 'writes').stdout, /3 mutant\(s\)/);
  assert.equal(fs.readFileSync(path.join(src, 'admin/list.php'), 'utf8'), before, 'the source is never written');
  assert.ok(!fs.existsSync(path.join(target, 'output', 'mutation')), 'a dry run writes no result');

  const real = run();
  assert.equal(real.status, 1);
  assert.match(real.stderr, /no baseline: run the full tier first|needs the app in a container/);
  assert.equal(run('--only', 'everything').status, 1, 'an unknown kind is a usage error');
  fs.rmSync(root, { recursive: true, force: true });
});
