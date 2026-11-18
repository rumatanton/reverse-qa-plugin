---
name: triage-failures
description: >-
  Root-cause triage of a reverse-qa test run: label every failing Playwright test environment (app or browser unreachable), app (PHP fatal or uncaught error in the test's time window, or an HTTP 5xx), test (locator or element-state problem, script error), needs-review (an assertion mismatch with no server evidence: a person decides) or app-changed (a documented test.fail() defect that now passes), quoting the line that decided it, plus flaky tests. Deterministic, no model. Use after every run-suites that has failures, before the healer or any finding is written.
---

# triage-failures

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/triage-failures/triage.mjs" --target <name> [--report <playwright-report.json>] [--php-log <file>] [--confirm-findings]

Without `--php-log` it reads the PHP error log from the running app container.

`--confirm-findings` marks a finding `confirmed` (and fills `test_id`) when a `test.fail()` test tagged with its ID
failed as expected in this run, at the assertion whose message starts with the ID (`expect(x, 'F-009: ...')`). A
known-defect test that failed anywhere else is printed as "not confirmed" with its first error line. Nothing else
confirms a finding: not a scanner hit, not a code reading, not a red test.

Then act on each category, in this order:

1. `environment`: fix the environment and rerun. These failures are not results.
2. `test`: send only these to the Playwright healer (at most 3 rounds), then rerun with `--repeat-each=5`.
3. `app`: write or update the finding in `output/findings.csv` with its root cause (conventions.md). The test becomes
   `test.fail()` with the finding ID in its title only after a person confirms the finding.
4. `needs-review`: show the person the evidence. They decide whether it is a product bug or a wrong expectation.
5. `app-changed`: the documented defect may be fixed. Confirm, then remove `test.fail()` and close the finding.

Never let the healer touch an `app` or `needs-review` test: healing would hide a product bug.

## Tools

Bash (node, docker).

## Data

- Reads: the Playwright JSON report, the PHP error log (container or file).
- Writes: `output/triage.json`, `output/triage.md`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Read the archived log.** 2026-11-10, Anton: failures were labelled needs-review because the clean-up had already emptied the live PHP log. **Rule:** read the newest archived `php-error.log` in `output/runs/`, and treat the log watcher's "PHP Fatal error" message in a test error as app evidence.
- **Only tests confirm findings.** 2026-11-10, Anton: the tech-analyst marked F-015 "confirmed" with no test behind it. **Rule:** only `--confirm-findings` sets `confirmed`, from a known-defect test tagged with the finding ID; the bug-reporter then writes bugs for exactly those findings.
- **Finding ID in the assertion.** 2026-11-10, Anton: writing the access-control tests showed that a `test.fail()` test passes on any failure, so a precondition that broke (a 200 where a 302 was expected, a missing session, a PHP-log fatal) would have "confirmed" the finding and sent a bug to Jira. **Rule:** the deciding assertion's message starts with the finding ID, and `--confirm-findings` confirms only when the recorded error contains `F-NNN:`; anything else is listed as not confirmed. The templates' API and authz tests and a unit test follow it.
