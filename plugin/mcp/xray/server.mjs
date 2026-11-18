#!/usr/bin/env node
// reverse-qa Xray MCP server (stdio). Xray has no official MCP server (request XRAY-11040, still under review in
// June 2026), so the plugin ships this small one. Tools:
//   xray_status            settings in use, without secrets
//   xray_validate_tests    check a bulk-import payload against Xray's format (offline)
//   xray_find_tests        existing tests by JQL, to avoid duplicates (needs credentials)
//   xray_import_tests      dry run by default; a real import needs the preview_id the dry run returned
//   xray_import_results    same two steps for execution results (Xray JSON)
// Credentials come from XRAY_CLIENT_ID / XRAY_CLIENT_SECRET (the plugin's sensitive userConfig). Without them the
// server runs offline: validate and dry runs only.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { XrayClient, configFromEnv, describeConfig, previewTests, publishTests, previewResults, publishResults } from './core.mjs';
import { validateBulkTests } from '../../lib/xray.mjs';

const cfg = configFromEnv();
const client = new XrayClient(cfg);
const server = new McpServer({ name: 'reverse-qa-xray', version: '0.1.0' });

const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });

/** A payload given inline, or a path to a JSON file (e.g. targets/<t>/output/xray/xray-tests.json). */
function payload({ file, json }) {
  if (json !== undefined) return typeof json === 'string' ? JSON.parse(json) : json;
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  throw new Error('give either file (a path to a JSON file) or json');
}

const source = { file: z.string().optional().describe('Path to a JSON file'), json: z.any().optional().describe('The payload itself') };

server.registerTool('xray_status', { description: 'Show the Xray settings this server uses (base URL, project key, whether credentials are set). Never shows secrets.', inputSchema: {} }, async () =>
  reply(describeConfig(cfg)),
);

server.registerTool(
  'xray_validate_tests',
  { description: "Validate an Xray Cloud bulk-import payload (Manual/Cucumber/Generic tests, requirement links) against Xray's documented format. Offline; changes nothing.", inputSchema: source },
  async (args) => {
    try {
      const problems = validateBulkTests(payload(args));
      return reply({ valid: problems.length === 0, problems });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xray_find_tests',
  { description: 'Find existing Xray tests by JQL (for example: project = QA AND labels = reverse-qa) so new cases do not duplicate them. Read-only; needs credentials.', inputSchema: { jql: z.string(), limit: z.number().int().min(1).max(100).optional() } },
  async ({ jql, limit }) => {
    try {
      return reply(await client.findTests(jql, limit ?? 100));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xray_import_tests',
  {
    description:
      'Import tests into Xray. With dry_run (the default) it only validates and returns a preview_id. A real import needs dry_run=false and that exact preview_id, and must only happen after the person running reverse-qa has confirmed the dry-run summary.',
    inputSchema: { ...source, dry_run: z.boolean().optional(), preview_id: z.string().optional() },
  },
  async ({ dry_run = true, preview_id, ...args }) => {
    try {
      const tests = payload(args);
      if (dry_run) return reply({ dry_run: true, ...previewTests(tests) });
      return reply({ dry_run: false, ...(await publishTests(client, tests, preview_id)) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'xray_import_results',
  {
    description: 'Import execution results (Xray JSON) into a new Test Execution. Dry run by default; a real import needs dry_run=false, the preview_id from the dry run, and the person\'s confirmation.',
    inputSchema: { ...source, dry_run: z.boolean().optional(), preview_id: z.string().optional() },
  },
  async ({ dry_run = true, preview_id, ...args }) => {
    try {
      const results = payload(args);
      if (dry_run) return reply({ dry_run: true, ...previewResults(results) });
      return reply({ dry_run: false, ...(await publishResults(client, results, preview_id)) });
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
