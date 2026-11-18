import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitStatements, countTuples, parseDump, rowCounts } from '../../lib/sqldump.mjs';
import { FIXTURE_SRC } from '../helpers.mjs';

test('splitStatements ignores semicolons inside quotes and comments', () => {
  const sql = "-- a; comment\nINSERT INTO t VALUES ('a;b', \"c;d\");\n/* x; y */ SELECT 1; # tail; here\nSELECT 'it''s';";
  assert.deepEqual(splitStatements(sql), ["INSERT INTO t VALUES ('a;b', \"c;d\")", 'SELECT 1', "SELECT 'it''s'"]);
});

test('splitStatements keeps a backslash-escaped quote inside the string', () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('Bob\\'s; pen');SELECT 2"), ["INSERT INTO t VALUES ('Bob\\'s; pen')", 'SELECT 2']);
});

test('countTuples counts top-level groups only, ignoring parentheses inside strings', () => {
  assert.equal(countTuples("(1, 'a (b)'), (2, 'c), (d'), (3, NOW())"), 3);
  assert.equal(countTuples(''), 0);
});

test('parseDump reads columns, ALTER-added keys and foreign keys from the fixture seed', () => {
  const parsed = parseDump(fs.readFileSync(path.join(FIXTURE_SRC, 'seed.sql'), 'utf8'));
  assert.deepEqual(Object.keys(parsed.tables).sort(), ['cart', 'orders', 'products', 'users']);
  assert.deepEqual(rowCounts(parsed), { users: 2, products: 3, cart: 0, orders: 0 });
  assert.deepEqual(parsed.tables.cart.primaryKey, ['id']);
  assert.deepEqual(parsed.tables.cart.foreignKeys, [
    { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' },
    { column: 'product_id', refTable: 'products', refColumn: 'id', onDelete: 'CASCADE' },
  ]);
  assert.equal(parsed.tables.orders.foreignKeys[0].onDelete, null);
  assert.deepEqual(parsed.tables.products.columns.map((c) => [c.name, c.type, c.nullable, c.autoIncrement]), [
    ['id', 'int(11)', false, true], // AUTO_INCREMENT comes from the later ALTER TABLE ... MODIFY (found by the tech-analyst behavior run)
    ['name', 'varchar(250)', false, false],
    ['price', 'int(11)', false, false],
  ]);
  for (const t of ['users', 'products', 'cart', 'orders']) assert.equal(parsed.tables[t].columns[0].autoIncrement, true, `${t}.id`);
});

test('parseDump also reads keys declared inside CREATE TABLE', () => {
  const parsed = parseDump(fs.readFileSync(path.join(FIXTURE_SRC, 'schema.sql'), 'utf8'));
  assert.deepEqual(parsed.tables.users.primaryKey, ['id']);
  assert.deepEqual([parsed.tables.users.columns[0].autoIncrement, parsed.tables.users.columns[0].nullable], [true, false], 'an inline PRIMARY KEY is NOT NULL');
  assert.deepEqual(parsed.tables.orders.foreignKeys, [{ column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: null }]);
});
