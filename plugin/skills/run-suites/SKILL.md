---
name: run-suites
description: >-
  Run a reverse-qa target's Playwright tiers in a fixed order (unit → selftest → smoke → full Chromium → Firefox, WebKit and phone), stopping when unit, selftest or smoke fails; after each step the test data the run created is recorded and cleaned up (rows above the seed, uploaded files, database reset) and the run is archived in output/runs/ with its reports, JUnit XML, HTML report, PHP log and failure traces. Also runs a single tier, the PHP upgrade copy, or the flake gate (--repeat-each=5). Use after scaffold-framework and whenever tests or the app change.
---

# run-suites

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-suites/run.mjs" --target <name>                     # all tiers
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-suites/run.mjs" --target <name> --tier smoke        # one tier
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-suites/run.mjs" --target <name> --upgrade           # same suite on the upgrade version
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-suites/run.mjs" --target <name> --flake-gate --grep "@TC-AUTH-00[1-4]"

Tiers: `all`, `unit`, `selftest`, `smoke`, `p1`, `full`, `browsers`, `visual`. `--dry-run` prints the commands. A desktop app built with Electron has `unit`, `selftest`, `smoke`, `p1` and `full`, all in its `desktop` project.
`--no-cleanup` leaves the test data in place to debug a failure (the run is still archived).

- Each step prints its exit code, time, outcome counts, what clean-up removed, and the archive folder. Report them.
- Exit 2: a step failed. Run `triage-failures` next; never heal a failure before it is triaged.
- A `known-defect` count is expected: those are `test.fail()` tests documenting confirmed findings.
- A skip is not a pass. After the counts, each step prints `skipped N: <reason>` per group (page names folded out).
  Report those lines with the counts: "26 passed, 0 failed" with 95 skipped means most of the suite never ran,
  usually because an input is missing (role-matrix.csv, a test account). Never call such a run green.

First run on a target, or after the role matrix changes: record the baselines once and review them, in
`targets/<name>/framework`: `A11Y_UPDATE=1 npx playwright test tests/a11y --project=chromium` (today's violations per
page, so a test fails only on new ones) and `npx playwright test --project=visual --update-snapshots` (reference
screenshots). Without them those tests fail and say which baseline is missing.

Watching tests run (for a person): in `targets/<name>/framework`, `npx playwright test --ui` (UI mode),
`SLOWMO=500 npx playwright test --headed --workers=1`, or `npx playwright test --debug=cli` to step through from the
terminal. `npx playwright show-report` opens the HTML report.

## Tools

Bash (node, npx).

## Data

- Reads: `targets/<name>/framework/` (installed), the running app.
- Writes: `framework/test-results/<step>.json`, `<step>-junit.xml`, `<step>-cleanup.json`, `framework/playwright-report/`,
  `output/runs/<stamp>-<step>/` (the permanent record), ledger lines.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **No skips, reasons printed.** 2026-11-10, Anton: runs reported "26 passed, 0 failed" while 95 tests were skipped, and that was read as green. **Rule:** no skipped tests in the templates; each step still prints `skipped N: <reason>` for anything a generated spec skips.
- **One output folder per run.** 2026-11-10, Anton: a Playwright UI-mode session and a run-suites step wrote traces to the same folder (ENOENT on trace files). **Rule:** the output folder is named after `RQA_REPORT`, one per run name.
- **Open pages as allowed role.** 2026-11-10, Anton: smoke opened guarded pages as a visitor and every one ended in a PHP fatal (the redirect without `exit`). **Rule:** functional tiers open each page as a role allowed to open it (`roleForPage`); what other roles get is the authorization tier.
- **Report not-run tests.** 2026-11-10, Anton: a run printed "skipped 10: no reason given" with no `test.skip` anywhere. Cause: the tests sat in a serial group after a failed test, so Playwright never started them. **Rule:** a skipped test with no skip annotation is reported as "not run: an earlier test in its serial group failed, or the run was stopped"; "no reason given" is only for a `test.skip()` without a reason.
- **Quote a grep the shell splits.** 2026-11-12, Anton: a flake gate for nine new tests could not be given one pattern: `--grep "Saved changes|TC-PAY-004"` reached the shell unquoted, where the space splits it and the `|` is a pipe. Cause: the command is built as one string and only plain tags had ever been used. **Rule:** a grep with anything but letters, digits and `@ : . / -` is put in double quotes (`shellSafe`, unit-tested); a plain tag is left as it was.
- **One project for desktop.** 2026-11-11, Anton: every tier ran in the `chromium` project, and "all" included other-browser and visual tiers a desktop app cannot have. **Rule:** for a desktop app the smoke, p1 and full tiers run in the `desktop` project, where each test starts the app itself, and there is no browsers or visual tier; the step's line says each test had a data folder of its own, instead of "not cleaned".
