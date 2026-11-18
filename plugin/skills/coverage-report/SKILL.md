---
name: coverage-report
description: >-
  Measure a reverse-qa target's test coverage from evidence, never from claims: pages and role-matrix cells exercised by executed tests (@page:/@role: tags), requirements with a designed test case, requirements automated and run (@TC- tags), and P1 requirements automated; every gap is named. With --gate it fails below 100% or when an input is missing (the CI quality gate). Deterministic, no model. Use after each test run and before build-report.
---

# coverage-report

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/coverage-report/coverage.mjs" --target <name> [--report <playwright-report.json>] [--gate]

- Prints one line with five measures (covered/total and %). Report it, then list the gaps from `output/coverage.json`.
- A measure whose input is missing prints `not measured`. Say so; never report it as covered.
- `--gate`: exit 2 unless every measure exists and is at 100%. CI uses this.

How tests are counted: a test exercises a page when its title or tags carry `@page:<path>`, a role-matrix cell when
it also carries `@role:<Role>`, a test case when it carries `@TC-<AREA>-<NNN>` or when the case names it with
`covers` (conventions.md): that is how the tiers that make one test per page and role, the other-browser run, the
visual run and k6 reach a case. Those last three live outside the main report (`browsers.json`, `visual.json`,
`output/perf/perf-summary.json`) and count for cases only, never for pages or cells. Skipped tests count for nothing.

## Tools

Bash (node).

## Data

- Reads: `output/inventory.json`, `output/role-matrix.csv`, `output/requirements.yaml`, `output/test-cases/cases.yaml`,
  `output/risk-register.csv`, the Playwright JSON report (default `framework/test-results/report.json`).
- Writes: `output/coverage.json`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- None yet.
