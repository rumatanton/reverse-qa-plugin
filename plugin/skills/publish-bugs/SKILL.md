---
name: publish-bugs
description: >-
  Create Jira Bugs from a reverse-qa target's bug reports (output/bugs/bugs.json, written by the bug-reporter agent) in two steps: a dry run that validates every report (confirmed finding, reproduction steps, cited root cause, evidence files present, no credential values) and returns a preview_id, then, only after the person confirms, the creation of the bugs with their evidence attached and links to the requirement and the Xray test. Use when the person asks to file the bugs in Jira.
---

# publish-bugs

Creating issues in a client's Jira is outward-facing, so this skill never publishes on its own.

## Prompt

1. Dry run (sends nothing):

       node "${CLAUDE_PLUGIN_ROOT}/skills/publish-bugs/publish.mjs" --target <name>

2. Show the person the dry-run line and `output/bugs/bugs.json` (or the `BUG-*.md` files). Ask for an explicit yes.
3. Only after that yes:

       node "${CLAUDE_PLUGIN_ROOT}/skills/publish-bugs/publish.mjs" --target <name> --confirm <preview_id>

- Exit 0: each bug's Jira key, number of attachments and links are printed and saved to `output/bugs/jira-bug-keys.json`
  (bugs already created are skipped on a rerun).
- Exit 2: refused (a report breaks the schema, a finding is not confirmed, a credential value appears, or the bugs
  changed after the dry run). Exit 1: configuration (no bugs.json, no Jira settings or credentials).

Settings: `jira.base_url`, `jira.project_key` (or `jira.bug_project_key`), optional `jira.priority_map`
(`{P1: Highest, P2: High, P3: Medium}`) and `jira.link_type` in target.yaml. Credentials: `JIRA_EMAIL` and
`JIRA_API_TOKEN` (Jira Cloud) or `JIRA_PAT` (Data Center) from the environment or the target's gitignored `.env`.

## Tools

Bash (node).

## Data

- Reads: `output/bugs/bugs.json`, `output/findings.csv`, `output/jira-keys.yaml`, `output/xray/xray-keys.json`, the
  attachment files.
- Writes: `output/bugs/publish-preview.json`, `output/bugs/jira-bug-keys.json`, ledger lines. In Jira: Bug issues,
  attachments, issue links.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Dry run works without Jira.** 2026-11-10, Anton: the dry run could never pass on a machine with no Jira configured. **Rule:** a missing project key is a warning on the dry run and an error only for `--confirm`.
- **Demo password is not secret.** 2026-11-11, Anton: the first bug-reporter run on a real app wrote 11 reports and the dry run refused 7 of them as "contains a credential value from .env". Cause: the demo test account's password was the same word as its user name, a word that every report about that area of the app contains. check-citations already left such a value out; publish-bugs did not, because the exception lived in check-citations and not in the function both read. **Rule:** the exception is in `secretValues` (lib/bugs.mjs): a secret equal to a plain setting in the same .env is public and not counted. A real secret beside it is still refused (unit test).
