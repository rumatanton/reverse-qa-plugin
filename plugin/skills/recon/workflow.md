# recon — the recipe

A fixed, ordered sequence. `[DET]` = deterministic script, no model call. `[AGENT]` = a subagent that earns a model call.
`[VENDOR]` = a Playwright test agent. `[HUMAN]` = a person decides. Skills live in `${CLAUDE_PLUGIN_ROOT}/skills/`,
agents in `${CLAUDE_PLUGIN_ROOT}/agents/`. All paths below are relative to `targets/<name>/`.

## Before step 0 — a new app

N [DET] `init-target` (once per app): says what the app is (stack; web, API, mobile or desktop), writes `target.yaml`
  and `.env`, and `--doctor` checks the prerequisites. A person fills the TODO lines (test accounts, production hosts).

What the target's kind and settings switch on, so no step is run where it cannot apply:

- No dedicated rule pack for the stack (anything but PHP today): the generic pack reads the source, and pages come
  from `crawl-app` (web) and `api.openapi` (API). Steps 0.2 and 0.3 below.
- `app.kind: api`: no browser. No crawl, no planner, generator or healer; `scaffold-framework` and `run-suites` use the
  HTTP tiers only.
- `app.kind: desktop` with `app.driver: electron` (a desktop app built with Electron): the app itself is started and
  driven through its own windows. `crawl-app` and the smoke, accessibility and journey tiers run; there is no HTTP
  tier, no visual tier and no other-browser tier.
- `app.kind: mobile`, or a desktop app not built with Electron: stop after phase 3.2 (test cases). The Appium driver is
  not built (`templates/DRIVERS.md`).
- No `runtime.compose_file`: the app is reached by URL and is already running, so skip 0.1, and there is no database
  reset, snapshot or server log watch. No `database`: skip 2.2 and every data check.

## Step 0 — Inventory

0.1 [DET] `run-target-app` (targets with `runtime.compose_file`): build and start the app from a copy of the source,
    seed the database (row counts proven against the dump), wait for health. `--upgrade` starts the second runtime
    for the upgrade comparison.
0.2 [DET] Web targets read by the generic pack: `scaffold-framework`, then `crawl-app` → `output/scan/crawl.json`
    (pages, forms, what each role gets) and `output/scan/observed-matrix.csv`. API targets whose spec is a URL:
    `scan-repo --fetch-openapi` saves it.
0.3 [DET] `scan-repo`: `output/inventory.json` (source facts merged with the spec and the crawl; route hints that
    matched no page are listed), `output/crud-matrix.csv`, `output/er.mmd`.

## Phase 1 — Technology and security

1.1 [AGENT] `tech-analyst`: `output/docs/01-architecture.md` (incl. integration patterns), `output/docs/02-security.md`,
    draft `output/docs/05-endpoint-catalog.md`, `output/findings.csv` (with root causes), and
    `output/docs/08-test-types.md`: the test types this app needs, which of them the tool runs, which it does not, and
    types it proposes for a technology the catalogue (`skills/recon/test-types.yaml`) has not met.
1.2 [DET] `check-citations` (also fires from the PostToolUse hook): every citation must resolve, and 08-test-types.md
    must agree with the catalogue. At most 3 rounds.
1.3 [DET] `run-security-scans`: Semgrep, Psalm taint, ZAP baseline; tech-analyst triages them into findings.
1.4 [AGENT] `security-second-opinion`: built-in `/security-review` on a scratch copy, matched against findings.csv.
    A finding only one source reports stays `single-source` until a test confirms it.

## Phase 2 — Roles and workflows

2.1 [VENDOR] Playwright planner explores the running app with the seed test, once per role.
2.2 [DET] `db-snapshot` before and after each write flow the planner found; diffs go to `output/snapshots/`.
2.3 [AGENT] `workflow-analyst`: `03-roles.md`, `role-matrix.csv`, `04-workflows.md`, `requirements.yaml`,
    `risk-register.csv`, `jira-keys.yaml` (read-only Jira lookup); completes `05-endpoint-catalog.md`.
