// A 30-line router for the mini-api fixture: app.get/post(path, handler) with :name path parameters and a JSON body.
export function createApp() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:[A-Za-z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; })}$`);
    routes.push({ method, re, names, handler });
  };
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) {
      res.writeHead(routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'the body is not JSON' }));
    }
    const m = url.pathname.match(route.re);
    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    return route.handler(req, res, { params, body, query: url.searchParams });
  };
  return { get: add('GET'), post: add('POST'), handle };
}
