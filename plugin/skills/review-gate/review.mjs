#!/usr/bin/env node
// review-gate: the human review gate, one requirement or user story at a time. A person approves or rejects each item
// by name; an approved item that is edited afterwards counts as changed until someone looks again.
//   node review.mjs --target <name>                                   where every item stands; exit 0 = all approved
//   node review.mjs --target <name> --approve <id>... --by <Name>     ids, or: all | requirements | stories
//   node review.mjs --target <name> --reject <id>... --by <Name> --note "why"
//   node review.mjs --target <name> --show <id>                       one item, and what changed since its decision
//   exit 0 = done (status: everything approved), 2 = something is not approved or an id is unknown, 1 = usage
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { itemsOf, statusOf, decide, summary, loadReviewInputs } from '../../lib/review.mjs';

const USAGE = 'usage: review.mjs --target <name> [--approve <id>...|--reject <id>... --by <Name> [--note "..."]] [--show <id>]\n';

/** The approved requirements and stories as files: what test-designer reads, and nothing a person has not passed. */
function writeApproved(target, states) {
  const ok = (kind) => states.filter((s) => s.kind === kind && s.state === 'approved');
  const reqs = ok('requirement').map(({ fields }) => { const { risk, ...r } = fields; return r; });
  writeOutput(target.dir, 'approved/requirements.yaml', `# The requirements a person approved at the review gate, unchanged since. Written by review-gate; do not edit.\n${YAML.stringify(reqs)}`);
  writeOutput(target.dir, 'approved/stories.yaml', `# The user stories a person approved at the review gate, unchanged since. Written by review-gate; do not edit.\n${YAML.stringify(ok('story').map((s) => s.fields))}`);
}

function statusText(states) {
  const s = summary(states);
  const lines = [`review-gate: ${s.total} item(s): ${s.approved} approved, ${s.pending} pending, ${s.changed} changed since their decision, ${s.rejected} rejected`];
  for (const x of states.filter((y) => y.state === 'changed').slice(0, 40)) lines.push(`  changed  ${x.id}: ${x.changed.join(', ')} (was ${x.was} by ${x.by}, ${x.at})`);
  for (const x of states.filter((y) => y.state === 'rejected').slice(0, 40)) lines.push(`  rejected ${x.id}: ${x.note} (${x.by}, ${x.at})`);
  const pending = states.filter((y) => y.state === 'pending').map((y) => y.id);
  if (pending.length) lines.push(`  pending  ${pending.slice(0, 30).join(', ')}${pending.length > 30 ? `, and ${pending.length - 30} more` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { target: { type: 'string' }, root: { type: 'string' }, approve: { type: 'string' }, reject: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' }, show: { type: 'string' } } });
  } catch (err) {
    process.stderr.write(`review-gate: ${err.message}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (!values.target || (values.approve && values.reject)) {
    process.stderr.write(USAGE);
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const inputs = loadReviewInputs(target.dir);
    const items = itemsOf(inputs);
    if (items.length === 0) throw new Error('nothing to review yet: no output/requirements.yaml');
    let review = inputs.review ?? { items: {} };

    if (values.show) {
      const s = statusOf(items, review).find((x) => x.id === values.show);
      if (!s) throw new Error(`no item ${values.show}`);
      process.stdout.write(`${s.id} (${s.kind}): ${s.state}${s.state === 'changed' ? `: ${s.changed.join(', ')} changed since it was ${s.was} by ${s.by}, ${s.at}` : s.by ? ` by ${s.by}, ${s.at}${s.note ? `: ${s.note}` : ''}` : ''}\n${YAML.stringify(s.fields)}`);
      return 0;
    }

    const status = values.approve ? 'approved' : values.reject ? 'rejected' : null;
    if (status) {
      const ids = [values.approve ?? values.reject, ...positionals];
      const d = decide(items, review, { ids, status, by: values.by, at: new Date().toISOString().slice(0, 10), note: values.note });
      if (d.unknown.length) {
        process.stderr.write(`review-gate: no such item: ${d.unknown.join(', ')}. Nothing was recorded.\n`);
        return 2;
      }
      review = d.review;
      writeOutput(target.dir, 'review.json', `${JSON.stringify(review, null, 2)}\n`);
      appendLedger(target.dir, 'review-gate', { [status]: d.decided.length, by: values.by, ...(values.note ? { note: values.note } : {}) });
      process.stdout.write(`review-gate: ${d.decided.length} item(s) ${status} by ${values.by}${d.decided.length <= 12 ? `: ${d.decided.join(', ')}` : ''}\n`);
    }

    const states = statusOf(items, review);
    if (fs.existsSync(path.join(target.dir, 'output', 'review.json'))) writeApproved(target, states);
    process.stdout.write(statusText(states));
    return summary(states).waiting.length ? 2 : 0;
  } catch (err) {
    process.stderr.write(`review-gate: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
