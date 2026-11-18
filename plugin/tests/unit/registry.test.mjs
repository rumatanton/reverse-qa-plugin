// Smoke test: the plugin tree matches this frozen registry. Adding or renaming a skill, agent, hook or MCP server means
// updating the registry on purpose, which catches drift and typoed paths (FILE-TREE-PATTERN "Testing").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN, frontmatter } from '../helpers.mjs';

const SKILLS = ['build-report', 'build-rtm', 'build-stories', 'check-citations', 'coverage-report', 'crawl-app', 'db-reset', 'db-snapshot', 'export-xray', 'init-target', 'publish-bugs', 'publish-xray', 'recon', 'review-gate', 'run-mutation', 'run-perf', 'run-security-scans', 'run-suites', 'run-target-app', 'run-upgrade-compare', 'scaffold-framework', 'scan-repo', 'security-second-opinion', 'triage-failures'];
const AGENTS = { 'tech-analyst': 'opus', 'workflow-analyst': 'opus', 'test-designer': 'sonnet', 'bug-reporter': 'sonnet' };
const FILES = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'skills/recon/workflow.md',
  'skills/recon/conventions.md',
  'skills/review-gate/review.mjs',
  'lib/review.mjs',
  'skills/run-mutation/mutate.mjs',
  'lib/mutation.mjs',
  'lib/testtypes.mjs',
  'skills/recon/test-types.yaml',
  'skills/check-citations/check.mjs',
  'skills/scan-repo/scan.mjs',
  'skills/run-target-app/run.mjs',
  'skills/db-reset/reset.mjs',
  'skills/db-snapshot/snapshot.mjs',
  'skills/export-xray/export.mjs',
  'skills/publish-xray/publish.mjs',
  'skills/coverage-report/coverage.mjs',
  'skills/build-rtm/rtm.mjs',
  'skills/build-stories/stories.mjs',
  'skills/init-target/init.mjs',
  'skills/crawl-app/crawl.mjs',
  'templates/DRIVERS.md',
  'templates/framework/crawl/crawl.spec.ts',
  'lib/platform.mjs',
  'lib/openapi.mjs',
  'lib/crawl.mjs',
  'rules/generic/extract.mjs',
  'skills/triage-failures/triage.mjs',
  'skills/build-report/report.mjs',
  'lib/pwreport.mjs',
  'lib/cleanup.mjs',
  'lib/pages.mjs',
  'lib/bugs.mjs',
  'skills/publish-bugs/publish.mjs',
  'skills/run-perf/perf.mjs',
  'skills/run-security-scans/security.mjs',
  'skills/security-second-opinion/second.mjs',
  'skills/run-upgrade-compare/compare.mjs',
  'templates/perf/k6-pages.js',
  'lib/yaml.mjs',
  'skills/scaffold-framework/scaffold.mjs',
  'skills/run-suites/run.mjs',
  'templates/framework/package.json',
  'templates/framework/playwright.config.ts',
  'templates/framework/support/fixtures.ts',
  'templates/framework/support/global-teardown.ts',
  'hooks/hooks.json',
  'hooks/protect-target.mjs',
  'hooks/ensure-deps.mjs',
  'lib/target.mjs',
  'lib/citations.mjs',
  'lib/csv.mjs',
  'lib/db.mjs',
  'lib/docker.mjs',
  'lib/inventory.mjs',
  'lib/ledger.mjs',
  'lib/runtime.mjs',
  'lib/sqldump.mjs',
  'lib/xray.mjs',
  'mcp/xray/server.mjs',
  'mcp/xray/core.mjs',
  'rules/CONTRACT.md',
  'rules/php/Dockerfile',
  'rules/php/composer.json',
  'rules/php/composer.lock',
  'rules/php/extract.php',
  'templates/runtime/php-apache/Dockerfile',
  'templates/runtime/php-apache/php-overrides.ini',
];

