# target.yaml reference

`targets/<app>/target.yaml` is the only app-specific input the plugin reads. It states what only a person knows:
where the app is and how to reach it. Everything the app *does* is discovered by `/reverse-qa:recon`.

`init-target` writes this file for you with the blocks that apply and marks what needs you with `TODO`. Most apps
need nothing more than that plus their test accounts. The example below is the full set, for a PHP web app the plugin
starts itself from a compose file. Every block except `name`, `app` and `source` is optional.

```yaml
name: my-shop
description: Online shop with customer and admin areas and a card checkout. No documentation.
repo: https://example.test/my-org/my-shop      # optional, for the reports
commit: 0123abc                                 # optional: the commit every scan, citation and test is tied to

app:
  kind: web                    # web | api | mobile | desktop
  # driver: electron           # desktop apps built with Electron

source:
  dir_env: TARGET_DIR          # absolute path of the source, set in targets/my-shop/.env; the plugin only reads it
  stack: php                   # php selects the dedicated pack; any other value is read by the generic pack
  scan_exclude: [.git, images] # folders the scan skips (binary assets, generated code)
  seed_dump: seed.sql          # relative to the source; imported into a fresh database

runtime:
  base_url: http://localhost:8080/
  health_path: index.php       # a page that answers when the app is up
  compose_file: docker-compose.yml   # relative to targets/my-shop/; lets the plugin start, stop and reset the app
  services:
    app: web                   # the compose service that serves the app
    db: db                     # the compose service of the database
    app_upgrade: web-next      # a second runtime, for the upgrade comparison
  upgrade_base_url: http://localhost:8081/
  upgrade_profiles: [next]     # compose profiles that start the second runtime
  error_log: /var/log/app/error.log   # a server log inside the app container, watched during tests
  app_root: /var/www/html      # the app inside the container
  writable_dirs: [uploads]     # where the app stores uploads; clean-up removes files the tests add here

api:
  openapi: openapi.yaml        # a file in the source or a URL; endpoints are read from this spec

database:                      # lets tests reset the data, snapshot rows and check database effects
  engine: mariadb:10.4
  name: shop
  user: root

test_accounts:                 # values live in .env, never in tracked files
  admin:
    role: Admin
    user_env: ADMIN_USER
    password_env: ADMIN_PASSWORD
    login: { path: admin/login.php, user_field: username, password_field: password }
  customer:
    role: Customer
    user_env: CUSTOMER_EMAIL
    password_env: CUSTOMER_PASSWORD
    login: { path: login.php, user_field: email, password_field: password }
    register:                  # global setup signs up a new customer each run; clean-up deletes the row afterwards
      path: register.php
      user_field: email
      fields: { name: "rqa{run}", email: "rqa-{run}@example.test", password: "{password}" }

integrations:
  - name: Card gateway
    kind: payment-gateway
    outbound_hosts: [pay.example.test]
    test_policy: stub          # tests intercept these hosts; the real gateway is never called

perf:                          # run-perf (k6): a baseline on this machine, not capacity
  pages: [index.php, products.php, login.php]
  thresholds: { p95_ms: 800, max_error_rate: 0.01, load_vus: 10 }
  long_query_time_s: 0.1

page_params:                   # the query a user arrives with on a detail page; page tests open the page this way
  product.php: { query: id=1 }

xray:                          # test management (export-xray, publish-xray)
  project_key: ""              # the Jira project for the tests; empty = offline
  test_repository_path: reverse-qa/my-shop

jira:
  project_key: ""              # a project whose stories the analysts may match to requirements (read only)

safety:
  allowed_test_hosts: [localhost, 127.0.0.1]   # tests, scanners and load runs may only reach these hosts
  never_test: [shop.example.com]               # production hosts, so no test can ever reach them
  mask_personal_data:          # when a seed holds real people's data: masked after every reset, so no screenshot,
    sql:                       # video, trace or report ever shows it
      - "UPDATE customer SET name = CONCAT('customer', id), email = CONCAT('customer', id, '@example.test'), password = 'masked'"
    check: "SELECT COUNT(*) FROM customer WHERE email NOT LIKE '%@example.test'"   # must be 0
```

## Notes

- **A JSON login** (an API, or a web app with a token): `login: { path: login, json: { email: "{user}", password:
  "{password}" }, token: token, header: Authorization, scheme: Bearer }`.
- **No compose file:** the app is reached by URL and must already be running. There is then no database reset, row
  snapshot or server log watch, and the run says what it could not clean.
- **A compose file of your own:** `plugin/tests/fixtures/targets/mini-shop/docker-compose.yml` is a small working
  one (PHP + Apache from `plugin/templates/runtime/php-apache`, MariaDB), and a starting point.
- **A desktop app built with Electron:** `init-target` writes `app.driver: electron` and `runtime.app.start_page`
  instead of a URL; see `plugin/templates/DRIVERS.md`.
- `init-target --doctor --target <app>` checks the file and the prerequisites and names what is missing.
- Each skill's own settings are described in its `plugin/skills/<skill>/SKILL.md`.
