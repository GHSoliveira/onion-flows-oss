import http from 'k6/http';
import { check, sleep } from 'k6';
import { login, authHeaders } from './lib/auth.js';
import { BASE_URL, USERNAME, PASSWORD, TARGET, RAMP_UP, HOLD, RAMP_DOWN, appendTenant, requireCredentials } from './lib/config.js';

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET },
    { duration: HOLD, target: TARGET },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
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
  const res = http.get(appendTenant(`${BASE_URL}/api/load-test/smoke`), { headers });

  check(res, {
    'load route status 200': (r) => r.status === 200,
    'load route ok': (r) => r.json('ok') === true,
    'load route has counts': (r) => Boolean(r.json('counts')),
  });

  sleep(1);
}
