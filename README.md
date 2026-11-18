# reverse-qa

A Claude Code plugin that reverse-engineers an application with no documentation and builds its quality
engineering from the source: architecture and security model, roles and workflows down to the database rows they
write, testable requirements, user stories, Xray-ready test cases, and a complete Playwright + TypeScript automation
framework that it runs, with performance, security and upgrade checks. Every claim it writes cites a file and line in
the app's code, and a hook rejects any citation that does not resolve.

It is not tied to one app or one stack. Point it at your own repository: the source is only ever read, and tests only
ever reach the hosts you allow.

| Page | What it shows |
|---|---|
| [How it works](https://rumatanton.github.io/reverse-qa-plugin/how-it-works.html) ([source](docs/how-it-works.html)) | diagrams of the agent, the deterministic / model / human split, and the workflow |
| [Architecture](https://rumatanton.github.io/reverse-qa-plugin/architecture.html) ([source](docs/architecture.html)) | the parts, the agents, the skills, the rules it keeps |

## Quick start

You need [Claude Code](https://claude.com/claude-code), Node.js 22 or newer and git. Docker, k6 and a Jira site are
optional (see [Requirements](#requirements)).

**1. Install the plugin** (in Claude Code):

    /plugin marketplace add rumatanton/reverse-qa-plugin
    /plugin install reverse-qa@reverse-qa

**2. Open Claude Code in a workspace folder.** Any folder works, an empty one is fine. reverse-qa keeps everything it
writes under `targets/<app>/` in that folder and never writes into your app's source.

**3. Put your app under the tool, then run the recipe:**

    /reverse-qa:init-target          # asks where the source is and where a test copy of the app answers
    /reverse-qa:recon my-app

`init-target` looks at the source, says what the app is (stack, and web, API, mobile or desktop) and why, prints what
works for it today, and writes `targets/my-app/target.yaml`. `recon` then runs inventory, technology and security
analysis, roles and workflows, and **stops at the review gate** until a person approves the requirements, one at a
time and by name. After that it designs the tests, scaffolds and runs the framework, and builds the reports.

### From a clone, without installing

Every step is also a plain script, so the same thing works from a clone of this repository:

    git clone https://github.com/rumatanton/reverse-qa-plugin.git
    cd reverse-qa-plugin/plugin && npm ci && cd ..
    node plugin/skills/init-target/init.mjs --name my-app --source /path/to/my-app --url http://localhost:8080/
    node plugin/skills/init-target/init.mjs --doctor --target my-app
    claude --plugin-dir ./plugin         # then: /reverse-qa:recon my-app

`--doctor` checks the prerequisites and names what is missing. Add `--compose <file>` to let the plugin start, stop
and reset the app, and `--openapi <file|url>` when there is an API spec (one in the source is found on its own).
Every script takes `--root <folder>` to keep the `targets/` folder somewhere other than the current directory.

### Try it with no app of your own

The repository carries a small JSON API it uses as a test fixture. This takes it from a source folder to an
inventory, with no browser and no Docker:

    node plugin/skills/init-target/init.mjs --name demo --source plugin/tests/fixtures/mini-api
    node plugin/skills/init-target/init.mjs --doctor --target demo
    node plugin/skills/scan-repo/scan.mjs --target demo
    # targets/demo/output/inventory.json: 7 endpoints from the API spec, each cited to its line

## What works, by kind of app

Two parts are pluggable; everything else is the same for every app, because it reads files (source, requirements,
reports), not a framework.

| Plug point | What exists | What a new app needs |
|---|---|---|
| **Reading the source** (rule pack) | `generic` reads any language: files, SQL in strings, outbound URLs, route hints. `php` parses PHP in depth. | Nothing. A dedicated pack is an optional extra for depth (`plugin/rules/CONTRACT.md`). |
| **Driving the app** (driver) | `web` (browser), `api` (HTTP) and `electron` (a desktop app built with Electron, driven through its own windows), all on Playwright. | Mobile apps, and desktop apps not built with Electron, need the Appium driver, written up in `plugin/templates/DRIVERS.md` and not built yet. |

| | Web app | API | Desktop app (Electron) | Mobile, or other desktop app |
|---|---|---|---|---|
| Architecture, security, roles and workflows, every claim cited | yes | yes | yes | yes |
| Requirements, user stories, risk register, Xray test cases, bug reports | yes | yes | yes | yes |
| Inventory | source scan + a crawl of the running app (+ API spec) | source scan + OpenAPI spec | source scan + a crawl of the app's own windows | source scan |
| Automated tests | browser and HTTP tiers | HTTP tiers | the app is started itself: smoke, accessibility, journeys | needs the Appium driver |
| Upgrade comparison (two versions, the same tests, the differences) | yes | yes | no | no |
| Database reset, row snapshots, server log watched during tests | when `target.yaml` names a database and a log | the same | not needed: each test starts the app with a data folder of its own | no |

Where the pages come from when there is no dedicated pack: `crawl-app` walks the running app as every role (GET
only, inside the app, skipping links that look destructive) and an OpenAPI spec lists the endpoints. `scan-repo`
merges both with the source scan, and flags routes declared in the code that neither the spec nor the crawl reached.

Limits to know: a crawl cannot see a page that nothing links to; a token login works for API requests, not yet for a
browser session; the crawl follows GET links only, so a page reached only by a form post is found when a person
names it or a spec lists it; and the analysers read the whole app in one pass: analysing a very large codebase one
module at a time, then merging, is not built yet.

A desktop app built with Electron needs no URL: `init-target` reads the page the app opens first from its main
script, and each test then starts its own copy of the app. What that driver does not do (requests the main process
sends with Node's own networking, screens with no address of their own, native menus and dialogs) is listed in
`plugin/templates/DRIVERS.md`.

### Test accounts

One entry per role that logs in. The values live in `targets/<app>/.env`, which `init-target` keeps out of git, never
in a tracked file. Use accounts made for testing, never a real person's.

    test_accounts:
      admin:                      # a login form: success is a redirect, the session is a cookie
        role: Admin
        user_env: ADMIN_USER
        password_env: ADMIN_PASSWORD
        login: { path: admin/login, user_field: username, password_field: password }
      customer:                   # a JSON login: the answer carries a token that later requests send in a header
        role: Customer
        user_env: CUSTOMER_EMAIL
        password_env: CUSTOMER_PASSWORD
        login: { path: login, json: { email: "{user}", password: "{password}" }, token: token, header: Authorization, scheme: Bearer }

Add `register:` to sign a fresh account up in every run, so no test ever logs in as a real person. Every setting,
with a full example, is in [docs/target-reference.md](docs/target-reference.md).

## What is inside

| Part | What it is |
|---|---|
| **4 subagents** | `tech-analyst` (Opus): architecture, integrations, security model, findings with root cause, and which test types the app needs that the tool does not run yet. `workflow-analyst` (Opus): roles, role × page matrix, end-to-end workflows, requirements, risk register. `test-designer` (Sonnet): Xray-native test cases, test strategy, test plan. `bug-reporter` (Sonnet): one reproducible bug report per confirmed finding, with evidence from the test run, ready for Jira. Each is checked by code, never by another model. |
| **Playwright's 3 test agents** | planner (explores the running app), generator (writes specs), healer (repairs tests that fail for test reasons only). Installed per target by `scaffold-framework`. |
| **24 skills** | One job each, deterministic: `recon` (the recipe), `init-target` (put a new app under the tool), `crawl-app` (what each role can reach in the running app), `scan-repo`, `run-target-app`, `db-reset`, `db-snapshot`, `check-citations`, `security-second-opinion`, `run-security-scans`, `build-stories` (user stories from the requirements), `review-gate` (a person approves or rejects each requirement and story by name), `scaffold-framework`, `run-suites`, `triage-failures`, `run-perf`, `run-upgrade-compare`, `run-mutation` (one defect at a time in the running copy: which ones no passing test notices), `coverage-report`, `build-rtm`, `export-xray`, `publish-xray`, `publish-bugs`, `build-report`. |
| **3 hooks** | SessionStart installs the plugin's Node dependencies when missing; PreToolUse blocks any edit to the target's source; PostToolUse rejects a document whose citations do not resolve. |
| **2 MCP servers** | The official Atlassian MCP (Jira, read-only tools for the agents) and the plugin's own Xray MCP (validate, find, and import tests or results; imports only after a confirmed dry run). Both are optional. |
| **Rule packs** | `rules/generic`: any language, no parser, no Docker. `rules/php`: PHP-Parser 5.9 extractor and Psalm 6.20 in a pinned image. `rules/CONTRACT.md` is what a pack must produce. |
| **Templates** | The Playwright framework (web, API and Electron desktop drivers), the driver contract (`templates/DRIVERS.md`), a PHP + Apache runtime, the k6 script. |
| **Tests** | 208 plugin tests (`node:test`): unit, hooks, rule-pack contract and scanners in Docker, an end-to-end runtime test on a fixture app with known answers. Opt-in (`npm run test:e2e`): three end-to-end runs on apps the PHP pack is not used for: a JSON API (spec, token login, no browser), a web app with the parser switched off (pages from the crawl only) and a desktop app built with Electron (the app is started itself: no server, no browser); and agent behavior tests. |

## Requirements

- Claude Code, Node.js 22 or newer, git.
- Docker (Docker Desktop with the WSL 2 engine on Windows): only for the PHP rule pack, for an app the plugin starts
  from a compose file, and for the Semgrep, Psalm and ZAP scans. An app read by the generic pack and reached by URL
  needs no Docker; `--doctor` says which case you are in.
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/): only for `run-perf`.
- Optional: an Atlassian Cloud site with Xray Cloud (API key) to publish tests and results. The plugin settings ask
  for the Xray project key and API key; leave them empty to work offline (validate and dry runs only).

## Run

In Claude Code:

    /reverse-qa:recon my-app

The recipe (`plugin/skills/recon/workflow.md`) is a fixed, ordered sequence. Every step is also a skill you can run on
its own. From a clone the scripts are under `plugin/skills/`; in an installed plugin, ask Claude for the step by name
(for example "run the suites for my-app") and it runs the same script.

    node plugin/skills/run-target-app/run.mjs --target my-app          # app + database, seeded and proven
    node plugin/skills/run-suites/run.mjs --target my-app              # unit → selftest → smoke → all tiers → browsers
    node plugin/skills/run-perf/perf.mjs --target my-app --scenario both
    node plugin/skills/run-security-scans/security.mjs --target my-app
    node plugin/skills/build-report/report.mjs --target my-app

Rerun every check on a target that has been through recon, with no model calls:

    node plugin/skills/recon/rerun.mjs --target my-app                 # --dry-run lists the steps

No skipped tests: a test that cannot run fails and says why.

Watch the tests, in `targets/my-app/framework`: `npx playwright test --ui` (UI mode with a timeline),
`SLOWMO=500 npx playwright test --headed --workers=1`, or `npx playwright show-report`.

## Outputs (`targets/<app>/output/`)

| File | Content |
|---|---|
| `inventory.json`, `crud-matrix.csv`, `er.mmd` | pages, includes, SQL per table, forms, uploads, session guards, redirect risks, data model |
| `docs/01–08` | architecture, security, roles, workflows, endpoint catalog, test strategy, user stories, test types the app needs |
| `stories.yaml`, `stories/` | user stories (keep and fix), each traced to its requirements and findings; Jira-ready JSON (never sent); items for the review gate |
| `requirements.yaml`, `risk-register.csv`, `role-matrix.csv` | requirements with evidence (functional, security, and performance, accessibility and browser support), likelihood × impact, page × role expectations |
| `review.json`, `approved/` | the review gate: who approved or rejected each requirement and story, and when; the approved items, unchanged since |
| `test-cases/cases.yaml`, `test-cases/features/`, `xray/` | test cases, Gherkin, Xray bulk JSON and importer CSV, results |
| `findings.csv`, `security/`, `triage.json` | findings with root cause and lifecycle, scanner results vs baseline, failure triage |
| `bugs/` | `bugs.json` and one `BUG-*.md` per confirmed finding; `jira-bug-keys.json` after `publish-bugs` |
| `perf/`, `upgrade/` | k6 baseline with slowest SQL, the comparison of two runtime versions |
| `mutation/` | the mutation check: each defect put into the running copy, and whether a test noticed it |
| `coverage.json`, `rtm.csv`, `report.html` | measured coverage with gaps, traceability matrix (a case reaches its results by tag or by `covers`: tiers, browsers, k6), one-page report |
| `runs/<stamp>-<step>/` | every test run kept: reports, JUnit, HTML report, server log, traces, clean-up record (gitignored) |

## Safety rules (enforced in code)

- The target's source is never edited; an app the plugin starts runs from an image built from a copy.
- Tests, scanners and load runs only reach hosts in `safety.allowed_test_hosts`. List production hosts under
  `safety.never_test`; payment gateways and other outside hosts are blocked inside every browser test.
- Nothing is written to Jira or Xray (tests, results or bugs) without a dry run the person has confirmed.
- After every test run the test data is recorded, then removed; a database the plugin can reach is back at the seed.
- No document may quote seed-data emails or a secret from `.env`: the citation check fails on it.

Point it only at a test environment you are allowed to test.

## Privacy

The plugin has no telemetry and sends nothing anywhere on its own. The model calls go through your own Claude Code
session. It makes network requests only to the app you point it at, to an API spec URL you give it, and, when you
configure them, to your Jira site (Atlassian MCP, bug publishing) and Xray Cloud. Credentials for test accounts stay
in `targets/<app>/.env` on your machine; the Xray API key is stored by Claude Code in the system credential store.

## Tests and CI

    cd plugin && npm test            # everything, ~60 s with Docker running
    cd plugin && npm run test:unit   # no Docker, ~30 s
    cd plugin && npm run test:e2e    # opt-in: three end-to-end runs on the fixture apps (installs npm packages)

`.github/workflows/`: `ci.yml` (plugin tests, then one end-to-end run on the API fixture), `agent-behavior.yml`
(manual; the subagents on the fixture app, needs an API key), `release.yml` (tag → packaged plugin).
`git config core.hooksPath .githooks` enables the pre-commit unit tests.

## Lessons: the tool's memory

When a run turns up a failure in the plugin itself, or the approach changes, fix the root cause and write it down in
the same change, in the file that owns it: the skill's SKILL.md, the agent's .md (tech-analyst, workflow-analyst,
test-designer, bug-reporter), or for Playwright's planner, generator and healer
`plugin/skills/scaffold-framework/agent-lessons/` (scaffold-framework adds those to the generated agents). Each goes
under `## Lessons from real runs - Memory`, the last section of the file: it is that skill's or agent's memory. A
lesson opens with the name of the fix in bold, two or three words, so a person can scan the list by reading only the
names. After the name comes what the agent reads: the date, the name of the person who ran it and confirmed the fix,
what failed, why, and the rule since after a bold **Rule:**.

    - **Dump over stdin.** 2026-11-09, Anton: the dump import hung on a file-sharing prompt. Cause: the dump was
      bind-mounted. **Rule:** pipe it to `mysql` over stdin.

The next run reads it, so it doesn't repeat the mistake. The person's name says who to ask about a lesson, and a
lesson nobody put a name to is refused: a unit test requires the section and this form everywhere (a name of two to
six words, the date, the person, the bold rule), and the pre-commit hook flags a skill whose scripts changed without
its SKILL.md. The lessons shipped here come from the author's runs on real apps; yours add to them.

## License

[MIT](LICENSE).
