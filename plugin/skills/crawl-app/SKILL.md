---
name: crawl-app
description: >-
  Record what a user can reach in a running web app, as every role, by following links in a real browser: pages, query parameters, forms and their fields, and what each role gets on each page (opened, sent to log in, redirected, error). Works for any technology, because it reads the running app, not the source. Writes output/scan/crawl.json and output/scan/observed-matrix.csv, which scan-repo merges into the inventory. Use at step 0 for a target read by the generic pack, or to compare what the code declares with what a user can actually reach.
---

# crawl-app

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/crawl-app/crawl.mjs" --target <name> [--max-pages <n>]
    node "${CLAUDE_PLUGIN_ROOT}/skills/crawl-app/crawl.mjs" --target <name> --summary     # re-read the last record

1. The app must be running and `scaffold-framework` must have been run: the crawl uses the framework's browser, its
   per-role logins and its outbound guard.
2. Run it. Report the lines it prints: pages and forms found, what each role got, how many links it left alone,
   which other hosts the app links to, and whether it stopped at the page limit.
3. Run `scan-repo` next. Its summary then says how many pages came from the crawl, and, for a target with route
   hints, how many declared routes matched no page.

- Exit 0 = recorded, 2 = the crawl failed, 1 = usage or configuration problem (neither a web app nor a desktop app built with Electron, no base URL or start page, framework
  not installed).

## What it does and does not do

- **GET navigation only.** It never submits a form and never clicks a button. A link is an `<a href>`, an
  `<area href>`, or the literal address in a click handler, read from the handler's code.
- **Inside the app only.** Links to other hosts are recorded, never followed; hosts in `safety.never_test` and stubbed
  integrations are blocked like in every test.
- **It leaves destructive links alone**: a link whose address or visible label contains logout, delete, remove,
  cancel, reset and similar words (`lib/crawl.mjs` `SKIP_WORDS`, plus `crawl.skip` in target.yaml) is listed under
  `skipped`, not followed.
- **It cannot know every link's effect.** An app that changes data on a GET link with a harmless name will be changed.
  Crawl a disposable copy; when a database is configured it is put back at the seed before and after.
- **Its queries are information, not test input.** A page reached as `book.php?id=1` is recorded with
  `seen_query: id=1`. Tests never use it, because a link the crawl saw can write data (an add-to-cart link). A page
  that needs a query to open is named in target.yaml `page_params` by a person; an API spec's declared examples are
  used on their own.
- **Server errors are recorded, not judged.** Where a server log is configured, each page and role records how many
  errors the app logged while it was asked (`server_errors`). A page that answers with a redirect and still logs an
  error kept running behind the redirect.
- **Links to files** (PDF, images, archives) are listed under `files` and never opened as pages.
- After following links, every role asks for every page any role found, so `observed-matrix.csv` has one row per page
  and role. That is what the app does today. It is input for the workflow-analyst, not the expected role matrix.

## target.yaml

    crawl:
      start: [index.php]        # where to begin (default: runtime.health_path, else the base URL)
      max_pages: 200            # per role
      skip: [archive, approve]  # more words that mark a link as one to leave alone

## Tools

Bash (node).

## Data

- Reads: `target.yaml`, the running app.
- Writes: `output/scan/crawl.json`, `output/scan/observed-matrix.csv`, a ledger line.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Read click handlers.** 2026-11-10, Anton: the first crawl of a real app found 3 pages where the PHP pack knows 33. Cause: its menus are click handlers (`onclick="location.replace('…')"`), not links, and the crawl followed only `<a href>`. **Rule:** the crawl also reads the address a click handler navigates to, from its code and without running it (`scriptTargets` in lib/crawl.mjs); an address built from variables is not guessed.
- **Start at login landing.** 2026-11-10, Anton: in the same run the Admin never reached the admin area: every role started from the home page, and nothing there links to it. **Rule:** each role also starts from the page its login lands on (`logIn()` returns it), which is where its own menu is.
- **Visited list per role.** 2026-11-10, Anton: a role skipped links to pages another role had already found, so links only it sees on those pages were missed. **Rule:** `recordVisit` returns every link worth following and the crawl keeps one visited list per role.
- **Record server errors.** 2026-11-10, Anton: the second crawl was marked failed although it had recorded 31 pages: the server-log watcher failed it for PHP fatals the app logs behind its redirects. Cause: the crawl ran as a test, and the watcher fails a test on any server error. **Rule:** the crawl is an observation; it records server errors per page and role (`server_errors`) and the watcher leaves a run annotated `server-errors-recorded` alone.
- **Separate files and queries.** 2026-11-10, Anton: the same crawl recorded a PDF as a page, and its first design would have fed the queries it saw into the page tests, including an add-to-cart link. **Rule:** links to files go to `files`; a seen query is kept as `seen_query` and never used by a test.
- **Visit redirect targets.** 2026-11-10, Anton: on the fixture shop the login page was never visited as a page of its own: nothing links to it, a visitor only lands there when redirected. **Rule:** the page a role is redirected to is returned as a page to visit.
- **Pages that move on count.** 2026-11-10, Anton: the same shop's add-to-cart page moves the customer on to checkout, so no role "opened" it and no test would have picked a role for it. **Rule:** a role may use a page that opened or that moved it on to a page other than the login (`reachable_by`), the same reading the authorization tier uses for "allowed".
- **Crawl an app's own pages.** 2026-11-11, Anton: the crawl refused every address of a desktop app, because "inside the app" meant http or https on the same origin. **Rule:** for an app whose pages are its own files, inside the app is the same scheme and host under the folder of its start page; a web app still never follows a link to a file on disk (`relPath` in lib/crawl.mjs, unit-tested). On the mini-desktop fixture the crawl found 6 screens as 3 roles and left the sign-out and delete-all links alone.
- **Start page, not the folder.** 2026-11-11, Anton: for a desktop app the default start address was the base itself, which is a folder on disk: the app would have listed every file in it, the page that deletes all notes among them, with no label to warn the crawl. Caught before the first run. **Rule:** a desktop app's crawl starts at `runtime.app.start_page`.
- **Wait out in-page redirects.** 2026-11-11, Anton: a desktop app guards its screens in the page's own script, which replaces the address while the page is still loading; waiting for the first DOM event would have been cut off by that and recorded an error where the app had sent the role to log in. **Rule:** on a desktop app a visit waits for the page to be committed and for the address to stop changing, then records where the window ended.
