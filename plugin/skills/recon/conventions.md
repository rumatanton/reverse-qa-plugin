# recon conventions

Every agent and skill in reverse-qa follows these rules. Scripts enforce the parts marked (checked).

## Citations (checked by check-citations)

Cite source evidence inline as:

    [cite: <path>:<line> "<exact quote>"]

- `<path>` is relative to the target source root, forward slashes, e.g. `admin/index.php`.
- `<line>` is the 1-based line number. The quote must appear on that line or within 2 lines of it.
- `<exact quote>` is a short verbatim fragment (5–80 characters) copied from that line. No paraphrase.
- One claim may carry several citations. A claim with no citation is not allowed in docs 01–05 or requirements.

## Labels (registers)

Every load-bearing claim and every requirement carries one label:

- `verified`: cited in code **and** confirmed on the running app (a test, a database diff or a recorded observation).
- `code-only`: cited in code, not yet confirmed at runtime.
- `inferred`: a reasoned conclusion that no single line proves. Say what it rests on.

## Requirements (requirements.yaml, checked by schema)

```yaml
- id: REQ-AUTH-001            # REQ-<AREA>-<NNN>; AREA is letters only: AUTH, ROLE, CAT, CART, PAY, BOOK, REQS, CMT, PROF, ADM, DATA, SEC, and the non-functional PERF, ACC (accessibility), COMPAT (browsers and screen sizes)
  statement: "When <trigger>, the system shall <response>."   # EARS style
  role: Customer               # Visitor | Customer | Admin | System
  kind: as-is                  # as-is = what the app does today; intended = the rule it should follow where today differs
  evidence:
    - { file: login.php, line: 33, quote: "..." }
  label: code-only             # verified | code-only | inferred
  notes: ""                    # optional
```

## Security writing

Describe each security point as: the control, where it lives (citation), the risk in one sentence, severity
(critical / high / medium / low), and the OWASP ASVS 5.0 requirement it relates to. Do not write exploitation steps.
All verification runs against the local copy only.

## Findings (findings.csv): defect management and root cause

Columns: `id, title, severity, priority, area, steps, expected, actual, evidence, root_cause, cause_category,
five_whys, req_id, test_id, sources, status, notes`.

- `id` `F-<NNN>`. `severity` (impact): critical / high / medium / low. `priority` (fix order): P1–P3, from the
  risk register of the requirement it breaks.
- `root_cause`: a citation to the line where the cause lives, not where the symptom shows. `cause_category`: missing
  check, wrong order, unsafe default, missing validation, configuration, design. `five_whys`: the chain, separated
  by ` > `.
- `sources` lists who reported it (tech-analyst, security-review, semgrep, psalm, zap, test, triage-failures).
- `status` is the lifecycle: `new` → `triaged` → `confirmed` (a `test.fail()` test tagged with the ID failed as expected,
  at the assertion whose message starts with the ID; set by `triage-failures --confirm-findings`, which also fills
  `test_id`) or `rejected` (reason in
  notes); `single-source` marks a finding only one source reports. Confirmed findings get a `test.fail()` test
  whose title carries the finding ID, so the suite stays green while the defect is documented.

## Role matrix (role-matrix.csv)

Columns: `page, role, expected, evidence`. One row per page in the inventory and per role. `expected`: `allowed`,
`redirect` (to a login page), `denied` (401 or 403, what an API answers), `error` or `not-reachable`. `evidence`: a `path:line` citation. Role tests tag each run
`@page:<path> @role:<Role>`, which is how coverage-report counts the cells.

## Risk register (risk-register.csv)

Columns: `req_id, feature, likelihood, impact, score, priority, rationale, evidence`. Likelihood and impact are 1–5,
score = likelihood × impact. Priority: P1 for 15 or more, P2 for 8–14, P3 for 7 or less. It sets the test depth and
the CI order (`@p1` runs right after smoke).

## Test cases (test-cases/cases.yaml, checked by export-xray)

One canonical file; export-xray renders the Xray bulk JSON, the importer CSV and the `.feature` files from it.

```yaml
project_key: QA                     # optional; otherwise target.yaml xray.project_key
cases:
  - id: TC-AUTH-001                  # TC-<AREA>-<NNN>
    title: Admin logs in with valid credentials and lands on the admin home   # 5–255 characters
    requirement: REQ-AUTH-001        # one id or a list; must exist in requirements.yaml
    priority: P1                     # P1 | P2 | P3, from the risk register
    tier: authn                      # smoke page api flow integration roles authn authz e2e char db a11y visual perf security upgrade
    technique: equivalence-partitioning   # equivalence-partitioning boundary-value decision-table state-transition use-case pairwise error-guessing exploratory checklist
    type: manual                     # manual (steps) | cucumber (gherkin steps, optional Examples table)
    preconditions: [The database is reset to the seed]
    steps:
      - { action: Open admin_login.php, data: "", expected: The admin login form is shown }
    tags: [ASVS-6.2.1, WSTG-ATHN-03] # security cases
    automation: framework/tests/t3-roles/authn/admin-login.spec.ts         # once automated
    covers: ["@authz @page:admin/index.php @role:Visitor"]                 # optional: results that automate it with no case tag
```

