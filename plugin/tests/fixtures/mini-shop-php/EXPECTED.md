# mini-shop-php — planted facts (the answer key)

A tiny PHP shop used to test reverse-qa's scripts and agents. Tests assert these facts; change them only together.

- Pages: `index.php`, `login.php`, `cart.php`, `checkout.php`, `admin/products.php`, `admin/report.php`.
- Includes: `db.php` (connection), `admin/header.php` (HTML only, included by `admin/report.php` line 3).
- Roles (3):
  - Visitor: `index.php`, `login.php`
  - Customer: session key `UID`, set at `login.php` line 9; checked at `cart.php` line 3 and `checkout.php` line 3
  - Admin: session key `ADMIN`, checked at `admin/products.php` line 3 and `admin/report.php` line 4
- Tables: `users`, `products`, `cart`, `orders` (`schema.sql`; `seed.sql` holds users 2, products 3, cart 0, orders 0).
  Foreign keys: `cart.user_id → users.id`, `cart.product_id → products.id`, `orders.user_id → users.id`.
- Purchase flow:
  1. `cart.php` line 9 inserts into `cart`.
  2. `checkout.php` line 9 inserts into `orders` (reading `cart` and `products`).
  3. `checkout.php` line 10 deletes from `cart`.
  4. The form posts to `https://pay.example.test/process`.
- Upload: `admin/products.php` line 9 (`move_uploaded_file`).
- Admin write: `admin/products.php` line 14 updates `products`.
- Outbound host: `pay.example.test` (`checkout.php` line 12). Asset host only: `cdn.example.test` (`admin/header.php`).
- Login form: `login.php` line 16, POST to `login.php`, fields `email`, `password`.
- Redirects: every guard redirect exits (`cart.php` 4, `checkout.php` 4, `admin/products.php` 4), **except**
  `admin/report.php` line 5, which has no `exit` and runs after `admin/header.php` has output 225 bytes of HTML.
  With `output_buffering = 4096` those bytes are still buffered, so the 302 is sent, but the script keeps running and
  the order count and revenue go out **in the body of the 302** (execution after redirect: kinds
  `execution-after-redirect`, not `headers-already-sent`). Confirmed at runtime by `tests/integration/runtime.test.mjs`.
  (The other variant, seen on a real app: 6,761 bytes of output exceed the buffer, so PHP cannot send
  the redirect at all and the page is served with HTTP 200.)
