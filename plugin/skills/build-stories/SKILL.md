---
name: build-stories
description: >-
  Turn a reverse-qa target's requirements into user stories: groups requirements.yaml by area, feature (risk register), role and kind, sets each story's priority from risk-register.csv, links findings, and writes stories.yaml, docs/07-user-stories.md and a Jira-ready JSON that is never sent. "keep" stories protect today's behaviour; "fix" stories hold the intended rule and list the as-is behaviour they replace. Deterministic; the workflow-analyst's stories mode words the story line and acceptance criteria, and --check re-derives everything else. Use after phase 2 (requirements written) and before the review gate, or when requirements change.
---

# build-stories

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/build-stories/stories.mjs" --target <name>            # build or refresh, then check
    node "${CLAUDE_PLUGIN_ROOT}/skills/build-stories/stories.mjs" --target <name> --check    # check only

- Build prints the story count, then every problem and every review item. Exit 0 = no problems, 2 = problems, 1 = error.
- A rebuild keeps story ids, and keeps the agent's final wording for a story whose requirements did not change; a
  story whose requirements changed goes back to draft wording (the count is printed).
- Then run the workflow-analyst in stories mode to word the drafts (see `agents/workflow-analyst.md`), and run
  `--check` until it exits 0.
- Report the review items to the person at the review gate. They are not failures: they are questions only a person
  can answer (is this as-is behaviour really to be kept? is this intended rule backed by a defect?).

## What the code owns

- Grouping: one story per area + feature (risk-register.csv `feature`) + role + kind.
- Kind: an `intended` requirement leads a **fix** story; the as-is requirement it pairs with ("Pairs with REQ-…" in its
  notes) goes into the same story under `replaces` (today's broken side, never an acceptance criterion). Every other
  as-is requirement goes into a **keep** story.
- Priority: the highest risk-register priority of the story's requirements.
- Findings: findings whose `req_id` is one of the story's requirements or their pairs, plus F-ids named in those
  requirements' notes; rejected findings never count.
- `--check` re-derives all of the above and fails on any difference, so the wording step cannot change structure.
  It also checks the story line ("As a <role>, I want <goal>, so that <benefit>"), one acceptance criterion or more per
  requirement, criteria only for the story's own requirements, and no seed data or .env secret in the file.

## Tools

Bash (node).

## Data

- Reads: `output/requirements.yaml`, `output/risk-register.csv`, `output/findings.csv`, `output/stories.yaml` (if any,
  for ids and final wording), the target's seed dump and `.env` (only to reject private values).
- Writes: `output/stories.yaml`, `output/docs/07-user-stories.md`, `output/stories/jira-stories.json`,
  `output/stories/review.md`, a ledger line.
- Nothing is sent to Jira. `jira-stories.json` is for a later import after a dry run the person confirms.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Fix story replaces as-is.** 2026-11-10, Anton: the first version grouped every as-is requirement into a story that said "keep working as it does today", so the password story asked to protect REQ-AUTH-017 (passwords stored as typed, F-003). Cause: as-is requirements describe today, broken parts included. **Rule:** an as-is requirement paired with an intended rule goes into that rule's fix story under `replaces`, never into a keep story and never as a criterion; an as-is requirement that names a finding but has no intended rule stays in a keep story and is listed for the review gate, because only a person can say whether it is behaviour to keep.
