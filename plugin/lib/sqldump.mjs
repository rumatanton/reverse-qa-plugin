// Parse a MySQL/MariaDB dump without a database: tables, columns, keys, foreign keys and the exact row count per table.
// Handles phpMyAdmin's layout (keys added later by ALTER TABLE) as well as keys declared inside CREATE TABLE.

/** Split SQL text into statements on top-level semicolons, skipping comments and respecting quotes and escapes. */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') {
        cur += next ?? '';
        i++;
      } else if (c === quote) {
        if (next === quote) {
          cur += next; // doubled quote inside a string
          i++;
        } else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
    } else if ((c === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      cur += ' ';
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split on commas that are not inside parentheses or quotes. */
function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') {
        cur += text[++i] ?? '';
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const unq = (s) => s.trim().replace(/^[`"]|[`"]$/g, '');
const colList = (s) => s.split(',').map(unq);

/** Number of top-level value tuples in the VALUES part of an INSERT. */
export function countTuples(values) {
  let depth = 0;
  let quote = null;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const c = values[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) {
        if (values[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') {
      if (depth === 0) n++;
      depth++;
    } else if (c === ')') depth--;
  }
  return n;
}

function table(tables, name) {
  tables[name] ??= { columns: [], primaryKey: [], foreignKeys: [], rows: 0 };
  return tables[name];
}

function addConstraint(t, def) {
  let m;
  if ((m = def.match(/^(?:ADD\s+)?(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i))) {
    t.primaryKey = colList(m[1]);
  } else if (
    (m = def.match(/^(?:ADD\s+)?(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\S+)\s*\(([^)]+)\)(.*)$/is))
  ) {
    const cols = colList(m[1]);
    const refCols = colList(m[3]);
    const onDelete = (m[4].match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/i)?.[1] ?? '').toUpperCase();
    cols.forEach((c, i) => t.foreignKeys.push({ column: c, refTable: unq(m[2]), refColumn: refCols[i], onDelete: onDelete || null }));
  }
}

/** Parse a whole dump. Returns { tables: { name: { columns, primaryKey, foreignKeys, rows } }, statements }. */
export function parseDump(sql) {
  const tables = {};
  const statements = splitStatements(sql);
  for (const st of statements) {
    let m;
    if ((m = st.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(([\s\S]*)\)[^)]*$/i))) {
      const t = table(tables, unq(m[1]));
      for (const def of splitTopLevel(m[2])) {
        if (/^(PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|KEY|INDEX|FULLTEXT|CHECK)\b/i.test(def)) {
          addConstraint(t, def);
          continue;
        }
        const cm = def.match(/^([`"]?[\w$]+[`"]?)\s+([a-z]+(?:\s*\([^)]*\))?(?:\s+unsigned)?)(.*)$/i);
        if (!cm) continue;
        const rest = cm[3];
        t.columns.push({
          name: unq(cm[1]),
          type: cm[2].replace(/\s+/g, ' ').toLowerCase(),
          nullable: !/\bNOT\s+NULL\b/i.test(rest),
          autoIncrement: /\bAUTO_INCREMENT\b/i.test(rest),
        });
        if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
          t.primaryKey = [unq(cm[1])];
          t.columns.at(-1).nullable = false; // a primary key column is NOT NULL even when the dump does not say so
        }
      }
    } else if ((m = st.match(/^ALTER\s+TABLE\s+(\S+)\s+([\s\S]*)$/i))) {
      const t = table(tables, unq(m[1]));
      for (const def of splitTopLevel(m[2])) {
        // phpMyAdmin and mysqldump declare AUTO_INCREMENT after the data: ALTER TABLE `t` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT
        const mm = def.match(/^MODIFY\s+(?:COLUMN\s+)?([`"]?[\w$]+[`"]?)\s+(.*)$/is);
        const col = mm && t.columns.find((c) => c.name === unq(mm[1]));
        if (col) {
          col.autoIncrement = /\bAUTO_INCREMENT\b/i.test(mm[2]);
          col.nullable = !/\bNOT\s+NULL\b/i.test(mm[2]) && !t.primaryKey.includes(col.name);
        } else addConstraint(t, def);
      }
    } else if ((m = st.match(/^INSERT\s+(?:IGNORE\s+)?INTO\s+(\S+)\s*(?:\([^)]*\))?\s*VALUES\s*([\s\S]*)$/i))) {
      table(tables, unq(m[1])).rows += countTuples(m[2]);
    }
  }
  return { tables, statements: statements.length };
}

/** { table: rowCount } from a parsed dump. */
export function rowCounts(parsed) {
  return Object.fromEntries(Object.entries(parsed.tables).map(([k, v]) => [k, v.rows]));
}
