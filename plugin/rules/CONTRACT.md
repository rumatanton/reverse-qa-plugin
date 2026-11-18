# Rule-pack contract

A rule pack turns one stack's source code into **raw facts**. `scan-repo` normalizes those facts
(`plugin/lib/inventory.mjs`) into `inventory.json`, so everything after step 0 is stack-independent.

## Two kinds of pack

| Pack | Reads | Pages come from | Use |
|---|---|---|---|
| `generic` (`rules/generic/extract.mjs`) | any language, no parser, no Docker | the running app (`crawl-app`) and an OpenAPI spec (`api.openapi`) | every stack without a dedicated pack; nothing to write |
| dedicated (`rules/php`) | one stack, with a real parser, in a pinned image | the source itself (a file is a page) | when exhaustive code facts are worth it: every guard, every redirect without `exit`, which page writes which table |

A new app needs **no new pack**: `init-target` assigns the generic pack to any stack that has no dedicated one. A
dedicated pack is an optional addition for depth. It emits the shape below and passes the same contract tests;
nothing else changes.

What the generic pack reports, each with its line: SQL statements in string literals and XML mapper tags (`sql`),
http(s) URLs (`urls`, context `code` or `asset`), and route hints (`routes`: lines that declare an endpoint in a known
framework syntax). Route hints are hints, not proof: `inventory.route_hints[].matched` says whether a page from the
spec or the crawl has the same path, so a declared route that nothing reached or documented stands out. To teach it a
framework, add one entry to `ROUTE_PATTERNS` and one line to its unit test.

Two fields exist for packs whose files are not pages:

- top-level `"pages": "none"` (default `"files"`): no source file becomes a page.
- per file, optional `"routes": [{ "method": "GET", "path": "/orders/{id}", "line": 12, "framework": "spring" }]`.

## Invocation (dedicated packs)

`rules/<stack>/` holds a `Dockerfile` and an extractor. scan-repo builds the image (tag `rqa-rules-<stack>:<hash>`,
the hash covering every file in the pack folder) and runs:

    docker run --rm -v <source>:/src:ro -v plugin/rules/<stack>:/rules:ro <image> <command> /src
      [--php-version <v>] [--exclude <dir>]...

The command for each pack is declared in `PACKS` in `plugin/skills/scan-repo/scan.mjs`. The pack must not write
anywhere: the source is mounted read only and the output goes to stdout.

## Output (stdout, one JSON document)

```json
{
  "pack": "php", "pack_version": "1.0.0", "language_version": "7.2",
  "files": [{
    "path": "admin/index.php",            // relative to the source root, forward slashes; sorted by path
    "lines": 120, "parse_error": null,    // a file that fails to parse is listed with the message and no facts
    "includes":     [{ "target": "header.php", "line": 5, "kind": "include" }],
    "session":      [{ "key": "AID", "op": "check|write|read|unset", "line": 7 }],   // key "*" = whole session
    "superglobals": [{ "name": "_POST", "key": "username", "line": 35 }],             // request inputs
    "sql":          [{ "text": "SELECT * FROM admin WHERE username = '?'", "line": 38 }], // dynamic parts as ?
    "uploads":      [{ "line": 9 }],
    "urls":         [{ "url": "https://…", "line": 12, "context": "asset|form-action|html|php|code" }],   // asset = href/src; code = any other use
    "calls":        [{ "name": "password_verify | ->query", "line": 8 }],          // security-relevant calls
    "functions":    [{ "name": "encrypt_e", "line": 3 }],
    "redirects":    [{ "url": "../admin_login.php", "line": 8, "exits": false, "code_follows": true,
                       "preceded_by": [{ "kind": "html|echo|include", "line": 5, "target": "header.php" }] }],
    "js_redirects": [{ "url": "login.php", "line": 40 }],
    "forms":        [{ "line": 52, "action": "login.php", "method": "POST", "enctype": null,
                       "fields": [{ "tag": "input", "name": "username", "type": "text", "required": true,
                                    "maxlength": null, "line": 54 }] }],
    "fields_outside_forms": [],
    "top_level_html_bytes": 6120          // bytes of literal HTML the file sends (decides whether it "outputs")
  }]
}
```

Rules:

- **Facts, not judgments.** No severities and no "vulnerable" flags. The normalizer derives redirect risks, and
  the agents judge.
- **Every fact carries a line number** that `check-citations` can resolve.
- **Deterministic.** The same source gives byte-identical output (sorted files, source-order facts, no timestamps).

## Contract tests (`plugin/tests/contract/`)

Every pack must find, in `plugin/tests/fixtures/mini-shop-<stack>/`, every fact listed in that fixture's
`EXPECTED.md`: pages and includes, session keys with their check and write lines, every SQL statement with its
verb and tables, the upload, the outbound host (and that the asset-only host is not outbound), the login form and
its fields, and the redirect without `exit` after output.