// Atlassian's documented tool groups (support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools, 2026-11-09).
const ATLASSIAN_READ = new Set([
  'getJiraIssue', 'listJiraProjects', 'listJiraProjectIssueTypesMetadata', 'getJiraIssueTypeMetaWithFields', 'listJiraIssueLinkTypes',
  'searchJiraIssuesUsingJql', 'atlassianUserInfo', 'getAccessibleAtlassianResources',
]);
const ATLASSIAN_WRITE = /^(create|edit|transition|addOrEdit|manage|watch|upload|delete|update|convert|execute(Write|Destructive))/;
const XRAY_WRITE = new Set(['xray_import_tests', 'xray_import_results']);

const agentFm = (name) => YAML.parse(frontmatter(fs.readFileSync(path.join(PLUGIN, 'agents', `${name}.md`), 'utf8')));
const toolsOf = (fm) => String(fm.tools).split(',').map((t) => t.trim());

test('every registered file exists', () => {
  for (const f of FILES) assert.ok(fs.existsSync(path.join(PLUGIN, f)), `missing ${f}`);
});

test('skills on disk are exactly the registered ones, each with name and description', () => {
  const onDisk = fs.readdirSync(path.join(PLUGIN, 'skills')).filter((d) => fs.existsSync(path.join(PLUGIN, 'skills', d, 'SKILL.md'))).sort();
  assert.deepEqual(onDisk, SKILLS);
  for (const s of SKILLS) {
    const fm = YAML.parse(frontmatter(fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8')));
    assert.equal(fm.name, s, `skills/${s}: frontmatter name must match the folder`);
    assert.ok(fm.description && fm.description.length > 40, `skills/${s}: description too short to trigger reliably`);
  }
});

// A lesson opens with the name of the fix in bold, two to six words, so a person can scan the list and read only the
// names. The account written for the agent follows it: the date, the person who ran it and confirmed the fix, what
// failed, why, and the rule since after a bold "Rule:" (the second thing a person scans for). The section is the
// skill's or the agent's memory, so a lesson nobody put a name to is refused. A standing rule that came from no single
// failure (agent files only) has the name of the fix and the person's name, and no date.
const LESSON_FORM = '"- **Name of the fix.** YYYY-MM-DD, Name: what failed ... **Rule:** ..."';
const PERSON = "[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*)?";
function assertLesson(line, where, { dated }) {
  const m = line.match(/^- \*\*([^*]+)\.\*\* (.+)$/);
  assert.ok(m, `${where}: a lesson starts with the name of the fix in bold, ${LESSON_FORM}: ${line.slice(0, 80)}`);
  const words = m[1].trim().split(/\s+/).length;
  assert.ok(words >= 2 && words <= 6, `${where}: the name of the fix is two to six words, this one has ${words}: "${m[1]}"`);
  if (dated || /^\d{4}-/.test(m[2])) {
    assert.match(m[2], new RegExp(`^\\d{4}-\\d{2}-\\d{2}, ${PERSON}: `), `${where}: after the name a lesson gives the date and who confirmed the fix, ${LESSON_FORM}: ${line.slice(0, 80)}`);
    assert.match(m[2], / \*\*Rule:\*\* \S/, `${where}: the rule follows a bold "Rule:", ${LESSON_FORM}: ${line.slice(0, 80)}`);
  } else {
    assert.match(m[2], new RegExp(`^${PERSON}: `), `${where}: a standing rule names who set it, "- **Name of the fix.** Name: the rule": ${line.slice(0, 80)}`);
  }
}
const lessonBullets = (section) => section.split(/\r?\n/).filter((l) => l.startsWith('- ') && l !== '- None yet.');

test('a lesson without the name of its fix in bold, the person who confirmed it, or a bold rule is refused', () => {
  const ok = '- **Dump over stdin.** 2026-11-09, Anton: the import hung. Cause: a bind mount. **Rule:** pipe it.';
  assert.doesNotThrow(() => assertLesson(ok, 'x', { dated: true }));
  assert.doesNotThrow(() => assertLesson('- **Fresh customer per run.** Anton: Never log in as a seeded customer.', 'x', { dated: false }));
  assert.throws(() => assertLesson('- 2026-11-09, Anton: the import hung. **Rule:** pipe it.', 'x', { dated: true }), /name of the fix in bold/);
  assert.throws(() => assertLesson('- **Stdin.** 2026-11-09, Anton: the import hung. **Rule:** pipe it.', 'x', { dated: true }), /two to six words/);
  assert.throws(() => assertLesson('- **Pipe the dump to mysql over stdin every time.** 2026-11-09, Anton: it hung. **Rule:** pipe it.', 'x', { dated: true }), /two to six words/);
  assert.throws(() => assertLesson('- **Dump over stdin.** 2026-11-09, Anton: the import hung, so pipe it.', 'x', { dated: true }), /bold "Rule:"/);
  assert.throws(() => assertLesson('- **Dump over stdin.** 2026-11-09, Anton: the import hung. Rule: pipe it.', 'x', { dated: true }), /bold "Rule:"/, 'a plain "Rule:" is not enough');
  assert.throws(() => assertLesson('- **Dump over stdin.** 2026-11-09: the import hung. **Rule:** pipe it.', 'x', { dated: true }), /who confirmed the fix/, 'a lesson nobody put a name to');
  assert.throws(() => assertLesson('- **Dump over stdin.** Anton: The import hung. **Rule:** pipe it.', 'x', { dated: true }), /YYYY-MM-DD/, 'a skill lesson is dated');
  assert.throws(() => assertLesson('- **Fresh customer per run.** Never log in as a seeded customer.', 'x', { dated: false }), /names who set it/);
});

test('every SKILL.md ends with a "Lessons from real runs - Memory" section, each lesson named, dated, signed, with its rule', () => {
  for (const s of SKILLS) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    const section = text.split(/\r?\n## Lessons from real runs - Memory\r?\n/)[1]; // a Windows checkout has CRLF line ends
    assert.ok(section !== undefined, `skills/${s}: add a "## Lessons from real runs - Memory" section (failures found while running it go there)`);
    assert.doesNotMatch(section, /\n## /, `skills/${s}: the lessons section comes last`);
    for (const line of lessonBullets(section)) assertLesson(line, `skills/${s}`, { dated: true });
  }
});

test('every agent, ours and Playwright\'s, carries a "Lessons from real runs - Memory" section in the same form', () => {
  const lessonLines = (text, where) => {
    const section = text.split(/\n## Lessons from real runs - Memory[^\n]*\n/)[1];
    assert.ok(section !== undefined, `${where}: add a "Lessons from real runs - Memory" section`);
    for (const line of lessonBullets(section.split(/\n## /)[0])) assertLesson(line, where, { dated: false });
  };
  for (const name of Object.keys(AGENTS)) lessonLines(fs.readFileSync(path.join(PLUGIN, 'agents', `${name}.md`), 'utf8'), `agents/${name}.md`);
  // Playwright's agents are regenerated per target, so their lessons live here and scaffold-framework adds them
  for (const role of ['planner', 'generator', 'healer']) lessonLines(`\n${fs.readFileSync(path.join(PLUGIN, 'skills', 'scaffold-framework', 'agent-lessons', `${role}.md`), 'utf8')}`, `agent-lessons/${role}.md`);
});

test('every script a SKILL.md tells Claude to run exists', () => {
  for (const s of SKILLS) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.mjs)/g)) assert.ok(fs.existsSync(path.join(PLUGIN, m[1])), `skills/${s}: ${m[1]} not found`);
  }
});

test('agents on disk are exactly the registered ones, with name, description, tools and the pinned model', () => {
  const onDisk = fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(onDisk, Object.keys(AGENTS).sort());
  for (const [name, model] of Object.entries(AGENTS)) {
    const fm = agentFm(name);
    assert.equal(fm.name, name);
    assert.equal(fm.model, model, `${name}: model tier changed`);
    assert.ok(fm.description && fm.tools, `${name}: description and tools are required`);
    assert.equal(fm.mcpServers, undefined, `${name}: plugin agents ignore mcpServers; declare servers in .mcp.json`);
  }
});

test('every MCP tool an agent lists exists, and no agent can write to Jira or Xray', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers;
  const xrayTools = new Set([...fs.readFileSync(path.join(PLUGIN, 'mcp', 'xray', 'server.mjs'), 'utf8').matchAll(/registerTool\(\s*'(\w+)'/g)].map((m) => m[1]));
  assert.equal(xrayTools.size, 5);
  for (const name of Object.keys(AGENTS)) {
    for (const t of toolsOf(agentFm(name)).filter((x) => x.startsWith('mcp__'))) {
      const m = t.match(/^mcp__plugin_reverse-qa_([\w-]+)__(\w+)$/);
      assert.ok(m, `${name}: ${t} is not a reverse-qa plugin MCP tool name`);
      const [, server, tool] = m;
      assert.ok(mcp[server], `${name}: server ${server} is not in .mcp.json`);
      if (server === 'xray') {
        assert.ok(xrayTools.has(tool), `${name}: xray tool ${tool} does not exist`);
        assert.ok(!XRAY_WRITE.has(tool), `${name}: must not hold the Xray write tool ${tool}`);
      }
      if (server === 'atlassian') {
        assert.ok(ATLASSIAN_READ.has(tool), `${name}: ${tool} is not a documented Atlassian read or search tool`);
        assert.ok(!ATLASSIAN_WRITE.test(tool), `${name}: must not hold the Atlassian write tool ${tool}`);
      }
    }
  }
});

test('.mcp.json: the official Atlassian server, our Xray server, and no literal secrets', () => {
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcpServers).sort(), ['atlassian', 'xray']);
  assert.equal(mcpServers.atlassian.url, 'https://mcp.atlassian.com/v2/mcp');
  assert.ok(fs.existsSync(path.join(PLUGIN, mcpServers.xray.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''))));
  for (const v of Object.values(mcpServers.xray.env)) assert.match(v, /^\$\{user_config\.\w+\}$/, 'env values come from plugin settings only');
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const k of ['xray_client_id', 'xray_client_secret']) assert.equal(manifest.userConfig[k].sensitive, true, `${k} must be sensitive`);
  for (const ref of Object.values(mcpServers.xray.env).map((v) => v.match(/user_config\.(\w+)/)[1])) assert.ok(manifest.userConfig[ref], `userConfig.${ref} is not declared`);
});

