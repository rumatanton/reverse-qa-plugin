// Running a target: the safety rule on hosts, waiting for HTTP health, and reading the server log from the app
// container (logs live in a named volume, not a host folder). The log is whatever target.yaml names
// (runtime.error_log); its lines are classed by the stack's patterns, or by runtime.error_patterns.
import { compose } from './docker.mjs';
import { packFor, serverLogPath } from './platform.mjs';

export { serverLogPath };

// What a server error looks like in a log, per stack. `label` names it in a test failure; `sample.warning` is a line
// in that format the framework's self-test writes and reads back.
const PHP_PATTERNS = { fatal: /PHP (Fatal|Parse) error|Uncaught/i, warning: /PHP Warning/i, notice: /PHP Notice/i, deprecated: /PHP Deprecated/i, label: 'PHP fatal error', sample: { warning: '[01-Jan-2026 00:00:00 UTC] PHP Warning:  rqa selftest' } };
const GENERIC_PATTERNS = { fatal: /\b(ERROR|SEVERE|FATAL|CRITICAL)\b|\b[\w.$]*(Exception|Error)\b:|Traceback \(most recent call last\)|^panic:|Unhandled (exception|rejection)/, warning: /\bWARN(ING)?\b/, notice: null, deprecated: /\bdeprecat/i, label: 'Server error', sample: { warning: '2026-01-01 00:00:00 WARN rqa selftest' } };
const CLASSES = ['fatal', 'warning', 'notice', 'deprecated'];

/**
 * The log patterns of a target: PHP's for a PHP stack, the generic ones (ERROR, SEVERE, an exception or a traceback)
 * for every other, each class replaceable in target.yaml: runtime.error_patterns: { fatal: ["regex", ...] }.
 */
export function logPatterns(def) {
  const out = { ...(packFor(def.source?.stack) === 'php' ? PHP_PATTERNS : GENERIC_PATTERNS) };
  for (const k of CLASSES) {
    const custom = def.runtime?.error_patterns?.[k];
    if (custom) out[k] = new RegExp([custom].flat().join('|'));
  }
  return out;
}

/** How a logged server error is named in a test failure ("PHP fatal error", "Server error"). */
export const serverErrorLabel = (def) => logPatterns(def).label;

/** Class the lines of a server log: { fatal, warning, notice, deprecated, other }, each a list of lines. */
export function classifyServerLog(text, patterns = PHP_PATTERNS) {
  const out = { fatal: [], warning: [], notice: [], deprecated: [], other: [] };
  for (const line of text.split('\n').filter((l) => l.trim())) out[CLASSES.find((c) => patterns[c]?.test(line)) ?? 'other'].push(line);
  return out;
}

/** The app container's server log ('' when none is configured or it does not exist yet). */
export function serverLog(target, service) {
  const p = serverLogPath(target.def);
  if (!p) return '';
  const r = compose(target, ['exec', '-T', service, 'sh', '-c', `cat ${p} 2>/dev/null || true`]);
  return r.status === 0 ? r.stdout : '';
}

/** Empty the server log so a run starts clean. */
export function truncateServerLog(target, service) {
  const p = serverLogPath(target.def);
  if (p) compose(target, ['exec', '-T', service, 'sh', '-c', `: > ${p}; chown www-data:www-data ${p} 2>/dev/null || true`]);
}

/** Throw unless every URL's host is in safety.allowed_test_hosts and none is in safety.never_test. */
export function assertSafeUrls(def, urls) {
  const allowed = new Set((def.safety?.allowed_test_hosts ?? ['localhost', '127.0.0.1']).map((h) => h.toLowerCase()));
  const never = new Set((def.safety?.never_test ?? []).map((h) => h.toLowerCase()));
  for (const u of urls.filter(Boolean)) {
    if (new URL(u).protocol === 'file:') continue; // a desktop app's own files on this machine: there is no host to reach
    const host = new URL(u).hostname.toLowerCase();
    if (never.has(host)) throw new Error(`refusing ${u}: ${host} is listed in safety.never_test`);
    if (!allowed.has(host)) throw new Error(`refusing ${u}: ${host} is not in safety.allowed_test_hosts`);
  }
}

/** The app service and URL for the default run or the upgrade (second PHP version) run. */
export function appVariant(def, { upgrade = false } = {}) {
  const s = def.runtime?.services ?? {};
  if (upgrade) {
    if (!s.app_upgrade || !def.runtime?.upgrade_base_url) throw new Error('target.yaml has no runtime.services.app_upgrade / runtime.upgrade_base_url');
    return { service: s.app_upgrade, baseUrl: def.runtime.upgrade_base_url, profiles: def.runtime.upgrade_profiles ?? ['php8'] };
  }
  return { service: s.app ?? 'web', baseUrl: def.runtime?.base_url, profiles: [] };
}

export function healthUrl(def, baseUrl) {
  return new URL(def.runtime?.health_path ?? '', baseUrl).href;
}

/** Poll url until it answers with an expected status. Resolves { status, ms, attempts }; rejects on timeout. */
export async function waitForHttp(url, { timeoutMs = 180_000, intervalMs = 1000, expect = [200] } = {}) {
  const start = Date.now();
  let attempts = 0;
  let last = 'no response';
  while (Date.now() - start < timeoutMs) {
    attempts++;
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, intervalMs * 5)) });
      if (expect.includes(res.status)) return { status: res.status, ms: Date.now() - start, attempts };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.cause?.code ?? err.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${url} not healthy after ${timeoutMs} ms (${attempts} attempts, last: ${last})`);
}

/** The app container's PHP error log ('' when it does not exist yet). */
export function phpErrorLog(target, service) {
  const path = target.def.runtime?.php_error_log ?? '/var/log/php/error.log';
  const r = compose(target, ['exec', '-T', service, 'sh', '-c', `cat ${path} 2>/dev/null || true`]);
  return r.status === 0 ? r.stdout : '';
}

/** Empty the PHP error log so a run starts clean. */
export function truncatePhpLog(target, service) {
  const path = target.def.runtime?.php_error_log ?? '/var/log/php/error.log';
  compose(target, ['exec', '-T', service, 'sh', '-c', `: > ${path}; chown www-data:www-data ${path} 2>/dev/null || true`]);
}

/** Classify PHP log lines: { fatal, warning, notice, deprecated, other } with the lines themselves. */
export function classifyPhpLog(text) {
  const out = { fatal: [], warning: [], notice: [], deprecated: [], other: [] };
  for (const line of text.split('\n').filter((l) => l.trim())) {
    if (/PHP (Fatal|Parse) error|Uncaught/i.test(line)) out.fatal.push(line);
    else if (/PHP Warning/i.test(line)) out.warning.push(line);
    else if (/PHP Notice/i.test(line)) out.notice.push(line);
    else if (/PHP Deprecated/i.test(line)) out.deprecated.push(line);
    else out.other.push(line);
  }
  return out;
}
