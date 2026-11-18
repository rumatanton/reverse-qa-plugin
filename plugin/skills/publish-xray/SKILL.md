---
name: publish-xray
description: >-
  Publish a reverse-qa target's exported tests (or test results) to Xray Cloud in two steps: a dry run that validates and summarizes the exact payload and returns a preview_id, then, only after the person running reverse-qa confirms that summary, the real import of that same payload. Saves the created Xray test keys for traceability and results. Use when the person asks to push tests or results to Xray or Jira.
---

# publish-xray

Writing to a client's Jira is outward-facing and hard to undo, so this skill never publishes on its own.

## Prompt

1. Dry run (sends nothing):

       node "${CLAUDE_PLUGIN_ROOT}/skills/publish-xray/publish.mjs" --target <name>            # tests
       node "${CLAUDE_PLUGIN_ROOT}/skills/publish-xray/publish.mjs" --target <name> --results  # results

2. Show the person the whole dry-run line: how many tests by type, how many link to Jira requirements, which
   requirements have no Jira key, and the preview_id. Ask for an explicit yes. A yes to an earlier dry run does not
   count for a new one.
3. Only after that yes:

       node "${CLAUDE_PLUGIN_ROOT}/skills/publish-xray/publish.mjs" --target <name> --confirm <preview_id>

   The import refuses any payload whose preview_id differs from the one confirmed (for example, cases edited after
   the dry run). Run the dry run again and ask again.

- Exit 0: tests imported (created keys saved to `output/xray/xray-keys.json`), or results imported into a new Test
  Execution (its key is printed).
- Exit 2: refused (invalid payload, preview mismatch) or Xray rejected some tests (each error is listed by position).
- Exit 1: configuration problem (no export yet, no credentials).

Credentials: `XRAY_CLIENT_ID` and `XRAY_CLIENT_SECRET` (plus optional `XRAY_BASE_URL`) from the environment or the
target's gitignored `.env`. In a Claude Code session the plugin's Xray MCP server gets the same values from the
plugin settings. Never print or write them.

## Tools

Bash (node).

## Data

- Reads: `output/xray/xray-tests.json` or `xray-results.json`, `output/test-cases/cases.yaml`, `output/jira-keys.yaml`.
- Writes: `output/xray/publish-preview.json` / `publish-preview-results.json`, `output/xray/xray-keys.json`, ledger
  lines. In Xray: Test issues (tests) or one Test Execution (results).

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- None yet.