Playwright specs link back with the case id in the title (`test('admin logs in @TC-AUTH-001', …)`), which is how
results reach the right Xray test.

`covers` is for results that carry no case id: the template tiers make one test per page and role, and k6 is not a
Playwright test. Each selector is a few words that must all be true of one result: a tag in the test's title
(`@a11y`, `@page:login.php`, `@role:Visitor`), a browser (`project:firefox`, `project:webkit`, `project:mobile`) or a
k6 scenario (`k6:load`, with `@page:index.php` for one page). Examples: `"@a11y @page:login.php"`,
`"project:firefox @e2e"`, `"k6:load @page:index.php"`. coverage-report and build-rtm count a covered result for the
case, and build-rtm lists every selector that matched no result that ran (`covers_matching_nothing`), so a wrong
selector never reads as coverage. k6 results reach coverage and the matrix; they are not sent to Xray.

## User stories (stories.yaml, checked by build-stories --check)

```yaml
- id: US-AUTH-002            # US-<AREA>-<NNN>; kept across rebuilds
  epic: Authentication       # the requirements' feature in risk-register.csv
  area: AUTH
  role: Visitor              # Visitor | Customer | Admin | System
  kind: fix                  # keep = today's behaviour to protect; fix = the intended rule where today differs
  priority: P1               # the highest priority of its requirements
  requirements: [REQ-AUTH-018]   # the story's own requirements; each requirement is in exactly one story
  replaces: [REQ-AUTH-017]   # fix only: the as-is requirements its intended rules pair with (today's broken side)
  findings: [F-003]          # from findings.csv req_id and the F-ids in the requirements' notes (pairs included)
  wording: final             # draft (written by code) | final (worded by the workflow-analyst, stories mode)
  story: "As a visitor, I want my password stored safely, so that a leaked database does not expose it"
  acceptance:                # at least one per requirement, only for the story's own requirements
    - { req: REQ-AUTH-018, given: "a visitor who is not logged in", when: "a visitor registers", then: "the system stores a salted hash of the password" }
```

build-stories writes every field but `story`, `acceptance` and `wording` and re-derives them on `--check`; the wording
step changes only those three. A replaced requirement is never an acceptance criterion.

## Jira keys (jira-keys.yaml)

`REQ-AUTH-001: QA-123`, one line per requirement that matches an existing Jira story. Unmapped requirements still
travel as Xray labels. `xray/xray-keys.json` (written by publish-xray) maps case ids to the Xray test keys created.

## Test types (docs/08-test-types.md, checked by check-citations)

Written by tech-analyst from `skills/recon/test-types.yaml`, the list of test types the tool runs and the ones it knows
it does not run yet. One table, one row per type:

    | type | status | why | evidence | tool |
    |---|---|---|---|---|
    | session-tests | not built | logout leaves the session usable | [cite: logout.php:3 "session_destroy"] | Playwright request tests |
    | smoke | have | every page, as an allowed role | - | run-suites |
    | websocket | proposed | prices are pushed over a socket no tier listens to | [cite: app.js:12 "new WebSocket"] | Playwright page.on('websocket') |

- `type`: the catalogue `id`, or a new short id for a type the catalogue does not list.
- `status`: `have` (built and it runs on this app's driver), `not built`, `not applicable` (say why), or `proposed`
  (not in the catalogue: needs a citation and a tool).
- Every catalogue type has exactly one row.

## Bug reports (bugs/bugs.json, checked by publish-bugs)

One entry per **confirmed** finding, written by bug-reporter; publish-bugs turns each into a Jira Bug.

```json
{ "bugs": [ {
  "id": "BUG-001", "finding_id": "F-001",
  "summary": "Admin dashboard is served to visitors without a session",        // 10–255 characters
  "severity": "high", "priority": "P1",                                         // from the finding
  "environment": "local copy, commit e37e08f, PHP 7.2 (web), MariaDB 10.4, Chromium",
  "steps": ["Reset the database to the seed", "Request admin/ without a session cookie"],
  "expected": "HTTP 302 to admin_login.php with no page content",
  "actual": "HTTP 200 with the Admin Home page",
  "root_cause": "admin/index.php:8 header() after output from header.php, no exit",  // path:line
  "evidence": ["runs/<stamp>-report/php-error.log: Cannot modify header information …"],
  "attachments": ["output/runs/<stamp>-report/artifacts/<test>/trace.zip"],   // relative to targets/<name>/
  "requirement": "REQ-ADM-001", "test_ids": ["TC-ADM-001"], "labels": ["authz"]
} ] }
```

Write security bugs as risk plus evidence: no exploitation payloads, no credentials, no personal data. publish-bugs
rejects any value of a password, token, secret or key variable from the target's `.env`.
