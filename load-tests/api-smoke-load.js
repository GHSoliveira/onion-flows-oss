import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { login, authHeaders } from './lib/auth.js';
import { BASE_URL, USERNAME, PASSWORD, TARGET, RAMP_UP, HOLD, RAMP_DOWN, appendTenant, requireCredentials } from './lib/config.js';

const batchDuration = new Trend('api_smoke_batch_duration');

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET },
    { duration: HOLD, target: TARGET },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    api_smoke_batch_duration: ['p(95)<1200'],
  },
};

export function setup() {
  requireCredentials();
  return {
    token: login(BASE_URL, USERNAME, PASSWORD),
  };
}

export default function (data) {
  const headers = authHeaders(data.token);
  const started = Date.now();

  const responses = http.batch([
    ['GET', appendTenant(`${BASE_URL}/api/auth/heartbeat`), null, { headers }],
    ['GET', appendTenant(`${BASE_URL}/api/flows?limit=50&page=1`), null, { headers }],
    ['GET', appendTenant(`${BASE_URL}/api/chats/my-queues`), null, { headers }],
    ['GET', appendTenant(`${BASE_URL}/api/contacts?limit=50`), null, { headers }],
    ['GET', appendTenant(`${BASE_URL}/api/templates`), null, { headers }],
  ]);

  batchDuration.add(Date.now() - started);

  check(responses[0], { 'heartbeat ok': (r) => r.status === 200 });
  check(responses[1], { 'flows ok': (r) => r.status === 200 });
  check(responses[2], { 'my queues ok': (r) => r.status === 200 });
  check(responses[3], { 'contacts ok': (r) => r.status === 200 });
  check(responses[4], { 'templates ok': (r) => r.status === 200 });

  sleep(1);
}
