---
name: scan-repo
description: >-
  Inventory a reverse-qa target of any technology: the source is read by its stack's rule pack (PHP-Parser for PHP; the generic pack for every other language), endpoints are added from an OpenAPI spec and from crawl-app's record of the running app, and the seed database dump gives the data model. Reports pages and includes, request inputs, SQL per table with a CRUD matrix, session keys and guards, redirects that run on after output or without exit, forms and fields, uploads, outbound hosts and an ER diagram. Deterministic, no model. Use at step 0 of /recon, or again whenever the target source changes.
---

# scan-repo

## Prompt

Run:

    node "${CLAUDE_PLUGIN_ROOT}/skills/scan-repo/scan.mjs" --target <name> [--fetch-openapi]

- Exit 0: it prints one summary line (files, pages, includes, parse errors, SQL statements, tables, forms, uploads,
  session keys, outbound hosts, redirect risks). Report that line as is.
- Exit 2: the rule pack failed or its output broke `rules/CONTRACT.md`. Report the message. Do not hand-edit the
  inventory to work around it.
- Exit 1: usage or configuration problem (unknown target, `TARGET_DIR` not set, `api.openapi` names a file that is
  not there or a URL that was not fetched yet).

Where pages come from, and what the summary line says about it (`7 pages: 7 from the API spec`):

- The **PHP pack** parses the source: a file is a page. Nothing else is needed.
- The **generic pack** (every other stack) reads files, SQL in string literals, outbound URLs and route hints. It
  does not make pages from source. Pages come from `api.openapi` in target.yaml (a file, or a URL saved with
  `--fetch-openapi` while the app runs) and from `output/scan/crawl.json` (run `crawl-app` first, for a web app).
  With neither, the scan says "no pages yet" and what to do.
- `route hints (N matched no page)`: lines that declare an endpoint in the code. The unmatched ones are routes that
  neither the spec nor the crawl reached. Report the count; `inventory.route_hints` lists them with file and line.
  They are leads for the analysts, not findings.

Then read `output/inventory.json` before writing any document. The agents start from it instead of re-deriving
pages, SQL or forms. `redirect_risks` are leads, not findings: each one needs a runtime test (T3 authz) before it
can be reported as a defect.

Dump formats: phpMyAdmin and mysqldump write `AUTO_INCREMENT` and primary keys after the data, in
`ALTER TABLE ... MODIFY` and `ALTER TABLE ... ADD PRIMARY KEY`; the parser reads both places. When the inventory and
the dump disagree on a column, the dump wins: report it as a scan-repo defect with both line references and don't
document the inventory's version.

How it runs: the pack image (`rqa-rules-<stack>:<hash>`) is built from `rules/<stack>/` on first use. The source
files the pack needs are copied into a temp folder and then into a throwaway container with no network
(`docker cp`, never a bind mount). The clone is never written.

## Tools

Bash (node, docker).

## Data

- Reads: `targets/<name>/target.yaml` (`source.stack`, `source.language_version`, `source.scan_exclude`,
  `source.seed_dump`, `api.openapi`, `runtime.base_url`, `safety.allowed_test_hosts`), the target source (read
  only), `output/scan/crawl.json` and `output/scan/openapi.*` when present.
- Writes: `targets/<name>/output/inventory.json`, `crud-matrix.csv`, `er.mmd`, `scan/raw.json` (the pack's exact
  output, kept for debugging), one line in `ledger.jsonl`.

## Lessons from real runs - Memory

This is the skill's memory. Each failure found while running it: what broke, why, and the rule since. Add one with the fix, in this form: the name of the fix in bold, the date, the name of the person who ran it and confirmed the fix, what failed, the cause, then the rule after a bold **Rule:**.

- **Auto-increment from ALTER TABLE.** 2026-11-10, Anton: the inventory marked every table key as not auto-increment; the tech-analyst agent caught it against the dump. Cause: phpMyAdmin dumps set `AUTO_INCREMENT` in a later `ALTER TABLE ... MODIFY`, which the parser ignored. **Rule:** read both places (unit test on the fixture seed); when the inventory and the dump disagree, the dump wins.
- **Generic pack for any stack.** 2026-11-10, Anton: the tool could only read PHP, so it could not be handed to someone with another app. Cause: pages came only from a per-language parser. **Rule:** a stack with no dedicated pack is read by the generic pack, and its pages come from the API spec and the crawl; a dedicated pack is an optional extra for depth, never a requirement.
