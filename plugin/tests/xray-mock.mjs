// A local stand-in for Xray Cloud's REST v2 endpoints (shapes from Xray's official Postman collection), so the client,
// the MCP server and publish-xray are tested without a real Jira site or credentials.
import http from 'node:http';

export async function startMockXray({ failElements = [], token = 'tok-123' } = {}) {
  const calls = [];
  let polls = 0;
  let lastBulk = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = req.headers['content-type']?.includes('json') && text ? JSON.parse(text) : text;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/v2/authenticate' && req.method === 'POST') {
      return body.client_id === 'id' && body.client_secret === 'secret' ? send(200, token) : send(401, { error: 'Authentication failed' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    if (req.url === '/api/v2/import/test/bulk' && req.method === 'POST') {
      lastBulk = body;
      polls = 0;
      return send(200, { jobId: 'job-1' });
    }
    if (req.url === '/api/v2/import/test/bulk/job-1/status') {
      polls++;
      if (polls < 2) return send(200, { status: 'working', progress: [] });
      const errors = failElements.map((n) => ({ elementNumber: n, errors: { summary: 'rejected by mock' } }));
      const issues = lastBulk.map((_, i) => i).filter((i) => !failElements.includes(i)).map((i) => ({ id: String(1000 + i), key: `QA-${101 + i}`, self: '' }));
      return send(200, { status: errors.length ? 'partially_successful' : 'successful', result: { issues, errors } });
    }
    if (req.url === '/api/v2/import/execution' && req.method === 'POST') return send(200, { id: '9000', key: 'QA-900', self: '' });
    if (req.url === '/api/v2/graphql' && req.method === 'POST') {
      return send(200, { data: { getTests: { total: 1, results: [{ issueId: '1000', jira: { key: 'QA-101', summary: 'Existing test' }, testType: { name: 'Manual' } }] } } });
    }
    return send(404, { error: `no mock for ${req.method} ${req.url}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/api/v2`, calls, close: () => new Promise((r) => server.close(r)) };
}