2.4 [DET] `check-citations`, as in 1.2.
2.5 [DET] `build-stories`: `output/stories.yaml` (keep and fix stories, priority, findings, traceability),
    `output/docs/07-user-stories.md`, `output/stories/jira-stories.json` (never sent), `output/stories/review.md`.
2.6 [AGENT] `workflow-analyst`, stories mode: words the draft stories and their acceptance criteria; then
    `build-stories` again until `--check` exits 0.

## Review gate

R [HUMAN] The person running the tool reads docs 01–05, 07 and 08, the requirements, the user stories (and
  `stories/review.md`) and the risk scores, then approves or rejects them one at a time with `review-gate`
  (`--approve <id>... --by <Name>`; an item edited after its decision shows as changed until someone looks again). Every correction is written as a lesson in the
  memory of the agent that made the mistake (`agents/<agent>.md`, `## Lessons from real runs - Memory`): the name of the
  fix, the date, who caught it, what the agent got wrong and the rule since. No test is written before approval.
  Headless runs stop here.

## Phase 3 — Tests

3.1 [AGENT] `test-designer`: `output/test-cases/cases.yaml`, `output/docs/06-test-strategy.md`, `output/test-plan.md`.
3.2 [DET] `export-xray`: bulk JSON, `.feature` files, importer CSV; fails while any requirement has no case.
3.3 [DET] `scaffold-framework`: `framework/` from the template, pinned dependencies, Playwright agents and skills,
    Grafana k6 skills.
3.4 [VENDOR] Playwright generator writes specs from the approved cases, tagged `@TC-…`, `@page:`, `@role:`, tier and
    priority, using the framework's fixtures.
3.5 [DET] `run-suites`: unit → selftest → smoke (stop on failure) → every tier → other browsers. After each step the test
    data is recorded and cleaned up, and the run is archived in `output/runs/`.
3.6 [DET] `triage-failures`: environment / app / test / needs-review / app-changed, with evidence.
3.7 [VENDOR] Playwright healer, only on failures triaged `test`: at most 3 rounds. A product bug is never patched:
    after a person confirms the finding, the test becomes `test.fail()` with the finding ID.
3.8 [DET] Flake gate: every new test passes `run-suites --flake-gate --grep <tags>` (`--repeat-each=5`).
3.9 [DET] `run-perf`, `run-upgrade-compare`, `run-security-scans` (again, against the baseline), and `run-mutation`: one
    defect at a time in the running copy of the app, to learn which ones no passing test notices.

## Phase 4 — Reports and hand-off

4.1 [DET] `coverage-report` → `output/coverage.json` (pages, role-matrix cells, requirements, P1; gaps named).
4.2 [DET] `build-rtm` → `output/rtm.csv` (risk → requirement → case → spec → result → Xray key → finding).
4.3 [DET] `export-xray --results` → Xray JSON results; `publish-xray` only after the person confirms the dry run.
4.4 [AGENT] `bug-reporter`: one reproducible bug report per confirmed finding → `output/bugs/bugs.json` and `BUG-*.md`
    (evidence from the run archive, cited root cause, linked requirement and test).
4.5 [DET] `publish-bugs`: dry run; the Jira Bugs are created (evidence attached, requirement and test linked) only after
    the person confirms.
4.6 [DET] `build-report` → `output/report.html`.

## Model-call budget

5 subagent calls (the workflow-analyst twice: requirements, then story wording; plus re-runs when a citation fails), 1 `/security-review`, and Playwright's vendor agents with
bounded rounds. Every other step costs nothing to run and gives the same result every time.

## Hard rules (enforced by hooks and code, not only by this text)

- The target source is never edited (PreToolUse hook; the app runs from an image built from a copy).
- A document with an unresolved citation cannot pass (PostToolUse hook).
- Tests, scanners and load runs only touch hosts in `safety.allowed_test_hosts`; stubbed integrations and `never_test`
  hosts are blocked inside every browser test.
- Nothing is written to Jira or Xray without a dry run the person has confirmed.
