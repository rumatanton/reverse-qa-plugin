#!/usr/bin/env node
// build-stories: user stories from the requirements. Code does the grouping, the traceability and the priority; a model
// only words the story line and the acceptance criteria (workflow-analyst, stories mode), and --check re-derives every
// computed field, so the wording step cannot drift the structure.
//   node stories.mjs --target <name> [--root <project>]           build or refresh, then check
//   node stories.mjs --target <name> --check [--root <project>]   check only (exit 2 on problems)
//   exit 0 = written / passed, 2 = problems found, 1 = error (missing input, bad arguments)
//
// Two kinds of story:
//   keep  as-is behaviour with no intended rule against it: what the app does today and should go on doing.
//   fix   intended rules (where today differs). The as-is requirements they pair with ("Pairs with REQ-…") are listed
//         under `replaces`: they describe today's broken side and are never acceptance criteria.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { parseCsv } from '../../lib/csv.mjs';
import { privateValues, findLeaks } from '../check-citations/check.mjs';

const ROLES = ['Visitor', 'Customer', 'Admin', 'System'];
export const AS = { Visitor: 'a visitor', Customer: 'a customer', Admin: 'an admin', System: 'the app owner' };
const GIVEN = { Visitor: 'a visitor who is not logged in', Customer: 'a customer who is logged in', Admin: 'an admin who is logged in' };
const KINDS = ['keep', 'fix'];
const PRIORITIES = ['P1', 'P2', 'P3'];
export const STORY_LINE = /^As (a|an|the) .+?, I want .+?, so that .+$/;
const ID = /^US-[A-Z]+-\d{3}$/;

const area = (reqId) => reqId.split('-')[1];
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** The as-is requirement an intended one pairs with ("Pairs with REQ-…" in its notes), or null. */
export function pairOf(req) {
  return (req?.notes ?? '').match(/Pairs with (REQ-[A-Z]+-\d{3})/)?.[1] ?? null;
}

/**
 * Where each requirement goes: { story: key, as: 'requirement' | 'replaces' }. An intended requirement leads a fix
 * story; the as-is requirement it pairs with goes into the same story as `replaces`; every other as-is requirement
 * goes into a keep story. Key = area|feature|role|kind (feature from the risk register).
 */
export function placement(requirements, riskById) {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const keyOf = (r, kind) => [area(r.id), riskById.get(r.id)?.feature ?? area(r.id), r.role, kind].join('|');
  const out = new Map();
  for (const r of requirements) if (r.kind === 'intended') out.set(r.id, { story: keyOf(r, 'fix'), as: 'requirement' });
  for (const r of requirements) {
    if (r.kind !== 'intended') continue;
    const pair = pairOf(r);
    if (pair && byId.get(pair)?.kind !== 'intended' && byId.has(pair) && !out.has(pair)) out.set(pair, { story: out.get(r.id).story, as: 'replaces' });
  }
  for (const r of requirements) if (!out.has(r.id)) out.set(r.id, { story: keyOf(r, 'keep'), as: 'requirement' });
  return out;
}

/**
 * Findings a story documents: findings whose req_id is one of its requirements (or the requirements they pair with),
 * and F-ids named in those requirements' notes. Only findings that exist and are not rejected count. Sorted.
 */
export function findingsFor(reqIds, reqById, findings) {
  const known = new Map(findings.filter((f) => /^F-\d{3}$/.test(f.id) && f.status !== 'rejected').map((f) => [f.id, f]));
  const linked = new Set(reqIds);
  for (const id of reqIds) {
    const pair = pairOf(reqById.get(id));
    if (pair) linked.add(pair);
  }
  const out = new Set();
  for (const f of known.values()) if (linked.has(f.req_id)) out.add(f.id);
  for (const id of linked) for (const m of (reqById.get(id)?.notes ?? '').match(/F-\d{3}/g) ?? []) if (known.has(m)) out.add(m);
  return [...out].sort();
}

