---
name: check-citations
description: >-
  Verify that every citation in a target's recon documents (output/docs/*.md, output/requirements.yaml) exists in the target source, within 2 lines of the cited line. Deterministic, no model. Runs automatically from the PostToolUse hook; use it on demand before the review gate or after editing docs.
---

# check-citations

## Prompt

Run:

    node "${CLAUDE_PLUGIN_ROOT}/skills/check-citations/check.mjs" --target <name>

- Exit 0: every citation resolves. Report the count it prints.
- Exit 2: it prints one line per failing citation with the reason (file not found, line out of range, quote not
  found within 2 lines, quote length, path outside the source, malformed marker, requirement without evidence).
  Fix the document: correct the citation or remove the claim. Never edit or weaken the checker.
- Exit 1: usage or configuration problem (unknown target, `TARGET_DIR` not set). Fix the setup, then re-run.
- `docs/08-test-types.md` is also checked against `skills/recon/test-types.yaml`: a type marked `have` that the tool
  does not run on this app's driver, a proposed type with no citation or no tool, or a listed type with no row fails.

Citation format and rules: `${CLAUDE_PLUGIN_ROOT}/skills/recon/conventions.md`.

## Tools

Bash (node).

## Data

- Reads: `targets/<name>/target.yaml`, `targets/<name>/.env`, `targets/<name>/output/docs/*.md`,
  `targets/<name>/output/requirements.yaml`, the target source (read only).
- Writes: nothing.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Private data check.** 2026-11-10, Anton: the tech-analyst quoted a real customer email from the app's seed dump and the seeded admin password in 01-architecture.md and 02-security.md; a person caught it in review. **Rule:** the check also fails any document, findings.csv or BUG-*.md line that holds an email from the seed dump or a secret from .env (it names the line, never the value). A demo password equal to its user name is public and not counted, or every `admin/` path would match.