test('hooks.json has the wrapper and every script it runs exists', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(cfg.hooks?.SessionStart && cfg.hooks?.PreToolUse && cfg.hooks?.PostToolUse, 'top-level "hooks" wrapper with all three events');
  const scripts = Object.values(cfg.hooks).flat().flatMap((m) => m.hooks).flatMap((h) => h.args ?? []);
  assert.ok(scripts.length >= 3);
  for (const s of scripts.filter((a) => a.includes('${CLAUDE_PLUGIN_ROOT}'))) {
    const rel = s.replace('${CLAUDE_PLUGIN_ROOT}/', '');
    assert.ok(fs.existsSync(path.join(PLUGIN, rel)), `hook script missing: ${rel}`);
  }
});

test('nothing bind-mounts a host folder (each new folder makes Docker Desktop stop and ask for file-sharing access)', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'tests') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|ts|ya?ml)$/.test(e.name)) files.push(p);
    }
  };
  walk(PLUGIN);
  const composes = [path.join(PLUGIN, '..', 'targets'), path.join(PLUGIN, 'tests', 'fixtures', 'targets')]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).map((t) => path.join(d, t, 'docker-compose.yml')))
    .filter((f) => fs.existsSync(f));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /['"]-v['"]|['"]--volume['"]|['"]--mount['"]/, `${path.relative(PLUGIN, f)} passes a docker volume/mount flag`);
  for (const f of composes) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) assert.doesNotMatch(line, /^\s+-\s+(\.|\/|\$\{|[A-Za-z]:)[^:]*:/, `${f}: host-path volume "${line.trim()}"`);
  }
});

test('plugin.json carries name, version, description and author', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'reverse-qa');
  assert.ok(m.version && m.description && m.author?.name);
  assert.equal(m.author.email, undefined, 'no personal contact data in tracked files');
});
