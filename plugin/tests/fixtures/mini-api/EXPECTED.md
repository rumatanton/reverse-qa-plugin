# mini-api: planted facts (the answer key)

A tiny JSON API with no pages, used to test reverse-qa on an app the PHP pack cannot read: the generic pack, the
OpenAPI import and the API driver. Tests assert these facts; change them only together.

- Source: `server.mjs`, `router.mjs`, `openapi.yaml`. No database (data in memory), no HTML.
- Stack detected: `unknown` (no project file names a framework), kind `api` (a spec and no page templates).
- Route hints in the code (express-style `app.get` / `app.post`), 10 in `server.mjs`:
  `GET /health`, `POST /login`, `GET /products`, `GET /products/:id`, `GET /orders`, `POST /orders`,
  `GET /orders/:id`, `GET /admin/report`, `GET /debug/config`, `POST /test/reset`.
- OpenAPI spec: 7 paths, 8 operations: `health`, `login`, `products`, `products/{id}`, `orders` (GET and POST),
  `orders/{id}`, `admin/report`.
  - Secured with `bearerAuth`: `orders`, `orders/{id}`, `admin/report`.
  - Path parameter `id` has the example `1` on both templated paths.
  - `POST /orders` body fields: `product_id`, `qty` (through a `$ref`).
- Routes in the code that the spec does not document (hints that match no page): `/debug/config`, `/test/reset`.
- Outbound host: `pay.example.test` (`server.mjs`, the `PAYMENT_URL` constant). Never called by the tests.
- Roles (3): Visitor (no token), Customer (`ann@example.test`, `bob@example.test`), Admin (`admin@example.test`).
  Log in: `POST /login` with a JSON body, the answer carries `token`; send it as `Authorization: Bearer <token>`.
- Planted defect: `GET /orders/{id}` returns any user's order to any logged-in user (order 1 belongs to bob; ann can
  read it). The spec says "one of the caller's orders".
- Planted defect: `GET /debug/config` is open to everyone and is not in the spec.
