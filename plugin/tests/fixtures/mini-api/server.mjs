// mini-api: a tiny JSON API used to test reverse-qa on an app that has no pages (see EXPECTED.md for the planted
// facts). No dependencies: `node server.mjs` listens on PORT (default 8095). Data lives in memory and is reset by
// POST /test/reset, which only exists when MINI_API_TEST=1.
import http from 'node:http';
import { createApp } from './router.mjs';

const PAYMENT_URL = 'https://pay.example.test/charge';

const seed = () => ({
  users: [
    { id: 1, email: 'ann@example.test', password: 'demo-pass-1', role: 'customer' },
    { id: 2, email: 'bob@example.test', password: 'demo-pass-2', role: 'customer' },
    { id: 3, email: 'admin@example.test', password: 'demo-pass-3', role: 'admin' },
  ],
  products: [
    { id: 1, name: 'Notebook', price: 4 },
    { id: 2, name: 'Pen', price: 1 },
  ],
  orders: [{ id: 1, user_id: 2, product_id: 1, qty: 2 }],
  tokens: new Map(),
});
let db = seed();

const app = createApp();
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const userOf = (req) => db.tokens.get((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')) ?? null;
const needUser = (req, res) => {
  const user = userOf(req);
  if (!user) send(res, 401, { error: 'log in first' });
  return user;
};

app.get('/health', (req, res) => send(res, 200, { ok: true }));

app.post('/login', (req, res, { body }) => {
  const user = db.users.find((u) => u.email === body.email && u.password === body.password);
  if (!user) return send(res, 401, { error: 'wrong email or password' });
  const token = `t${user.id}-${Math.random().toString(36).slice(2)}`;
  db.tokens.set(token, user);
  return send(res, 200, { token, role: user.role });
});

app.get('/products', (req, res) => send(res, 200, db.products));

app.get('/products/:id', (req, res, { params }) => {
  const p = db.products.find((x) => x.id === Number(params.id));
  return p ? send(res, 200, p) : send(res, 404, { error: 'no such product' });
});

app.get('/orders', (req, res) => {
  const user = needUser(req, res);
  if (user) send(res, 200, db.orders.filter((o) => o.user_id === user.id));
});

app.post('/orders', (req, res, { body }) => {
  const user = needUser(req, res);
  if (!user) return undefined;
  if (!db.products.some((p) => p.id === Number(body.product_id)) || !(Number(body.qty) > 0)) return send(res, 400, { error: 'product_id and a positive qty are required' });
  const order = { id: db.orders.length + 1, user_id: user.id, product_id: Number(body.product_id), qty: Number(body.qty) };
  db.orders.push(order);
  return send(res, 201, order);
});

// Planted defect: any logged-in user reads any order (no check that the order is theirs).
app.get('/orders/:id', (req, res, { params }) => {
  const user = needUser(req, res);
  if (!user) return undefined;
  const order = db.orders.find((o) => o.id === Number(params.id));
  return order ? send(res, 200, order) : send(res, 404, { error: 'no such order' });
});

app.get('/admin/report', (req, res) => {
  const user = needUser(req, res);
  if (!user) return undefined;
  if (user.role !== 'admin') return send(res, 403, { error: 'admins only' });
  return send(res, 200, { orders: db.orders.length, revenue: db.orders.reduce((n, o) => n + o.qty * db.products.find((p) => p.id === o.product_id).price, 0) });
});

// Planted fact: not in openapi.yaml, and open to everyone.
app.get('/debug/config', (req, res) => send(res, 200, { payment_url: PAYMENT_URL, test_mode: process.env.MINI_API_TEST === '1' }));

if (process.env.MINI_API_TEST === '1') {
  app.post('/test/reset', (req, res) => {
    db = seed();
    send(res, 200, { reset: true });
  });
}

const port = Number(process.env.PORT ?? 8095);
http.createServer(app.handle).listen(port, '127.0.0.1', () => process.stdout.write(`mini-api listening on http://127.0.0.1:${port}\n`));
