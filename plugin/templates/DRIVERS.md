# Driver contract

A **driver** is how tests reach an app. It is the second of reverse-qa's two plug points (the first is the rule pack,
`rules/CONTRACT.md`). Everything else in the tool is the same for every app: the analysts, citations, requirements,
user stories, test cases, traceability, triage, bug reports and dashboards read files, not the app.

`target.yaml` picks the driver through `app.kind`, and for a desktop app through `app.driver`:

| `app.kind` | Driver | Status | What it runs |
|---|---|---|---|
| `web` | `web` | built | Browser tests on every tier: smoke, journeys, accessibility, visual, plus the HTTP tiers below |
| `api` | `api` | built | HTTP tests with no browser: every endpoint, the role matrix, runtime security checks |
| `desktop` | `electron` | built | A desktop app made with Electron: the app itself is started and its windows are driven. Smoke, accessibility, journeys and the crawl |
| `desktop` | `appium` | planned | Windows desktop apps that are not Electron (WPF, Windows Forms, Java) |
| `mobile` | `appium` | planned | Android and iOS apps (native, Flutter, React Native) |

"Planned" means this contract is written and the driver is not built. For those apps the recipe still runs through
the review gate and the test cases: analysis, requirements, user stories, risk register, Xray test cases.
`init-target` says so when it detects one.

The `web`, `api` and `electron` drivers are one framework, `templates/framework` (Playwright + TypeScript).
`scaffold-framework` leaves out the browser tiers for an `api` target, and the HTTP tiers and the visual tier for a
desktop app.

## What a driver must provide

A driver is a folder under `templates/` that `scaffold-framework` copies to `targets/<name>/framework/`. It must give
the rest of the tool these seven things. The web driver's file for each is named as the example.

1. **Reach the app, and only the app.** Start from `target.yaml` (`runtime.base_url`, or the app binary or package
   for mobile and desktop). Refuse any host outside `safety.allowed_test_hosts`; block `safety.never_test` and every
   integration marked `test_policy: stub`, and record what was blocked. Web: `support/target.ts`
   (`assertSafeUrls`), `support/fixtures.ts` (`guard`).
2. **One session per test, per role.** Log in through the app's own login (`test_accounts`), fresh for each test, so
   no test can end another's session. Web: `logIn()`, `roleRequest`, `rolePage`.
3. **A known state before the run, and clean-up after it.** When `database` is configured: back to the seed, personal
   data masked, per-run accounts signed up, and the rows and files the run added removed and recorded. Without a
   database the driver states that data checks do not apply; it never pretends. Web: `support/seed.ts`,
   `support/global-setup.ts`, `support/global-teardown.ts`.
4. **An inventory of what a user can reach.** For web: `crawl-app` (pages, forms and what each role gets). For an
   API: the OpenAPI spec. For mobile and desktop: the screens and controls from the accessibility tree, written in the
   same shape (`output/scan/crawl.json`), so `scan-repo` merges it like any other source.
5. **Tests generated from data, never skipped.** Tiers read `output/inventory.json` and `output/role-matrix.csv`. A
   test exists only when it can run; a missing input fails with its reason. Each test is tagged `@page:` and
   `@role:` (a screen name stands in for the page on mobile and desktop), and `@TC-…` when it automates a test case.
6. **Evidence a person can open.** On failure: what was on screen (screenshot or video), the steps (a trace or the
   driver's log) and, when `runtime.error_log` is set, the server log lines written during the test.
7. **Results in a format the tool already reads.** A Playwright JSON report or JUnit XML per run, so `run-suites`,
   `triage-failures`, `coverage-report`, `build-rtm` and `build-report` work unchanged. A known defect is a test
   expected to fail, with the finding ID in the failing assertion's message.

A driver also ships self-tests that prove items 1 to 3 against a running app before any suite counts
(`selftest/fixtures.selftest.ts` for the web driver).

## The Electron driver (desktop apps made with Electron)

An Electron app's windows are web pages, so Playwright can start the app and drive them: no Appium, no emulator, no
browser to install. `init-target` writes this for an Electron project (it reads the start page from the `loadFile`
call in the app's main script):

    app:
      kind: desktop
      driver: electron
    runtime:
      app:
        start_page: renderer/index.html   # the page the app opens first, relative to the source
        # main: .                         # what Electron is given to run (default: the folder with package.json)
        # executable: dist/MyApp.exe      # a packaged app to start instead of the source

How it keeps the seven points above (`templates/framework/support/desktop.ts`):

1. **Reach.** Each test starts the app itself, from its source folder with the Electron it is built with, or from a
   packaged program. Blocked hosts are made unresolvable when the app starts (`--host-resolver-rules`), for its
   windows and for the main process's calls through Electron's network stack; requests from its windows to them are
   also recorded and can be stubbed, the same way as for a web page.
2. **Sessions.** `rolePage(role)` starts its own copy of the app and logs in through the app's login screen
   (`test_accounts.<name>.login`: the screen, and the names of its two inputs). A screen address is relative to the
   folder of the start page, so `notes.html` means the same in a spec, in the inventory and in the crawl.
3. **State.** Each copy of the app gets a data folder of its own (`--user-data-dir`), removed when the test ends. No
   test sees another's session or data, so there is nothing to reset between tests.
4. **Inventory.** `crawl-app` walks the app's windows as each role, with the same rules as for a web app.
5. **Tests.** The smoke and accessibility tiers are generated from the inventory, in one Playwright project
   (`desktop`). There are no other engines to repeat them on.
6. **Evidence.** A failed test keeps a screenshot of each window and the trace of its steps. An error that nothing
   caught in a window fails the test, the way a server error fails a web test.
7. **Results.** The same Playwright JSON and JUnit reports.

What it does not do, measured or stated on 2026-11-11:

- Requests the app's main process sends with Node's own networking (Node's `fetch`, `http`) are not blocked or
  recorded. Measured against a local server: with the host blocked, a request from a window and one through
  Electron's `net.fetch` both failed, and a Node `fetch` in the main process still arrived.
- A screen with no address of its own (a view swapped in by a script, with the address unchanged) is not found by
  the crawl, which follows links. Journeys can still reach it by clicking.
- Native menus and system dialogs (open file, save file) are outside the windows and are not driven.
- No visual tier, no upgrade comparison and no role matrix asked over HTTP: a desktop app has no HTTP surface of its
  own. If it talks to a server, that server is an `api` target.
- Each start of the app took 6 to 8 seconds on the machine it was built on, so a tier of 13 tests took 90 seconds.
- Playwright's planner, generator and healer agents drive a browser, not an app, and are not set up for it.

## The planned Appium driver

One driver for mobile and for desktop apps that are not Electron, because Appium speaks to Android (UiAutomator2),
iOS (XCUITest), Windows desktop apps and Mac apps through the same protocol. What it needs that the web driver does
not:

- `runtime` names the app (an `.apk`, `.ipa`, `.app` or `.exe`, or an installed package) and the device or emulator.
- Role sessions go through the app's login screen, or a test hook the app exposes.
- The outbound guard cannot be a browser route: it is a proxy the device is pointed at, which blocks and records.
- The inventory is the tree of screens found by walking the accessibility tree from the start screen, with the
  same skip rules as `crawl-app` (no destructive or session-ending controls).

It is not built because it has to be built and tested against a real app on a device or emulator.
