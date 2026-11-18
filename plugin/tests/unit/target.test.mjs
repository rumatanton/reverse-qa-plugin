import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isInside, listTargets, loadTarget } from '../../lib/target.mjs';
import { tempProject, FIXTURE_SRC } from '../helpers.mjs';

test('isInside: same dir and children are inside; parents and prefix-siblings are not', () => {
  const base = path.resolve('/srv/app');
  assert.equal(isInside(base, base), true);
  assert.equal(isInside(path.join(base, 'admin', 'x.php'), base), true);
  assert.equal(isInside(path.join(base, '..', 'other'), base), false);
  assert.equal(isInside(path.resolve('/srv/app2/x.php'), base), false);
  assert.equal(isInside(path.resolve('/srv'), base), false);
});

test('isInside: case-insensitive on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isInside('C:\\Users\\X\\App\\index.php', 'c:/users/x/app'), true);
});

test('listTargets finds every folder with a target.yaml', () => {
  const { root } = tempProject();
  fs.mkdirSync(path.join(root, 'targets', 'not-a-target'));
  assert.deepEqual(listTargets(root), ['mini-shop']);
  assert.deepEqual(listTargets(path.join(root, 'missing')), []);
});

test('loadTarget resolves the source dir from .env', () => {
  const { root } = tempProject();
  delete process.env.MINI_SHOP_DIR;
  const t = loadTarget(root, 'mini-shop');
  assert.equal(path.resolve(t.sourceDir), path.resolve(FIXTURE_SRC));
  assert.equal(t.def.source.stack, 'php');
});

test('loadTarget: the process environment overrides .env', () => {
  const { root } = tempProject();
  process.env.MINI_SHOP_DIR = path.join(FIXTURE_SRC, 'admin');
  try {
    assert.equal(loadTarget(root, 'mini-shop').sourceDir, path.join(FIXTURE_SRC, 'admin'));
  } finally {
    delete process.env.MINI_SHOP_DIR;
  }
});

test('loadTarget fails loudly on a missing target, missing dir_env, or unset variable', () => {
  const { root, target } = tempProject();
  assert.throws(() => loadTarget(root, 'nope'), /no target definition/);
  fs.writeFileSync(path.join(target, '.env'), '');
  assert.throws(() => loadTarget(root, 'mini-shop'), /MINI_SHOP_DIR is not set/);
  fs.writeFileSync(path.join(target, 'target.yaml'), 'name: mini-shop\nsource:\n  stack: php\n');
  assert.throws(() => loadTarget(root, 'mini-shop'), /source.dir_env is missing/);
});
