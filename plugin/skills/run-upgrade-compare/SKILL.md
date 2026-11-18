---
name: run-upgrade-compare
description: >-
  Compare a reverse-qa target on its current runtime and on the upgrade runtime (for example PHP 7.2 vs 8.2): run the same Playwright suite on both, then diff test by test (same, different with the first error, only on one side) and compare the PHP log (warnings, deprecations, fatals). Writes output/upgrade/upgrade-diff.json and .md. Use to answer "what breaks if we upgrade?".
---

# run-upgrade-compare

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-target-app/run.mjs" --target <name> --upgrade --no-reset   # the upgrade copy must be up
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-upgrade-compare/compare.mjs" --target <name> --run

`--run` runs `run-suites --tier full` on both versions first. Without it, the script compares the reports already in
`framework/test-results/` (`report.json`, `upgrade-report.json`).

- Prints the counts and the PHP log change. Report them, then list every test in `different` with its first error.
- A difference is a result, not a failure of this skill: each one is a candidate upgrade issue to triage.

## Tools

Bash (node, npx).

## Data

- Reads: `framework/test-results/report.json`, `upgrade-report.json`, and both runs' `-cleanup.json` (PHP logs).
- Writes: `output/upgrade/upgrade-diff.json`, `upgrade-diff.md`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **First real error line.** 2026-11-10, Anton: the comparison showed the log watcher's header line as the "first error". **Rule:** take the first real error line (`firstError`).
