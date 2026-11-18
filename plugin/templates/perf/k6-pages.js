// reverse-qa k6 page test. Pages, base URL, scenario and thresholds come from the environment (set by run-perf), so one
// script serves every target. SCENARIO=smoke: 1 user, a short run; SCENARIO=load: ramp to LOAD_VUS users.
// A baseline measured on one machine, not a capacity figure.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL;
const PAGES = JSON.parse(__ENV.PAGES || '[]');
const URLS = JSON.parse(__ENV.PAGE_URLS || '{}'); // page -> the page with the query a user arrives with (target.yaml page_params)
const SCENARIO = __ENV.SCENARIO || 'smoke';
const DURATION = __ENV.DURATION || (SCENARIO === 'smoke' ? '30s' : '2m');
const VUS = Number(__ENV.LOAD_VUS || 10);

export const options = {
  scenarios: {
    pages:
      SCENARIO === 'smoke'
        ? { executor: 'constant-vus', vus: 1, duration: DURATION }
        : { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '20s', target: VUS }, { duration: DURATION, target: VUS }, { duration: '10s', target: 0 }] },
  },
  thresholds: {
    http_req_failed: [`rate<${Number(__ENV.MAX_ERROR_RATE || 0.01)}`],
    http_req_duration: [`p(95)<${Number(__ENV.P95_MS || 800)}`],
    checks: ['rate>0.99'],
    // one threshold per page makes k6 report each page's own numbers (sub-metrics exist only for thresholds)
    ...Object.fromEntries(PAGES.map((p) => [`http_req_duration{page:${p}}`, [`p(95)<${Number(__ENV.P95_MS || 800)}`]])),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

export default function () {
  for (const page of PAGES) {
    const res = http.get(`${BASE}${URLS[page] || page}`, { tags: { page }, redirects: 0 });
    check(res, { 'no server error': (r) => r.status > 0 && r.status < 500 });
    sleep(0.5);
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE || 'summary.json']: JSON.stringify(data, null, 2) };
}
