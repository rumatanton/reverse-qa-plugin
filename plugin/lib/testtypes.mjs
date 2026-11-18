// Test types: the catalogue of what reverse-qa runs and does not run yet (skills/recon/test-types.yaml), and the check
// of a target's output/docs/08-test-types.md against it. The analyst may propose a type the catalogue lacks, but it
// cannot call a type "have" that the tool does not run on this app's driver, or propose one without evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const CATALOGUE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'recon', 'test-types.yaml');
export const TEST_TYPES_DOC = '08-test-types.md';
export const STATUSES = ['have', 'not applicable', 'not built', 'proposed'];

const CITE = /\[cite:\s*[^\s:\]"]+:\d+\s+"(?:[^"\\]|\\.)*"\]/g;

export function loadCatalogue(file = CATALOGUE_FILE) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

/** The rows of the document's table (type | status | why | evidence | tool), each with its line in the document. */
export function tableRows(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    // a quoted line of code may hold a "|": keep it out of the cell split
    const masked = line.trim().replace(CITE, (m) => m.replace(/\|/g, '\u0001'));
    const cells = masked.replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/\u0001/g, '|').trim());
    if (cells.length < 5 || /^:?-{2,}:?$/.test(cells[0]) || cells[0].toLowerCase() === 'type') return;
    rows.push({ type: cells[0].replace(/`/g, ''), status: cells[1].toLowerCase(), why: cells[2], evidence: cells[3], tool: cells.slice(4).join(' | '), docLine: i + 1 });
  });
  return rows;
}

/** Problems in a target's 08-test-types.md, as { doc, docLine, reason }. `driver` is the target's driver (web, api, electron). */
export function checkTestTypesDoc(text, doc, catalogue, driver) {
  const issues = [];
  const add = (docLine, reason) => issues.push({ doc, docLine, reason });
  const byId = new Map(catalogue.map((t) => [t.id, t]));
  const seen = new Map();
  for (const r of tableRows(text)) {
    if (!STATUSES.includes(r.status)) {
      add(r.docLine, `test type "${r.type}": status "${r.status}" is not one of ${STATUSES.join(', ')}`);
      continue;
    }
    if (seen.has(r.type)) add(r.docLine, `test type "${r.type}" is listed twice (first on line ${seen.get(r.type)})`);
    seen.set(r.type, r.docLine);
    const known = byId.get(r.type);
    if (!known) {
      if (r.status !== 'proposed') add(r.docLine, `"${r.type}" is not in the catalogue (skills/recon/test-types.yaml): a type the tool does not list is "proposed"`);
      if (!r.evidence.includes('[cite:')) add(r.docLine, `proposed test type "${r.type}" has no citation: cite the code that creates the need, or drop the row`);
      if (!r.tool || r.tool === '-') add(r.docLine, `proposed test type "${r.type}" names no tool that could run it`);
      continue;
    }
    if (r.status === 'proposed') {
      add(r.docLine, `"${r.type}" is already in the catalogue: say have, not built or not applicable`);
      continue;
    }
    const runsHere = known.status === 'built' && (!known.drivers || known.drivers.includes(driver));
    if (r.status === 'have' && !runsHere) {
      add(r.docLine, known.status === 'built' ? `"${r.type}" does not run on the ${driver} driver (it runs on ${known.drivers.join(', ')}): say not applicable` : `"${r.type}" is not built (the catalogue says: ${known.gap}): say not built`);
    }
    if (r.status === 'not built' && known.status === 'built') add(r.docLine, `"${r.type}" is built (run by ${known.by}): say have, or not applicable with the reason`);
    if (r.status === 'not applicable' && (!r.why || r.why === '-')) add(r.docLine, `"${r.type}" is not applicable: say why in a few words`);
  }
  for (const t of catalogue) if (!seen.has(t.id)) add(1, `test type "${t.id}" from the catalogue has no row: every listed type gets one, even when it does not apply`);
  return issues;
}
