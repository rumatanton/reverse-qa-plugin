// Mutants: small defects made on purpose in the running copy of the app, one at a time, to learn whether any test
// notices. They come from facts the inventory already holds (a session guard, an UPDATE or DELETE), so each one is a
// defect a tester would want caught. A passing suite that lets one through is checking less than it looks.
// Text patterns only: a line no pattern fits is listed as not applicable, never guessed at.

/** guard-flip: a session check is turned around (`!isset(` to `isset(`, or back), so the wrong people get the page. */
export function flipGuard(line) {
  if (/!\s*isset\s*\(\s*\$_SESSION/.test(line)) return line.replace(/!\s*isset(\s*\(\s*\$_SESSION)/, 'isset$1');
  if (/isset\s*\(\s*\$_SESSION/.test(line)) return line.replace(/isset(\s*\(\s*\$_SESSION)/, '!isset$1');
  return null;
}

/**
 * write-no-op: the WHERE of an UPDATE or DELETE gets `1=0 and`, so the statement still runs and changes nothing.
 * The statement may span lines: look from the cited line for the verb, then for its first WHERE. Returns
 * { index, text } (the 0-based line to replace and its new text) or null.
 */
export function noOpWhere(lines, at, verb, { reach = 15 } = {}) {
  // the verb as SQL writes it (UPDATE <table>, DELETE FROM), so a form field named "update" on the way is not taken for it
  const verbRe = verb.toUpperCase() === 'DELETE' ? /\bDELETE\s+FROM\b/i : /\bUPDATE\s+[`\w.]+/i;
  let started = false;
  for (let i = at; i < Math.min(lines.length, at + reach); i++) {
    let from = 0;
    if (!started) {
      const m = lines[i].match(verbRe);
      if (!m) continue; // the cited line may sit a line or two above the statement
      started = true;
      from = m.index + m[0].length;
    }
    const w = lines[i].slice(from).match(/\bwhere\b/i);
    if (w) {
      const pos = from + w.index;
      return { index: i, text: `${lines[i].slice(0, pos)}${w[0]} 1=0 and${lines[i].slice(pos + w[0].length)}` };
    }
    if (/;\s*$/.test(lines[i])) return null; // the statement ended with no WHERE
  }
  return null;
}

/** Pages a file belongs to: the page itself, and every page that includes it. */
export function pagesFor(inventory, file) {
  return (inventory.pages ?? []).filter((p) => p.path === file || (p.includes ?? []).includes(file)).map((p) => p.path).sort();
}

/**
 * Every mutant the inventory allows, in a stable order: one per session guard, one per UPDATE or DELETE.
 * readFile(relPath) returns the source text. Each mutant: { id, operator, file, line, before, after, pages }, or with
 * `na` (why no pattern fits) instead of `after`. Two facts that land on the same line make one mutant.
 */
export function buildMutants(inventory, readFile) {
  const cache = new Map();
  const linesOf = (file) => {
    if (!cache.has(file)) cache.set(file, String(readFile(file)).split(/\r?\n/));
    return cache.get(file);
  };
  const sites = [];
  for (const p of inventory.pages ?? []) for (const g of p.guards ?? []) sites.push({ operator: 'guard-flip', file: g.file, line: g.line });
  for (const s of inventory.sql ?? []) if (['UPDATE', 'DELETE'].includes(s.verb)) sites.push({ operator: 'write-no-op', file: s.file, line: s.line, verb: s.verb });
  const seen = new Set();
  const out = [];
  for (const s of sites.sort((a, b) => a.operator.localeCompare(b.operator) || a.file.localeCompare(b.file) || a.line - b.line)) {
    let lines;
    try {
      lines = linesOf(s.file);
    } catch {
      continue; // a file the inventory names and the source no longer has
    }
    let index = s.line - 1;
    let after = null;
    if (s.operator === 'guard-flip') after = lines[index] === undefined ? null : flipGuard(lines[index]);
    else {
      const m = noOpWhere(lines, index, s.verb);
      if (m) ({ index, text: after } = m);
    }
    const key = `${s.operator}|${s.file}|${after === null ? s.line : index + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { operator: s.operator, file: s.file, line: index + 1, before: (lines[index] ?? '').trim(), pages: pagesFor(inventory, s.file) };
    out.push(after === null ? { ...base, line: s.line, before: (lines[s.line - 1] ?? '').trim(), na: s.operator === 'guard-flip' ? 'the guard line is not a session check this pattern knows' : 'no WHERE found for this statement' } : { ...base, after: after.trim(), newLine: after });
  }
  return out.map((m, i) => ({ id: `M-${String(i + 1).padStart(3, '0')}`, ...m }));
}

/** The file's text with the mutant in it. Refuses when the line is no longer what the mutant was built from. */
export function applyMutant(text, mutant) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if ((lines[mutant.line - 1] ?? '').trim() !== mutant.before) throw new Error(`${mutant.file}:${mutant.line} is not the line this mutant was built from`);
  lines[mutant.line - 1] = mutant.newLine;
  return lines.join(eol);
}

/** A grep that selects the tests tagged with any of these pages (`@page:<path>`), and no page that merely starts the same. */
export function grepFor(pages) {
  return `@page:(${pages.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\s|$)`;
}

/**
 * What a mutant's run says. `before` are the baseline results of the tests that ran again, `after` the results with
 * the mutant in place. A test whose result changed noticed the mutant; a test that already failed in the baseline
 * proves nothing either way and is left out.
 *   killed    at least one test changed its result
 *   survived  tests ran, and every one gave the result it gave without the mutant
 *   no-tests  no test is tagged with a page this file belongs to
 */
export function judge(before, after, { setupFailed = null } = {}) {
  if (setupFailed) return { state: 'killed', killed_by: [`the suite could not start: ${setupFailed}`], ran: 0 };
  const key = (r) => `${r.file}|${r.title}|${r.project}`;
  const base = new Map(before.map((r) => [key(r), r]));
  const clean = (r) => ['passed', 'known-defect'].includes(r.outcome);
  const ran = after.filter((r) => r.outcome !== 'skipped' && base.has(key(r)) && clean(base.get(key(r))));
  if (ran.length === 0) return { state: 'no-tests', killed_by: [], ran: 0 };
  const changed = ran.filter((r) => r.outcome !== base.get(key(r)).outcome);
  return { state: changed.length ? 'killed' : 'survived', killed_by: changed.slice(0, 3).map((r) => `${r.title.replace(/\s+@\S+/g, '').trim()} (${base.get(key(r)).outcome} → ${r.outcome})`), ran: ran.length };
}

/**
 * Findings that already cite the mutated spot: `file:line` in their root cause or evidence, within `near` lines of
 * the mutant. A mutant that survives beside one may sit on code that already does nothing (a guard a known finding
 * says is bypassed): that is the finding seen again, not a missing test. The whole file would be too wide a net: one
 * finding about how every query is built cites nearly every file.
 */
export function relatedFindings(mutant, findings, { near = 3 } = {}) {
  const at = `${mutant.file}:`;
  const close = (w) => w.startsWith(at) && /^\d+/.test(w.slice(at.length)) && Math.abs(parseInt(w.slice(at.length), 10) - mutant.line) <= near;
  return (findings ?? [])
    .filter((f) => f.status !== 'rejected')
    .filter((f) => `${f.root_cause ?? ''} ${f.evidence ?? ''}`.split(/[\s;,|"'()[\]]+/).some(close))
    .map((f) => f.id)
    .sort();
}

/** Counts and the score: killed out of the mutants a test could have caught (killed + survived + no-tests). */
export function score(results) {
  const n = (state) => results.filter((r) => r.state === state).length;
  const judged = n('killed') + n('survived') + n('no-tests');
  return { total: results.length, killed: n('killed'), survived: n('survived'), no_tests: n('no-tests'), not_applicable: n('not-applicable'), score_pct: judged ? Math.round((n('killed') / judged) * 1000) / 10 : null };
}

export function mutationMarkdown(doc) {
  const s = doc.summary;
  const lines = [
    '# Mutation check',
    '',
    `${s.total} mutant(s): ${s.killed} killed, ${s.survived} survived, ${s.no_tests} with no test, ${s.not_applicable} not applicable. Score: ${s.score_pct ?? '-'}% of the mutants a test could have caught.`,
    '',
    'A mutant is one small defect put into the running copy of the app (never the source): a session check turned around, or an UPDATE or DELETE that changes nothing. Killed means a test changed its result. Survived means every test that ran gave the same result as without the defect. Either those tests do not check this behaviour, which is a test to write, or the changed line already had no effect, which is a defect in the app: the last column names the findings that cite a line within three of the changed one.',
    '',
  ];
  const table = (title, rows, cols) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, '', `| ${cols.map((c) => c[0]).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => String(c[1](r)).replace(/\|/g, '\\|')).join(' | ')} |`), '');
  };
  const where = (r) => `${r.file}:${r.line}`;
  table('Survived: a defect no test noticed', doc.mutants.filter((r) => r.state === 'survived'), [['Mutant', (r) => r.id], ['Where', where], ['Kind', (r) => r.operator], ['Changed to', (r) => `\`${r.after}\``], ['Tests that ran', (r) => r.ran], ['Findings citing this spot', (r) => (r.findings ?? []).join(' ') || '-']]);
  table('No test', doc.mutants.filter((r) => r.state === 'no-tests'), [['Mutant', (r) => r.id], ['Where', where], ['Kind', (r) => r.operator], ['Pages', (r) => r.pages.join(', ') || 'none']]);
  table('Killed', doc.mutants.filter((r) => r.state === 'killed'), [['Mutant', (r) => r.id], ['Where', where], ['Kind', (r) => r.operator], ['Noticed by', (r) => r.killed_by[0] ?? '']]);
  table('Not applicable', doc.mutants.filter((r) => r.state === 'not-applicable'), [['Mutant', (r) => r.id], ['Where', where], ['Kind', (r) => r.operator], ['Why', (r) => r.na]]);
  return `${lines.join('\n')}\n`;
}
