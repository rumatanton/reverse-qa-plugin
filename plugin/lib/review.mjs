// The review gate, one item at a time. An item is a requirement (with its risk-register row) or a user story. A
// decision is recorded against the item's content: edit an approved requirement and it is "changed" until a person
// looks again. Nothing here calls a model; the person's name is on every decision.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { outputDir } from './ledger.mjs';
import { parseCsv } from './csv.mjs';

export const DECISIONS = ['approved', 'rejected'];

/** JSON with object keys in a fixed order, so the same content always hashes the same. */
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
export const hashOf = (content) => crypto.createHash('sha256').update(stable(content ?? null)).digest('hex').slice(0, 16);

/** What a person reviews, as { id, kind, fields }: a requirement carries its risk score, since the gate approves both. */
export function itemsOf({ requirements = [], risks = [], stories = [] }) {
  const risk = new Map((risks ?? []).map((r) => [r.req_id, r]));
  const items = (requirements ?? []).map((r) => ({ id: r.id, kind: 'requirement', fields: { ...r, risk: risk.get(r.id) ?? null } }));
  for (const s of stories ?? []) items.push({ id: s.id, kind: 'story', fields: s });
  return items;
}

const fieldHashes = (fields) => Object.fromEntries(Object.keys(fields).filter((k) => k !== 'id').sort().map((k) => [k, hashOf(fields[k])]));

/**
 * Where each item stands: `approved`, `rejected`, `changed` (decided, then edited: the fields that differ are named)
 * or `pending` (never reviewed).
 */
export function statusOf(items, review = {}) {
  return items.map((it) => {
    const r = review.items?.[it.id];
    const hash = hashOf(it.fields);
    if (!r) return { ...it, hash, state: 'pending' };
    if (r.hash !== hash) {
      const now = fieldHashes(it.fields);
      const changed = [...new Set([...Object.keys(now), ...Object.keys(r.fields ?? {})])].filter((k) => now[k] !== r.fields?.[k]).sort();
      return { ...it, hash, state: 'changed', was: r.status, changed, by: r.by, at: r.at };
    }
    return { ...it, hash, state: r.status, by: r.by, at: r.at, note: r.note ?? '' };
  });
}

/**
 * Record a decision. `ids` are item ids, or the words `all`, `requirements`, `stories`. A person's name is required,
 * and a rejection needs its reason. Returns { review, decided: [ids], unknown: [ids] }; nothing is written here.
 */
export function decide(items, review, { ids, status, by, at, note = '' }) {
  if (!DECISIONS.includes(status)) throw new Error(`a decision is one of ${DECISIONS.join(', ')}`);
  if (!by || !String(by).trim()) throw new Error('say who decides: --by <Name>');
  if (status === 'rejected' && !String(note).trim()) throw new Error('a rejection needs its reason: --note "why"');
  const byId = new Map(items.map((it) => [it.id, it]));
  const want = new Set();
  const unknown = [];
  for (const id of ids) {
    if (id === 'all') for (const it of items) want.add(it.id);
    else if (id === 'requirements' || id === 'stories') for (const it of items) { if (`${it.kind === 'story' ? 'stories' : 'requirements'}` === id) want.add(it.id); }
    else if (byId.has(id)) want.add(id);
    else unknown.push(id);
  }
  const next = { ...(review ?? {}), items: { ...(review?.items ?? {}) } };
  const decided = [];
  for (const id of want) {
    const it = byId.get(id);
    const hash = hashOf(it.fields);
    const prev = next.items[id];
    if (prev && prev.hash === hash && prev.status === status) continue; // already decided this way at this content
    next.items[id] = { status, hash, fields: fieldHashes(it.fields), by: String(by).trim(), at, ...(String(note).trim() ? { note: String(note).trim() } : {}) };
    decided.push(id);
  }
  return { review: next, decided, unknown };
}

/** Counts by state, and the ids that are not approved. */
export function summary(states) {
  const count = { approved: 0, pending: 0, changed: 0, rejected: 0 };
  for (const s of states) count[s.state]++;
  return { total: states.length, ...count, waiting: states.filter((s) => s.state !== 'approved').map((s) => s.id) };
}

// ---- files ----

export function reviewFile(targetDirPath) {
  return path.join(outputDir(targetDirPath), 'review.json');
}

export function loadReviewInputs(targetDirPath) {
  const out = outputDir(targetDirPath);
  const yaml = (f) => (fs.existsSync(path.join(out, f)) ? YAML.parse(fs.readFileSync(path.join(out, f), 'utf8')) : null);
  const risksFile = path.join(out, 'risk-register.csv');
  const file = reviewFile(targetDirPath);
  return {
    requirements: yaml('requirements.yaml') ?? [],
    stories: yaml('stories.yaml') ?? [],
    risks: fs.existsSync(risksFile) ? parseCsv(fs.readFileSync(risksFile, 'utf8')) : [],
    review: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
  };
}

/**
 * Ids of the requirements a person has approved and nobody has edited since, or null when the gate has not been
 * started for this target (no output/review.json): then nothing is held back, as before the gate existed.
 */
export function approvedRequirementIds(targetDirPath) {
  const inputs = loadReviewInputs(targetDirPath);
  if (!inputs.review) return null;
  return new Set(statusOf(itemsOf(inputs), inputs.review).filter((s) => s.kind === 'requirement' && s.state === 'approved').map((s) => s.id));
}
