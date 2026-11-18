// The run ledger: one JSON line per step in targets/<t>/output/ledger.jsonl. Append-only, so re-runs never hide history.
import fs from 'node:fs';
import path from 'node:path';

export function outputDir(targetDirPath) {
  return path.join(targetDirPath, 'output');
}

/** Append { ts, step, ...fields } and return the entry. */
export function appendLedger(targetDirPath, step, fields = {}) {
  const dir = outputDir(targetDirPath);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { ts: new Date().toISOString(), step, ...fields };
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readLedger(targetDirPath) {
  const file = path.join(outputDir(targetDirPath), 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Write a file under output/, creating folders. Returns the absolute path. */
export function writeOutput(targetDirPath, rel, content) {
  const file = path.join(outputDir(targetDirPath), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
