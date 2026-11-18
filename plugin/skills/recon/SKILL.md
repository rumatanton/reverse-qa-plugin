---
name: recon
description: >-
  Reverse-engineer a target app and build its requirements and tests. Runs the recon recipe (inventory, technology and security analysis, roles and workflows, human review gate, test design, execution, reports) for one target defined in targets/<name>/target.yaml. Triggers: "/reverse-qa:recon <target>", "reverse engineer <app>", "run recon on <app>".
argument-hint: "<target-name>"
---

# recon

## Prompt

1. Resolve the target: read `targets/$ARGUMENTS/target.yaml` from the project root. If it is missing, stop and say which file was expected.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/recon/conventions.md` (citation format, labels, requirement schema). Every agent and skill follows it.
3. Follow `${CLAUDE_PLUGIN_ROOT}/skills/recon/workflow.md` step by step, in order. Do not skip a step and do not reorder steps. If a step fails, stop and report the step, the command and its output.
4. Every script step appends its own line to `targets/<name>/output/ledger.jsonl`. After each agent step, append one line yourself (step, agent, outputs, check results).
5. At the review gate, print the requirements summary and wait for the person running the tool. In a headless run (`claude -p`), stop at the gate.

Rerun every check on a target that has been through recon (no model calls): plugin tests, every Playwright tier,
the PHP upgrade copy, security scans, k6 smoke and load, triage with finding confirmation, coverage and the dashboard
data. A failing step is recorded and the rest still run.

    node "${CLAUDE_PLUGIN_ROOT}/skills/recon/rerun.mjs" --target <name>      # --dry-run lists the steps

Then, if triage confirmed new findings, run the bug-reporter agent and the publish-bugs dry run (workflow.md 4.4–4.5).

## Tools

Read, Write, Edit, Grep, Glob, Bash (node, npm, npx, docker, k6, git), Agent.

## Data

- Reads: `targets/<name>/target.yaml`, the target source at the path in `target.yaml` (`source.dir_env`), read only.
- Writes: `targets/<name>/output/` and `targets/<name>/framework/` only. Never the target source (a hook enforces this).

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Resume after usage limit.** 2026-11-10, Anton: the test-designer behavior run "failed"; its result was the account usage limit, not an agent defect. **Rule:** a headless agent run that ends on a usage limit is an environment failure. The behavior test says so and resumes with `RQA_BEHAVIOR_RESUME=1` instead of rerunning finished agents.
