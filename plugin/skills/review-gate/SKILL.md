---
name: review-gate
description: >-
  The human review gate of a reverse-qa target, one item at a time: a person approves or rejects each requirement (with its risk score) and each user story by name, and an approved item that is edited later counts as changed until someone looks again. Writes output/review.json and output/approved/ (what test-designer may use); export-xray refuses a test case for a requirement that is not approved. Deterministic, no model. Use at step R of the recon recipe, before any test case is written, and again whenever requirements or stories change.
---

# review-gate

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/review-gate/review.mjs" --target <name>
    node "${CLAUDE_PLUGIN_ROOT}/skills/review-gate/review.mjs" --target <name> --show REQ-AUTH-001
    node "${CLAUDE_PLUGIN_ROOT}/skills/review-gate/review.mjs" --target <name> --approve REQ-AUTH-001 REQ-AUTH-002 --by <Name>
    node "${CLAUDE_PLUGIN_ROOT}/skills/review-gate/review.mjs" --target <name> --reject REQ-PAY-004 --by <Name> --note "the gateway answer is not checked"

- With no decision it prints where every item stands: approved, pending (never reviewed), changed (decided, then
  edited: the fields that differ are named) or rejected. Exit 0 only when every item is approved; exit 2 otherwise.
- `--approve` and `--reject` take item ids, or the words `all`, `requirements`, `stories`. `--by` is the person's
  name and is required. A rejection needs `--note` with the reason.
- The decision belongs to the person. Never approve on their behalf: show them the items (`--show`, the docs, the
  stories page), and run `--approve` only with the ids and the name they gave. `all` is theirs to say.
- A correction is not made here. The person or the owning agent edits the requirement or the story; the item then
  shows as changed, and it is approved again once someone has looked. What the agent got wrong goes into that
  agent's memory section as a lesson.
- Once `output/review.json` exists, `export-xray` fails a test case written for a requirement that is not approved,
  and only approved requirements need a case.

## Tools

Bash (node).

## Data

- Reads: `output/requirements.yaml`, `output/risk-register.csv`, `output/stories.yaml`, `output/review.json`.
- Writes: `output/review.json` (each decision: status, who, when, the reason, a hash of the content it was made on),
  `output/approved/requirements.yaml` and `output/approved/stories.yaml` (the approved items, unchanged since), a
  ledger line per decision.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Approve one item at a time.** 2026-11-11, Anton: the review gate was all or nothing: a person approved the whole set of documents or none, nothing recorded who approved what, and the recipe named a log file nobody wrote. Cause: the gate was a paragraph in the recipe, with no script behind it. **Rule:** every requirement and every story is approved or rejected by name; an edit after the decision shows as changed with the fields that differ; test cases are written only for approved requirements (`export-xray` checks it).
