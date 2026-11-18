---
name: init-target
description: >-
  Put a new app under reverse-qa: looks at its source folder, says what it is (stack, and web, API, mobile or desktop), prints what the tool can do for it today, writes targets/<name>/target.yaml and .env, and checks the prerequisites (--doctor). Works for any technology: stacks without a dedicated rule pack are read by the generic pack. Use when someone wants to try reverse-qa on their own app, when a target.yaml is missing, or to check why a target will not run.
---

# init-target

## Prompt

    node "${CLAUDE_PLUGIN_ROOT}/skills/init-target/init.mjs" --name <app> --source <dir> [--url <base url>] [--compose <file>] [--openapi <file|url>] [--kind web|api|mobile|desktop]
    node "${CLAUDE_PLUGIN_ROOT}/skills/init-target/init.mjs" --detect --source <dir>
    node "${CLAUDE_PLUGIN_ROOT}/skills/init-target/init.mjs" --doctor --target <name>

1. Ask the person for what only they know, then pass it as flags: the folder of the app's source; the URL where a
   **test** copy answers (or a docker-compose file that starts one); whether there is an API spec.
2. Run it. Read the output to them: what was detected and why, the "what works today" table, and the next steps.
3. If the detected kind is wrong, run again with `--kind` and `--force`.
4. Help them fill the TODO lines in `target.yaml`: the description, the test accounts (one per role that logs in)
   and `safety.never_test` (their production hosts).
5. Run `--doctor` and fix every FAIL before the first scan.

- Exit 0 = written (or all checks pass), 2 = a required check failed, 1 = usage or configuration problem.
- It never overwrites an existing `target.yaml` without `--force`, and never touches the app's source.
- A URL that is not localhost is added to `safety.allowed_test_hosts` and a warning is printed: tests will send
  requests there. Confirm with the person that it is a test environment before running anything against it.

## What the answer means

- **Stack**: named from project files (pom.xml, package.json, *.csproj, AndroidManifest.xml, pubspec.yaml and so on).
  PHP has a dedicated rule pack. Every other stack is read by the generic pack: files, SQL in string literals,
  outbound URLs and route hints; its pages come from the running app (crawl-app) or an API spec.
- **Kind**: web and API apps get automated tests today. For mobile and desktop apps everything up to test cases
  works (analysis, requirements, user stories, test cases); automation needs the Appium driver described in
  `templates/DRIVERS.md`.

## Tools

Bash (node).

## Data

- Reads: the source folder (file names and the start of project files only).
- Writes: `targets/<name>/target.yaml`, `targets/<name>/.env` (the source path; gitignored), `.env.example`, and `targets/<name>/.gitignore` when there is none (it keeps `.env`, per-machine state and run archives out of git, so the workspace can be any folder).

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Start page from loadFile.** 2026-11-11, Anton: a desktop app has no URL to give init-target, so its target.yaml had no way to reach the app. **Rule:** for an Electron project init-target writes `app.driver: electron` and `runtime.app.start_page`, read from the `loadFile(...)` call in the app's main script; when the code names no page the line is left as a TODO, and `--doctor` fails on it and on a source folder with no Electron installed.
