import http from 'k6/http';
import { check, sleep } from 'k6';
import { login, authHeaders } from './lib/auth.js';
import { BASE_URL, USERNAME, PASSWORD, TARGET, RAMP_UP, HOLD, RAMP_DOWN, CHAT_ID, appendTenant, requireCredentials } from './lib/config.js';

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET },
    { duration: HOLD, target: TARGET },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
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
  const requests = [
    ['GET', appendTenant(`${BASE_URL}/api/chats/my-queues`), null, { headers }],
    ['GET', appendTenant(`${BASE_URL}/api/chats/history?limit=25&page=1`), null, { headers }],
  ];

  if (CHAT_ID) {
    requests.push(['GET', appendTenant(`${BASE_URL}/api/chats/${encodeURIComponent(CHAT_ID)}`), null, { headers }]);
  }

  const responses = http.batch(requests);

  check(responses[0], { 'my queues ok': (r) => r.status === 200 });
  check(responses[1], { 'history ok': (r) => [200, 403].includes(r.status) });
  if (CHAT_ID) {
    check(responses[2], { 'chat detail ok': (r) => r.status === 200 });
  }

  sleep(1);
}