/** The highest priority (P1 > P2 > P3) of the requirements in the risk register; '' if none is scored. */
export function priorityFor(reqIds, riskById) {
  const ps = reqIds.map((id) => riskById.get(id)?.priority).filter((p) => PRIORITIES.includes(p));
  return ps.length ? ps.sort()[0] : '';
}

/** Draft acceptance criterion from an EARS statement: "When X, the system shall Y." → when X / then the system shall Y. */
export function draftAcceptance(req) {
  const s = String(req.statement ?? '').trim();
  const m = s.match(/^(When|While|If|Where)\s+(.+?),\s+(the system shall\s+.+?)\.?$/i);
  const item = { req: req.id };
  if (GIVEN[req.role]) item.given = GIVEN[req.role];
  if (m) Object.assign(item, { when: m[2], then: m[3] });
  else item.then = s.replace(/\.$/, '');
  return item;
}

/** Draft story line: mechanical, marked `wording: draft` until the wording step replaces it. */
export function draftStory(role, feature, kind) {
  const what = feature.toLowerCase();
  return kind === 'fix'
    ? `As ${AS[role] ?? role}, I want ${what} to follow the rules below, so that today's broken behaviour is replaced`
    : `As ${AS[role] ?? role}, I want ${what} to keep working as it does today, so that the behaviour below is protected`;
}

/** The structure code owns, per story key: { requirements, replaces }. */
function structure(requirements, risks) {
  const riskById = new Map(risks.map((r) => [r.req_id, r]));
  const place = placement(requirements, riskById);
  const groups = new Map();
  for (const r of requirements) {
    const p = place.get(r.id);
    const g = groups.get(p.story) ?? { requirements: [], replaces: [] };
    (p.as === 'replaces' ? g.replaces : g.requirements).push(r.id);
    groups.set(p.story, g);
  }
  return { groups, place, riskById };
}

/**
 * Group requirements into stories. `previous` (an earlier stories.yaml) keeps ids stable and keeps final wording for a
 * story whose requirements did not change. Returns { stories, kept, redrafted }.
 */
export function buildStories({ requirements, risks = [], findings = [], previous = [] }) {
  const { groups, riskById } = structure(requirements, risks);
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const areaOrder = [...new Set(requirements.map((r) => area(r.id)))];
  const sortKey = (k) => {
    const [a, feature, role, kind] = k.split('|');
    return [String(areaOrder.indexOf(a)).padStart(3, '0'), feature, ROLES.indexOf(role), KINDS.indexOf(kind)].join('|');
  };
  const keys = [...groups.keys()].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const prevByKey = new Map((previous ?? []).filter((s) => s?.id && s.area).map((s) => [[s.area, s.epic, s.role, s.kind].join('|'), s]));
  const used = new Set((previous ?? []).map((s) => s?.id));
  const next = (a) => {
    for (let n = 1; ; n++) {
      const id = `US-${a}-${String(n).padStart(3, '0')}`;
      if (!used.has(id)) { used.add(id); return id; }
    }
  };
  let kept = 0;
  let redrafted = 0;
  const stories = keys.map((key) => {
    const [a, feature, role, kind] = key.split('|');
    const g = groups.get(key);
    const prev = prevByKey.get(key);
    const base = {
      id: prev?.id ?? next(a),
      epic: feature,
      area: a,
      role,
      kind,
      priority: priorityFor(g.requirements, riskById),
      requirements: g.requirements,
      ...(g.replaces.length ? { replaces: g.replaces } : {}),
      findings: findingsFor(g.requirements, reqById, findings),
    };
    if (prev?.wording === 'final' && sameSet(prev.requirements ?? [], g.requirements)) {
      kept++;
      return { ...base, wording: 'final', story: prev.story, acceptance: prev.acceptance };
    }
    if (prev?.wording === 'final') redrafted++;
    return { ...base, wording: 'draft', story: draftStory(role, feature, kind), acceptance: g.requirements.map((id) => draftAcceptance(reqById.get(id))) };
  });
  return { stories, kept, redrafted };
}

