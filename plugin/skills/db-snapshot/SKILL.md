---
name: db-snapshot
description: >-
  Record a reverse-qa target's whole database (exact row counts plus rows, ordered by primary key) under a label, and diff two snapshots to show exactly which rows a workflow added, removed or changed. Use before and after each write flow in phase 2 (the evidence for 04-workflows.md), and in T5 characterization tests.
---

# db-snapshot

## Prompt

Take a snapshot, run the flow, take another, then diff:

    node "${CLAUDE_PLUGIN_ROOT}/skills/db-snapshot/snapshot.mjs" --target <name> --label before-purchase
    ... run the flow (Playwright, or by hand in the browser) ...
    node "${CLAUDE_PLUGIN_ROOT}/skills/db-snapshot/snapshot.mjs" --target <name> --label after-purchase
    node "${CLAUDE_PLUGIN_ROOT}/skills/db-snapshot/snapshot.mjs" --target <name> --diff before-purchase after-purchase

- The diff prints one line, e.g. `db-snapshot: before-purchase → after-purchase: payments +1, cart -1, temp_payments
  +1 -1`, and writes `snapshots/<a>__<b>.diff.json` and `.diff.md`. Cite the `.diff.md` in workflow documents.
- Labels are letters, digits, dot, dash and underscore only.
- Tables over `--max-rows` (default 5000) keep exact counts, but their rows are cut off and the diff marks them
  `partial`.

## Tools

Bash (node, docker).

## Data

- Reads: the target database (through the db container).
- Writes: `targets/<name>/output/snapshots/<label>.json`, `<a>__<b>.diff.json`, `<a>__<b>.diff.md`, ledger lines.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **One socket per request.** 2026-11-10, Anton: the mini-shop integration test failed 4 of 7 with "other side closed" (UND_ERR_SOCKET) on the login right after a snapshot. Cause: the snapshot runs docker synchronously and blocked Node for about 6 s, longer than Apache's 5 s keep-alive; the server closed the idle connection, Node could not retire it while blocked, and the next request went out on it. Reproduced: 3 s block passes, 6 s fails, 6 s with `connection: close` passes. `connection: close` on fetch was still not enough in a full run (9 s block: the pool handed out the closed socket again). **Rule:** an HTTP client used around the db, snapshot or docker helpers sends each request on its own socket (node:http with `agent: false`), never through a pool.
