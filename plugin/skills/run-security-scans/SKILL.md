---
name: run-security-scans
description: >-
  Run Semgrep (PHP and secrets rules), Psalm taint analysis and an OWASP ZAP passive baseline against a reverse-qa target's local copy, all in Docker (source copied in, never mounted; ZAP scans the app service inside the target's own network), normalize every result to one finding shape, and compare with a recorded baseline so only new findings fail CI. Use in phase 3, in CI (Semgrep + Psalm) and nightly (ZAP).
---

# run-security-scans

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-security-scans/security.mjs" --target <name>                 # all three
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-security-scans/security.mjs" --target <name> --tools semgrep,psalm
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-security-scans/security.mjs" --target <name> --update-baseline

- Prints one line per tool: findings by severity, new vs baseline, time. Report the lines.
- Exit 2: new findings against the baseline (the CI gate). Exit 1: a scanner could not run (the message says why).
- Scanner findings are leads. tech-analyst triages them into `findings.csv` with root causes, and a finding is only
  `confirmed` when a test reproduces it. Write findings as risk plus evidence, never as exploitation steps.
- `--update-baseline` only after a person has reviewed the current findings.

Images are pinned by digest in `security.mjs` (Semgrep 1.183.0, ZAP stable, the rules-php image for Psalm 6.20.10).

## Tools

Bash (node, docker).

## Data

- Reads: the target source (copied), `target.yaml` (`runtime`, compose file name).
- Writes: `output/security/raw/<tool>.json`, `results/<tool>.json` (normalized, with `new`), `summary.json` (read by
  build-report), `baseline.json` (with --update-baseline), a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Test plants its own case.** 2026-11-10, Anton: the Psalm contract test expected an SQL injection in the mini-shop fixture, which has none. **Rule:** a scanner contract test plants its own one-file case with a known answer instead of assuming the fixture has the defect.
- **Fingerprint by tool and rule.** 2026-11-10, Anton: a rerun showed 11 of 21 ZAP alerts as new although every alert type was in the baseline. Cause: the fingerprint included the affected-URL list, which ZAP samples differently each run (books.php?id=3, then ?id=9). **Rule:** URL findings are identified by tool and rule; code findings by tool, rule, file and line. Old baselines still match.
