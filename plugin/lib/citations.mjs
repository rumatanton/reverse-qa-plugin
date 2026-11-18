// Citation extraction and verification for recon documents (conventions.md, "Citations").
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isInside } from './target.mjs';

export const WINDOW = 2; // the quote may sit up to 2 lines away from the cited line
export const QUOTE_MIN = 5;
export const QUOTE_MAX = 80;

const CITE = /\[cite:\s*([^\s:\]"]+):(\d+)\s+"((?:[^"\\]|\\.)*)"\]/g;
const MARKER = /\[cite:/g;

const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/** Citations in a Markdown document, plus markers that don't follow the format. */
export function extractFromMarkdown(text, doc) {
  const citations = [];
  const problems = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    const found = [...lineText.matchAll(CITE)];
    for (const m of found) {
      citations.push({ doc, docLine: i + 1, file: m[1], line: Number(m[2]), quote: m[3].replace(/\\"/g, '"') });
    }
    const markers = (lineText.match(MARKER) || []).length;
    if (markers > found.length) {
      problems.push({ doc, docLine: i + 1, reason: 'malformed citation: expected [cite: path:line "quote"]' });
    }
  });
  return { citations, problems };
}

/** Citations in requirements.yaml (evidence entries), plus requirements that carry none. */
export function extractFromRequirements(text, doc) {
  const citations = [];
  const problems = [];
  let reqs;
  try {
    reqs = YAML.parse(text);
  } catch (err) {
    return { citations, problems: [{ doc, docLine: 0, reason: `YAML does not parse: ${err.message}` }] };
  }
  if (!Array.isArray(reqs)) {
    return { citations, problems: [{ doc, docLine: 0, reason: 'requirements.yaml must be a list of requirements' }] };
  }
  reqs.forEach((req, i) => {
    const id = req?.id ?? `#${i + 1}`;
    const evidence = Array.isArray(req?.evidence) ? req.evidence : [];
    if (evidence.length === 0) problems.push({ doc, docLine: 0, reqId: id, reason: `requirement ${id} has no evidence` });
    for (const e of evidence) {
      citations.push({ doc, docLine: 0, reqId: id, file: String(e?.file ?? ''), line: Number(e?.line), quote: String(e?.quote ?? '') });
    }
  });
  return { citations, problems };
}

/** Extract from a document by its type (.md or requirements .yaml). */
export function extractFromFile(docPath) {
  const text = fs.readFileSync(docPath, 'utf8');
  return /\.ya?ml$/i.test(docPath) ? extractFromRequirements(text, docPath) : extractFromMarkdown(text, docPath);
}

/** Verify each citation against the source tree. Returns the failures (empty = all resolve). */
export function verify(citations, sourceDir) {
  const cache = new Map();
  const failures = [];
  const fail = (c, reason) => failures.push({ ...c, reason });
  for (const c of citations) {
    const q = normalize(c.quote);
    if (q.length < QUOTE_MIN || q.length > QUOTE_MAX) {
      fail(c, `quote must be ${QUOTE_MIN}-${QUOTE_MAX} characters (got ${q.length})`);
      continue;
    }
    if (!c.file) {
      fail(c, 'no file given');
      continue;
    }
    const abs = path.resolve(sourceDir, c.file);
    if (!isInside(abs, sourceDir) || path.isAbsolute(c.file)) {
      fail(c, 'path must be relative to the source root and stay inside it');
      continue;
    }
    if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : null);
    const lines = cache.get(abs);
    if (!lines) {
      fail(c, 'file not found in the target source');
      continue;
    }
    if (!Number.isInteger(c.line) || c.line < 1 || c.line > lines.length) {
      fail(c, `line out of range (file has ${lines.length} lines)`);
      continue;
    }
    const from = Math.max(0, c.line - 1 - WINDOW);
    const to = Math.min(lines.length, c.line + WINDOW);
    if (!lines.slice(from, to).some((l) => normalize(l).includes(q))) {
      fail(c, `quote not found within ${WINDOW} lines of line ${c.line}`);
    }
  }
  return failures;
}

/** One readable line per failure or problem. */
export function formatIssue(x) {
  const where = x.reqId ? `${x.doc} (${x.reqId})` : `${x.doc}:${x.docLine}`;
  return x.file !== undefined ? `${where} -> ${x.file}:${x.line} "${x.quote}": ${x.reason}` : `${where}: ${x.reason}`;
}
