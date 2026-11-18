---
name: build-rtm
description: >-
  Build a reverse-qa target's requirements traceability matrix: user story → risk score and priority → requirement → test case → automated Playwright specs → last result → Xray test key → findings, one row per requirement and case, plus orphans in both directions (requirements without cases, cases without requirements, spec tags naming unknown cases, cases not yet automated). Deterministic, no model. Use after a test run and before build-report or a Jira/Xray publish.
---

# build-rtm

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/build-rtm/rtm.mjs" --target <name> [--report <playwright-report.json>] [--strict]

- Prints the row count and the orphan counts. Report them. `output/rtm-orphans.json` lists each orphan by id.
- `--strict` (CI): exit 2 when a requirement has no case, a case has no requirement, a spec names an unknown case, or
  a case's `covers` selector matched no result that ran (`covers_matching_nothing` in the orphans file).
- A result reaches a case by its `@TC-…` tag or by the case's `covers` selectors: page-and-role tiers, other
  browsers, the visual run and k6 (`k6:<scenario>`). `automated_by` names the first three results and counts the rest.
  Cases not automated yet are reported but do not fail it.
- `last_result` is the worst outcome across all runs of the case: failed > fixed-defect > known-defect > flaky > passed.

## Tools

Bash (node).

## Data

- Reads: `output/requirements.yaml`, `output/stories.yaml` (if present), `output/test-cases/cases.yaml`, `output/risk-register.csv`, `output/findings.csv`,
  `output/xray/xray-keys.json`, the Playwright JSON report.
- Writes: `output/rtm.csv`, `output/rtm-orphans.json`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Cases name untagged results.** 2026-11-11, Anton: on the first real app no result could reach a requirement: the template tiers make one test per page and role with no case id in the title, the other browsers and the visual run write their own reports, and k6 is not a Playwright test at all. Cause: the matrix linked a result to a case only by an `@TC` tag in the test's title. **Rule:** a case may name its results with `covers` (tags, `project:<browser>`, `k6:<scenario>`); every result file is read; a selector that matched no result that ran is listed as an orphan and fails `--strict`, so a wrong selector never reads as coverage.
