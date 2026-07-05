import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Run with: k6 run k6/load-test.js
// Default target: http://localhost:3001 (override with K6_BASE_URL env var)

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';
const JWT_TOKEN = __ENV.K6_JWT_TOKEN || '';

const authHeaders = JWT_TOKEN
  ? { Authorization: `Bearer ${JWT_TOKEN}`, 'Content-Type': 'application/json' }
  : { 'Content-Type': 'application/json' };

const healthLatency = new Trend('health_duration_ms');
const datasetLatency = new Trend('dataset_duration_ms');
const errors = new Counter('request_errors');

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // SLO: p95 for all requests < 2s, p99 < 5s
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    // SLO: error rate < 0.5%
    http_req_failed: ['rate<0.005'],
    health_duration_ms: ['p(95)<300'],
    dataset_duration_ms: ['p(95)<800'],
  },
};

export default function () {
  // Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  healthLatency.add(healthRes.timings.duration);
  const healthOk = check(healthRes, { 'health 200': (r) => r.status === 200 });
  if (!healthOk) errors.add(1);

  sleep(0.1);

  // Dataset listing (adjust path to match actual API route)
  const datasetsRes = http.get(`${BASE_URL}/api/datasets`, { headers: authHeaders });
  datasetLatency.add(datasetsRes.timings.duration);
  const datasetsOk = check(datasetsRes, {
    'datasets 200 or 401': (r) => r.status === 200 || r.status === 401,
  });
  if (!datasetsOk) errors.add(1);

  sleep(0.5);
}
