---
name: run-mutation
description: >-
  Check whether a reverse-qa target's passing tests test the right thing: put one small defect at a time into the running copy of the app (a session check turned around, an UPDATE or DELETE that changes nothing), run the tests of the pages that file belongs to, and report which defects no test noticed. The source is never edited; the defect goes into the app container and the original file is put back and verified after each one. Writes output/mutation/mutation.json and .md. Deterministic, no model. Use after the full tier is green, before trusting a green suite, and when tests are added for a survivor.
---

# run-mutation

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-mutation/mutate.mjs" --target <name> --dry-run
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-mutation/mutate.mjs" --target <name> [--only guards|writes] [--max <n>] [--gate]

- `--dry-run` lists every mutant (file, line, the line before and after) and changes nothing. Read it first.
- A run prints one line per mutant: killed (a test changed its result, and which), survived (tests ran and every one
  gave the result it gave without the defect), no test (no test is tagged with a page the file belongs to), or not
  applicable (no pattern fits the line). Then the totals, the score, and whether every file was put back. Report them.
- A survivor is one of two things, and the report cannot tell them apart alone. Usually it is a behaviour the suite
  does not check: a test to write. Sometimes the changed line already had no effect, so nothing could notice: that
  is a defect in the app, and often one already found. The report names the findings that cite a line within three
  of the changed one (`Findings citing this spot`); read the survivor against them before calling it a missing test.
- It needs the last full run as its baseline (`run-suites --tier full` first): a test's result with the mutant is
  compared with its result without. A test that already failed in the baseline proves nothing and is left out.
- One mutant at a time, and never together with another test run: every run resets the same database.
- Exit 1 with "is not the source's copy": the app container was changed by something else. Restart the app from its
  image (`run-target-app`) and run again. Exit 1 after "every file put back: NO" means the same: restart the app.
- Mutants come from the inventory: one per session guard, one per UPDATE or DELETE. The patterns are for PHP session
  checks and SQL in strings; an INSERT is not mutated. Other stacks get "not applicable" until a pattern is added.

## Tools

Bash (node, docker).

## Data

- Reads: `target.yaml` (`runtime.compose_file`, `runtime.app_root`, `runtime.services.app`), `output/inventory.json`,
  the target source (read only), `framework/test-results/report.json` (the baseline).
- Writes: `output/mutation/mutation.json`, `output/mutation/mutation.md`, a ledger line. Inside the app container:
  one file at a time, restored and compared with the source's hash after each mutant.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **A survivor may be dead code.** 2026-11-11, Anton: on the first run on a real app 17 of 52 mutants survived, and two of them were not missing tests: with the session check on admin/index.php and admin/transaction.php turned around, a visitor got the same page, byte for byte (8,443 and 22,220 bytes), because those guards already do nothing (F-008: the page is sent before the check). Cause: the report had one word for two different things. **Rule:** a survivor lists the findings that cite a line within three of it; read it against them first. A guard a finding says is bypassed is that finding seen again; the rest are tests to write (here, 12 of the 17 were edits and deletes nobody checks afterwards).
- **Ask what a green test checks.** 2026-11-11, Anton: nothing looked at a passing test: the healer repairs failing tests only, and a suite could be green while checking the wrong thing. Cause: every check in the tool asked whether a test failed, none asked whether it could. **Rule:** after a green full tier, put one defect at a time into the running copy of the app and count the ones no test notices; each survivor is a test to write. The source is never edited, and each file is put back and its hash checked before the next mutant.
