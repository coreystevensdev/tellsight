import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check, sleep, fail } from 'k6';
import { Trend } from 'k6/metrics';

// Run with: k6 run k6/load-test.js (K6_BASE_URL to retarget)
//
// NFR16 names four flows: authentication, upload, AI generation, payment. This
// used to exercise none of them. It called GET /api/datasets, but Express has no
// /api prefix (the Next.js BFF strips it before proxying), and authMiddleware
// answers 401 under its whole mount before routing can 404. The script accepted
// 200-or-401, so a request to a path that does not exist counted as a pass.
//
// Generation and payment cannot reach their third party here, since CI boots on
// dummy Claude and Stripe keys. Both are exercised at their read paths instead,
// which is where load actually lands: generation is cache-first, and checkout is
// one POST per upgrade.

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3001';
const JWT_SECRET = __ENV.K6_JWT_SECRET || '';
const DATASET_ID = __ENV.K6_DATASET_ID || '1';
// Defaults match a freshly seeded stack, which is what CI boots. Overridable
// because a database that has had tests run against it moved its sequences on.
const ORG_ID = Number(__ENV.K6_ORG_ID || '1');
const USER_ID = __ENV.K6_USER_ID || '1';

const SAMPLE_CSV = 'date,amount,category\n2026-01-15,1200.00,Revenue\n2026-01-16,450.50,Expenses\n';

const healthLatency = new Trend('health_duration_ms');
const authLatency = new Trend('auth_duration_ms');
const uploadLatency = new Trend('upload_duration_ms');
const summaryLatency = new Trend('summary_duration_ms');
const tierLatency = new Trend('tier_duration_ms');

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // NFR16, the requirement this script exists to prove. No responseCallback
    // anywhere, so a non-2xx counts here instead of being declared expected.
    http_req_failed: ['rate<0.01'],

    // A failing check does not fail a k6 run, only a threshold does. Without
    // this, every check below could fail and the smoke test would still exit 0,
    // which is how the previous version stayed green.
    checks: ['rate>0.99'],

    // Loose, and derived from NFR1's 3s dashboard load: one API call has to
    // leave room for the page around it.
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  },
  // The per-flow trends are reported but not asserted. NFR1-3 cover latency at
  // the dashboard and the stream, and e2e/performance.spec.ts measures those
  // against the real UI. Per-endpoint budgets here would be numbers no
  // requirement backs, and the first slow runner to trip one gets it muted.
};

// Signed here rather than in a helper script because the Docker Smoke Test job
// installs k6 and nothing else. No node_modules, no pnpm, so anything reaching
// for the workspace toolchain fails in CI while passing locally.
function b64url(obj) {
  return encoding.b64encode(JSON.stringify(obj), 'rawurl');
}

function signToken(secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: String(USER_ID),
    org_id: ORG_ID,
    role: 'owner',
    isAdmin: false,
    iat: now,
    exp: now + 1800,
  })}`;
  return `${body}.${crypto.hmac('sha256', secret, body, 'base64rawurl')}`;
}

// Refusing to run beats running against 401s and reporting green, which is how
// the old script kept passing while measuring nothing.
export function setup() {
  if (!JWT_SECRET) {
    fail(
      'K6_JWT_SECRET is required: without it every authenticated flow answers 401 ' +
        'and this script would grade an unauthenticated 401 as a working flow.',
    );
  }
  return { token: signToken(JWT_SECRET) };
}

export default function ({ token }) {
  // A cookie, not a bearer header. authMiddleware reads req.cookies[access_token]
  // and nothing else, so the Authorization header the previous version sent was
  // never going to authenticate.
  const cookie = `access_token=${token}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  const healthRes = http.get(`${BASE_URL}/health`);
  healthLatency.add(healthRes.timings.duration);
  check(healthRes, { 'health 200': (r) => r.status === 200 });

  sleep(0.1);

  const authRes = http.get(`${BASE_URL}/datasets/manage`, { headers });
  authLatency.add(authRes.timings.duration);
  check(authRes, { 'authenticated read 200': (r) => r.status === 200 });

  sleep(0.2);

  // The preview leg only, which parses and validates without writing. Confirm is
  // deliberately left out: it would leave a dataset behind every iteration and
  // change what later iterations read. Cookie only, since k6 sets its own
  // multipart Content-Type with the boundary.
  const uploadRes = http.post(
    `${BASE_URL}/datasets`,
    { file: http.file(SAMPLE_CSV, 'load.csv', 'text/csv') },
    { headers: { Cookie: cookie } },
  );
  uploadLatency.add(uploadRes.timings.duration);
  check(uploadRes, { 'upload preview 200': (r) => r.status === 200 });

  sleep(0.2);

  // The cache-first read the dashboard actually makes. A miss would call Claude,
  // which CI has no real key for, so a 404 means unseeded data rather than a
  // load failure and is allowed on its own.
  const summaryRes = http.get(`${BASE_URL}/ai-summaries/${DATASET_ID}/latest`, { headers });
  summaryLatency.add(summaryRes.timings.duration);
  check(summaryRes, { 'summary 200 or 404': (r) => r.status === 200 || r.status === 404 });

  sleep(0.2);

  // The entitlement read every gated feature makes. Checkout itself is one POST
  // per upgrade and needs a live Stripe key.
  const tierRes = http.get(`${BASE_URL}/subscriptions/tier`, { headers });
  tierLatency.add(tierRes.timings.duration);
  check(tierRes, { 'tier 200': (r) => r.status === 200 });

  sleep(0.5);
}
