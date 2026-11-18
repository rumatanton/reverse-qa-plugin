---
name: db-reset
description: >-
  Reset a reverse-qa target's database to its seed dump: drop and re-create the database, import the dump through the db container, then prove every table's row count equals the dump's. Use before each test suite, after a flow that changed data, or whenever results must start from a known state.
---

# db-reset

## Prompt

Run:

    node "${CLAUDE_PLUGIN_ROOT}/skills/db-reset/reset.mjs" --target <name>

- Exit 0: `db-reset: <db>: N tables, M rows imported in S s; every table's row count matches the dump`.
- Exit 2: the import ran but counts differ (it lists each table with expected and actual). Report it. Do not run
  tests on that data.
- Exit 1: configuration or Docker problem (no `seed_dump`, no `database.name`, db service not running).

The expected counts come from parsing the dump itself (`lib/sqldump.mjs`), not from a stored number, so the check
stays right if the dump changes.

## Tools

Bash (node, docker).

## Data

- Reads: `target.yaml` (`source.seed_dump`, `database`), the dump file(s) in the source (read only).
- Writes: the target database (local container only); one line in `output/ledger.jsonl`.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Dump over stdin.** 2026-11-09, Anton: the dump import hung on a file-sharing prompt. Cause: the dump was bind-mounted. **Rule:** pipe it to `mysql` over stdin.
