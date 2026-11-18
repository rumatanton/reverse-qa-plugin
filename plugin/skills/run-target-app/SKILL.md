---
name: run-target-app
description: >-
  Build and start a reverse-qa target's app and database in Docker from its compose file, seed the database from the dump, wait for the health page to answer, and start the PHP error log clean. Refuses any URL outside the target's allowed test hosts. Use at step 0 of /recon, before any test run, for the PHP 8 upgrade copy (--upgrade), or to stop everything (--down).
---

# run-target-app

## Prompt

Run one of:

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-target-app/run.mjs" --target <name>             # default version
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-target-app/run.mjs" --target <name> --upgrade   # second version (e.g. PHP 8)
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-target-app/run.mjs" --target <name> --down

Options: `--no-build` (reuse the last image), `--no-reset` (keep the current data), `--timeout <ms>` (health wait,
default 300000).

- Exit 0: it prints the service, URL, HTTP status and time to healthy, then the db-reset line. Report both lines.
- Exit 2: running, but the seeded row counts differ from the dump. Stop: no test result means anything on that data.
- Exit 1: refused (host not allowed) or failed (Docker not running, build error, never healthy). Report the message.

The app is never pointed at a public host: `safety.allowed_test_hosts` and `safety.never_test` in `target.yaml`
decide, and the script checks them before starting anything.

## Tools

Bash (node, docker).

## Data

- Reads: `targets/<name>/target.yaml` (`runtime`, `database`, `safety`), `targets/<name>/.env`, the compose file, the
  seed dump in the source (read only).
- Writes: containers and named volumes in the compose project; one line in `output/ledger.jsonl`.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **No bind mounts.** 2026-11-09, Anton: containers hung on start and Docker Desktop asked to approve every new folder. Cause: bind mounts under the Hyper-V engine. **Rule:** never bind-mount; copy files in (`docker create` + `docker cp`), use named volumes, and pipe the dump over stdin. A unit test fails if `-v`, `--mount` or a host-path compose volume comes back.
- **Restart, don't rebuild.** 2026-11-10, Anton: after a Docker Desktop restart the app containers had exited (code 255) and every test failed on connection. **Rule:** check `docker ps` first; restart with `--no-build` instead of rebuilding.
