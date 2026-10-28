// Project 0 done-check: 30 seconds against /hello, then look at the Grafana dashboard.
//   make smoke                 (or: make smoke rate=500)
import http from 'k6/http';
import { check } from 'k6';
import { constantRate, thresholds } from './lib.js';

const BASE_URL = __ENV.BASE_URL || 'http://hello:8000';

export const options = {
  scenarios: { hello: constantRate({ rate: Number(__ENV.RATE || 200), duration: __ENV.DURATION || '30s' }) },
  thresholds: thresholds({ p99: 100 }),
};

export default function () {
  const res = http.get(`${BASE_URL}/hello`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
