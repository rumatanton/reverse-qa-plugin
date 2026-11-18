---
name: export-xray
description: >-
  Render a reverse-qa target's canonical test cases (output/test-cases/cases.yaml) into everything Xray and Jira read, offline: the Xray Cloud bulk-import JSON (Manual steps, Cucumber Gherkin, requirement links), Gherkin .feature files with traceability tags, and the Xray Test Case Importer CSV; or, with --results, a Playwright JSON report into Xray JSON execution results. Validates the schema and that every requirement has a case. Deterministic, no model. Use after test-designer, and after each test run.
---

# export-xray

## Prompt

Test cases:

    node "${CLAUDE_PLUGIN_ROOT}/skills/export-xray/export.mjs" --target <name>

Results of a run (after `run-suites`, which writes the Playwright JSON report):

    node "${CLAUDE_PLUGIN_ROOT}/skills/export-xray/export.mjs" --target <name> --results targets/<name>/framework/test-results/report.json

- Exit 0: it prints the counts (cases by type, tests linked to Jira requirements, feature files, CSV rows, requirements
  still without a Jira key). Report the line.
- Exit 2: it lists each problem: a schema break in cases.yaml, a requirement in requirements.yaml with no case, or a
  rendered payload that breaks Xray's format. test-designer fixes cases.yaml. Never edit the rendered files by hand.
- Once a person has started the review gate (`output/review.json`), a case written for a requirement that is not
  approved is a problem too, and only approved requirements need a case (`review-gate`).
- A case's `covers` selectors are checked word by word. With `--results`, a result a case selects through `covers`
  goes to that case's Xray test; k6 results are not in a Playwright report and are not sent.
- Exit 1: usage or configuration (no cases.yaml yet, unknown target).

Without a Jira project key (`xray.project_key` in target.yaml, or `XRAY_PROJECT_KEY`), the features and CSV are still
written and the bulk JSON is skipped. Nothing here talks to Jira or Xray: publishing is `publish-xray`.

## Tools

Bash (node).

## Data

- Reads: `output/test-cases/cases.yaml`, `output/requirements.yaml`, `output/jira-keys.yaml`, `output/xray/xray-keys.json`,
  `target.yaml` (`xray`), a Playwright JSON report (with --results).
- Writes: `output/xray/xray-tests.json`, `output/xray/xray-import.csv`, `output/test-cases/features/*.feature`,
  `output/xray/xray-results.json` (with --results), ledger lines.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- None yet.