/**
 * Check stories against the requirements: structure, traceability and every computed field re-derived. Returns
 * { problems: [text], review: [text] }; problems fail the check, review items are for the person at the review gate.
 */
export function checkStories({ stories, requirements, risks = [], findings = [], leakValues = [], text = '' }) {
  const problems = [];
  const review = [];
  if (!Array.isArray(stories)) return { problems: ['stories.yaml must hold a list of stories'], review };
  const { place, riskById } = structure(requirements, risks);
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const owner = new Map();
  const ids = new Set();
  for (const s of stories) {
    const at = s?.id ?? '(no id)';
    if (!ID.test(s?.id ?? '')) problems.push(`${at}: id must read US-<AREA>-<NNN>`);
    if (ids.has(s?.id)) problems.push(`${at}: duplicate id`);
    ids.add(s?.id);
    if (!ROLES.includes(s?.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
    if (!KINDS.includes(s?.kind)) problems.push(`${at}: kind must be keep or fix`);
    if (!['draft', 'final'].includes(s?.wording)) problems.push(`${at}: wording must be draft or final`);
    const key = [s?.area, s?.epic, s?.role, s?.kind].join('|');
    const reqIds = Array.isArray(s?.requirements) ? s.requirements : [];
    const replaced = Array.isArray(s?.replaces) ? s.replaces : [];
    if (!reqIds.length) problems.push(`${at}: names no requirement`);
    if (s?.kind === 'keep' && replaced.length) problems.push(`${at}: a keep story replaces nothing`);
    for (const [id, as] of [...reqIds.map((x) => [x, 'requirement']), ...replaced.map((x) => [x, 'replaces'])]) {
      if (!reqById.has(id)) { problems.push(`${at}: ${id} is not in requirements.yaml`); continue; }
      if (owner.has(id)) problems.push(`${id} is in two stories: ${owner.get(id)} and ${at}`);
      owner.set(id, at);
      const want = place.get(id);
      if (want.story !== key || want.as !== as) {
        const [wa, wf, wr, wk] = want.story.split('|');
        problems.push(`${at}: ${id} belongs ${want.as === 'replaces' ? 'under replaces' : 'under requirements'} of the ${wk} story for ${wr} in "${wf}" (${wa})`);
      }
    }
    const known = reqIds.filter((id) => reqById.has(id));
    const priority = priorityFor(known, riskById);
    if (!priority) problems.push(`${at}: none of its requirements has a priority in risk-register.csv`);
    else if (s.priority !== priority) problems.push(`${at}: priority must be ${priority} (the highest of its requirements), not ${s.priority}`);
    const expected = findingsFor(known, reqById, findings);
    if (!sameSet(s?.findings ?? [], expected)) problems.push(`${at}: findings must be [${expected.join(', ')}] (from findings.csv and the requirement notes), not [${(s?.findings ?? []).join(', ')}]`);
    if (s?.kind === 'fix' && !expected.length) review.push(`${at}: a fix story with no finding behind it (${known.join(', ')}): is the gap real, and should a test document it?`);
    if (s?.kind === 'keep') {
      for (const id of known) {
        const f = findingsFor([id], reqById, findings);
        if (f.length) review.push(`${at}: keeps ${id}, which names ${f.join(', ')}: confirm it is behaviour to keep, or write the intended requirement`);
      }
    }
    if (!STORY_LINE.test(String(s?.story ?? ''))) problems.push(`${at}: story must read "As a <role>, I want <goal>, so that <benefit>"`);
    const acc = Array.isArray(s?.acceptance) ? s.acceptance : [];
    if (!acc.length) problems.push(`${at}: has no acceptance criteria`);
    for (const a of acc) {
      if (!reqIds.includes(a?.req)) problems.push(`${at}: an acceptance criterion names ${a?.req ?? 'no requirement'}, which is not one of the story's requirements${replaced.includes(a?.req) ? ' (a replaced requirement describes today\'s broken side, never a criterion)' : ''}`);
      if (!String(a?.then ?? '').trim()) problems.push(`${at}: an acceptance criterion for ${a?.req} has no "then"`);
    }
    for (const id of reqIds) if (!acc.some((a) => a?.req === id)) problems.push(`${at}: ${id} has no acceptance criterion`);
    if (s?.wording === 'draft') review.push(`${at}: draft wording (run the workflow-analyst in stories mode)`);
  }
  for (const r of requirements) if (!owner.has(r.id)) problems.push(`${r.id} is in no story`);
  for (const leak of findLeaks(text, 'stories.yaml', leakValues)) problems.push(`stories.yaml:${leak.docLine}: ${leak.reason}`);
  return { problems, review };
}

/** docs/07-user-stories.md: stories by epic, highest priority first inside each epic. */
export function storiesMarkdown(stories, targetName, requirements = []) {
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const epics = [...new Set(stories.map((s) => s.epic))];
  const count = (k) => stories.filter((s) => s.kind === k).length;
  const lines = [
    `# User stories: ${targetName}`,
    '',
    `Generated by build-stories from requirements.yaml, risk-register.csv and findings.csv. ${stories.length} stories (${count('keep')} keep, ${count('fix')} fix) in ${epics.length} epics.`,
    '"keep" stories describe what the app does today and should go on doing. "fix" stories describe the intended rule where',
    'today differs; "Today" lists the as-is behaviour each one replaces.',
    '',
    '| Epic | Stories | P1 | P2 | P3 | Fix |',
    '|---|---|---|---|---|---|',
    ...epics.map((e) => {
      const s = stories.filter((x) => x.epic === e);
      const p = (q) => s.filter((x) => x.priority === q).length;
      return `| ${e} | ${s.length} | ${p('P1')} | ${p('P2')} | ${p('P3')} | ${s.filter((x) => x.kind === 'fix').length} |`;
    }),
    '',
  ];
  for (const e of epics) {
    lines.push(`## ${e}`, '');
    for (const s of stories.filter((x) => x.epic === e).sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))) {
      lines.push(`### ${s.id} · ${s.priority} · ${s.kind}${s.wording === 'draft' ? ' · draft wording' : ''}`, '', s.story, '');
      lines.push(`- Requirements: ${s.requirements.join(', ')}`);
      if (s.findings.length) lines.push(`- Findings: ${s.findings.join(', ')}`);
      for (const id of s.replaces ?? []) lines.push(`- Today (${id}): ${reqById.get(id)?.statement ?? ''}`);
      lines.push('', '```gherkin');
      for (const a of s.acceptance) {
        lines.push(`Scenario: ${a.req}`);
        if (a.given) lines.push(`  Given ${a.given}`);
        if (a.when) lines.push(`  When ${a.when}`);
        lines.push(`  Then ${a.then}`);
      }
      lines.push('```', '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** stories/jira-stories.json: Jira-ready Story issues. Written for a later import; nothing here sends anything. */
export function jiraStories(stories, projectKey = '') {
  return {
    note: 'Not sent anywhere. For a later Jira import after a dry run the person confirms.',
    project_key: projectKey,
    issues: stories.map((s) => ({
      story_id: s.id,
      issuetype: 'Story',
      summary: s.story.length > 255 ? `${s.story.slice(0, 252)}...` : s.story,
      priority: s.priority,
      labels: ['reverse-qa', `epic-${s.epic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, s.kind, ...s.requirements, ...s.findings],
      description: [
        `Requirements: ${s.requirements.join(', ')}`,
        ...(s.replaces?.length ? [`Replaces (today's behaviour): ${s.replaces.join(', ')}`] : []),
        ...(s.findings.length ? [`Findings: ${s.findings.join(', ')}`] : []),
        '',
        'Acceptance criteria:',
        ...s.acceptance.flatMap((a) => [`${a.req}:`, ...(a.given ? [`  Given ${a.given}`] : []), ...(a.when ? [`  When ${a.when}`] : []), `  Then ${a.then}`]),
      ].join('\n'),
    })),
  };
}

function readInputs(target) {
  const out = outputDir(target.dir);
  const reqFile = path.join(out, 'requirements.yaml');
  if (!fs.existsSync(reqFile)) throw new Error('no output/requirements.yaml yet (workflow-analyst writes it in phase 2)');
  const csv = (f) => (fs.existsSync(path.join(out, f)) ? parseCsv(fs.readFileSync(path.join(out, f), 'utf8')) : []);
  const storiesFile = path.join(out, 'stories.yaml');
  const storiesText = fs.existsSync(storiesFile) ? fs.readFileSync(storiesFile, 'utf8') : '';
  return {
    requirements: YAML.parse(fs.readFileSync(reqFile, 'utf8')) ?? [],
    risks: csv('risk-register.csv'),
    findings: csv('findings.csv'),
    storiesText,
    stories: storiesText ? YAML.parse(storiesText) ?? [] : null,
  };
}

const HEADER = '# stories.yaml: user stories, one per area, feature, role and kind (keep or fix). Written by build-stories; the wording\n'
  + '# step (workflow-analyst, stories mode) may change only story, acceptance and wording. --check re-derives the rest.\n';

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, check: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: stories.mjs --target <name> [--check] [--root <project>]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const inputs = readInputs(target);
    let { stories, storiesText } = inputs;
    if (!values.check) {
      const built = buildStories({ ...inputs, previous: stories ?? [] });
      stories = built.stories;
      storiesText = HEADER + YAML.stringify(stories, { lineWidth: 0 });
      writeOutput(target.dir, 'stories.yaml', storiesText);
      writeOutput(target.dir, path.join('docs', '07-user-stories.md'), storiesMarkdown(stories, target.name, inputs.requirements));
      writeOutput(target.dir, path.join('stories', 'jira-stories.json'), `${JSON.stringify(jiraStories(stories, target.def.jira?.project_key ?? ''), null, 2)}\n`);
      process.stdout.write(`build-stories: ${stories.length} stories from ${inputs.requirements.length} requirements (${built.kept} kept their final wording${built.redrafted ? `, ${built.redrafted} redrafted because their requirements changed` : ''})\n`);
    } else if (!stories) throw new Error('no output/stories.yaml yet (run build-stories without --check first)');
    const leakValues = target.sourceDir && fs.existsSync(target.sourceDir) ? privateValues(target) : [];
    const { problems, review } = checkStories({ ...inputs, stories, text: storiesText, leakValues });
    appendLedger(target.dir, 'build-stories', { mode: values.check ? 'check' : 'build', stories: stories.length, problems: problems.length, review: review.length });
    for (const p of problems) process.stdout.write(`build-stories: problem: ${p}\n`);
    const drafts = review.filter((r) => r.includes('draft wording')).length;
    const items = review.filter((r) => !r.includes('draft wording'));
    for (const r of items) process.stdout.write(`build-stories: review: ${r}\n`);
    writeOutput(target.dir, path.join('stories', 'review.md'), `# Stories: items for the review gate\n\n${items.length ? items.map((r) => `- ${r}`).join('\n') : '- none'}\n\n${drafts} story(ies) still in draft wording.\n`);
    process.stdout.write(`build-stories: ${problems.length} problem(s); ${items.length} item(s) for the review gate (output/stories/review.md); ${drafts} story(ies) in draft wording\n`);
    return problems.length ? 2 : 0;
  } catch (err) {
    process.stderr.write(`build-stories: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
