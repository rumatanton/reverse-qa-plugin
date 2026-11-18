---
name: run-perf
description: >-
  Run k6 performance tests on a reverse-qa target's key pages (smoke: 1 user; load: ramp to N users) with p95 and error-rate thresholds per page and overall, while the MariaDB slow query log records every statement over the limit; writes output/perf/perf-summary.json and .md. A laptop baseline, not a capacity figure. Use after functional tests pass, and in the nightly run.
---

# run-perf

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/run-perf/perf.mjs" --target <name> --scenario smoke
    node "${CLAUDE_PLUGIN_ROOT}/skills/run-perf/perf.mjs" --target <name> --scenario load --vus 10 --duration 2m

- Prints, per scenario: requests, pages, p95, error rate, thresholds met or the ones that failed; then the number of
  slow statements. Report the lines. Always call the numbers a baseline from one machine.
- Exit 2: a threshold failed. Look at `perf-summary.md` (per-page p95, slowest SQL) before blaming the app.
- Pages come from `perf.pages` in target.yaml, or else up to 6 public pages from the inventory. A page listed in
  `page_params` is requested with that query (`books.php?id=1`), the way a user arrives on it. Thresholds come from
  `perf.thresholds` (defaults p95 800 ms, errors under 1%).

The k6 script is `templates/perf/k6-pages.js`. Grafana's k6 agent skills, installed in the framework by
scaffold-framework, help write extra scenarios (k6-test-planner, k6-load-test, k6-playwright-converter from copies of
the Playwright journeys).

## Tools

Bash (node, k6, docker).

## Data

- Reads: `target.yaml` (`runtime.base_url`, `perf`), `output/inventory.json`.
- Writes: `output/perf/k6-<scenario>.json`, `output/perf/perf-summary.json`, `perf-summary.md`, a ledger line. Turns the
  database slow query log on (local container only).

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Load pages with their parameters.** 2026-11-11, Anton: the workflow-analyst, writing the performance requirements for a real app, found that the k6 number for the category page timed it with no category id, its error path, not the page a visitor sees. Cause: run-perf requested each page bare, while the page tests already opened it with target.yaml `page_params`. **Rule:** run-perf requests a page with its `page_params` query (`pageUrls`, unit-tested); the result is still reported under the page's name.
- **Merge scenario results.** 2026-11-10, Anton: after a smoke run and then a load run, the dashboard showed only the load result. Cause: each run rewrote perf-summary.json with its own scenarios. **Rule:** a run replaces only the scenarios it ran and keeps the latest result of the others (`mergeScenarios`, unit-tested).
