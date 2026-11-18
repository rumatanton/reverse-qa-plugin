---
name: security-second-opinion
description: >-
  Get an independent security review of a reverse-qa target from Claude Code's built-in /security-review, run on a scratch git copy where the whole app is one pending change, then deterministically match it against the tech-analyst's findings and the scanner results: corroborated (both cite the same place), single-source, or flagged only by the review. Use at step 1.3 of /recon, after 02-security.md and findings.csv exist.
---

# security-second-opinion

## Prompt

1. `node "${CLAUDE_PLUGIN_ROOT}/skills/security-second-opinion/second.mjs" --target <name> --prepare`
2. `node "${CLAUDE_PLUGIN_ROOT}/skills/security-second-opinion/second.mjs" --target <name> --review`
   (headless `claude -p /security-review` in the scratch copy; uses model tokens). If it cannot run headless, it
   prints how to run `/security-review` by hand in that folder and where to save the answer.
3. `node "${CLAUDE_PLUGIN_ROOT}/skills/security-second-opinion/second.mjs" --target <name> --match`

- Report the match line: corroborated, single-source, review-only.
- Update `findings.csv` `sources` and `status` from `output/security/second-opinion.json`: a corroborated finding adds
  `security-review` to its sources; a review-only location becomes a lead for tech-analyst, not a finding.

## Tools

Bash (node, git, claude).

## Data

- Reads: the target source (copied to a temp folder), `output/findings.csv`, `output/security/results/*.json`.
- Writes: the scratch repo in the system temp folder, `output/security/second-opinion.md`, `second-opinion.json`, a
  ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- None yet.
