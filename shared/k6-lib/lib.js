// Shared k6 helpers. Import from a project's load script:
//   import { thresholds, partner, ramp } from '../../../shared/k6-lib/lib.js';
// Scripts run inside the k6 container, where services are reachable by name
// (http://hello:8000, http://app:8000, http://fake-partner:8080, http://nginx, ...).
import http from 'k6/http';
import { check } from 'k6';

export const PARTNER_URL = __ENV.PARTNER_URL || 'http://fake-partner:8080';

// The lab's default bar: under 1% errors and p99 under 300 ms. Projects tighten or loosen it.
export function thresholds({ p99 = 300, p95, errorRate = 0.01, abort = false } = {}) {
  const duration = [`p(99)<${p99}`];
  if (p95) duration.push(`p(95)<${p95}`);
  return {
    http_req_failed: [{ threshold: `rate<${errorRate}`, abortOnFail: abort, delayAbortEval: '10s' }],
    http_req_duration: duration,
  };
}

// Open-model ramp: requests per second, independent of how slow the server gets
// (a closed model with fixed VUs hides overload by sending less).
export function ramp({ from = 10, to = 1000, duration = '2m', hold = '30s', maxVUs = 2000 } = {}) {
  return {
    executor: 'ramping-arrival-rate',
    startRate: from,
    timeUnit: '1s',
    preAllocatedVUs: Math.min(maxVUs, Math.max(50, to)),
    maxVUs,
    stages: [
      { target: to, duration },
      { target: to, duration: hold },
    ],
  };
}

export function constantRate({ rate = 100, duration = '30s', maxVUs = 1000 } = {}) {
  return {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Math.min(maxVUs, Math.max(20, rate)),
    maxVUs,
  };
}

// Change the fake partner's knobs, e.g. in setup(): partner({ latencyMs: 100, rateLimitRps: 20 }).
export function partner(knobs) {
  const res = http.post(`${PARTNER_URL}/admin/config`, JSON.stringify(knobs), { headers: { 'content-type': 'application/json' } });
  check(res, { 'partner config accepted': (r) => r.status === 200 }) || console.error(`partner config rejected: ${res.body}`);
  return res.json();
}

export function resetPartner() {
  return http.post(`${PARTNER_URL}/admin/reset`).json();
}

export function json(body) {
  return { body: JSON.stringify(body), params: { headers: { 'content-type': 'application/json' } } };
}

export function uuid() {
  return crypto.randomUUID();
}

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// Zipf-distributed integer in [1, n]: a few values are very hot, most are cold
// (hot links in Project 11, hot customers for cache tests). Higher s = more skew.
export function zipf(n, s = 1.1) {
  if (!zipf.cache || zipf.cache.n !== n || zipf.cache.s !== s) {
    const cdf = new Float64Array(n);
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += 1 / Math.pow(i, s);
    let acc = 0;
    for (let i = 1; i <= n; i++) {
      acc += 1 / Math.pow(i, s) / sum;
      cdf[i - 1] = acc;
    }
    zipf.cache = { n, s, cdf };
  }
  const { cdf } = zipf.cache;
  const u = Math.random();
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}
