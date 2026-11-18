---
name: build-report
description: >-
  Build a reverse-qa target's one-page report (output/report.html) from its output files only: what the app is, coverage with gaps, test results by tier, findings by severity with root causes, failure triage, performance baseline, security scans, the PHP upgrade comparison, and the ledger of steps that produced it. Sections without data say "not run yet". Deterministic, no model. Use as the last step of a run, and before handing results to anyone.
---

# build-report

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/build-report/report.mjs" --target <name> [--report <playwright-report.json>]

- Prints the file path and which of the 8 sections had data. Report both. Never hand-edit report.html: fix the source
  file and rebuild.
- Run coverage-report, build-rtm and triage-failures first, so their sections are current.

## Tools

Bash (node).

## Data

- Reads: `output/inventory.json`, `coverage.json`, `findings.csv`, `rtm.csv`, `triage.json`,
  `perf/perf-summary.json`, `security/summary.json`, `upgrade/upgrade-diff.json`, `ledger.jsonl`, the Playwright JSON
  report.
- Writes: `output/report.html`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Create results folder first.** 2026-11-10, Anton: `npm run test:report` failed with ENOENT because the JUnit folder did not exist. **Rule:** the script creates `test-results/` first; the report reads the plugin's counts from `plugin/test-results/junit.xml`.
- **Decode names twice.** 2026-11-10, Anton: four test names on the dashboard showed a literal `&quot;`. Cause: node:test's JUnit reporter escapes a quote in a test name twice (`&amp;quot;`), and the names were decoded once. **Rule:** names and messages from that file are decoded twice; a unit test holds a doubly escaped name.
