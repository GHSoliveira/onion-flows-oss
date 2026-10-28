import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, TENANT_ID, WEBHOOK_SECRET, TARGET, RAMP_UP, HOLD, RAMP_DOWN } from './lib/config.js';

export const options = {
  stages: [
    { duration: RAMP_UP, target: TARGET },
    { duration: HOLD, target: TARGET },
    { duration: RAMP_DOWN, target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1200'],
  },
};

export default function () {
  const updateId = `${Date.now()}_${__VU}_${__ITER}`;
  const phoneNumberId = __ENV.WHATSAPP_PHONE_NUMBER_ID || '100000000000001';
  const from = __ENV.WHATSAPP_TEST_FROM || `5500000${String(__VU).padStart(4, '0')}`;
  const url = `${BASE_URL}/api/whatsapp/webhook${TENANT_ID ? `?tenantId=${encodeURIComponent(TENANT_ID)}` : ''}`;

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'load-test-entry',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '5500000000000',
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  wa_id: from,
                  profile: { name: `Load Test ${__VU}` },
                },
              ],
              messages: [
                {
                  id: `load_${updateId}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: `load test ${updateId}` },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) {
    headers['x-hub-signature-256'] = WEBHOOK_SECRET;
    headers['x-telegram-bot-api-secret-token'] = WEBHOOK_SECRET;
  }

  const res = http.post(url, JSON.stringify(payload), { headers });
  check(res, {
    'webhook accepted-ish': (r) => [200, 202, 400, 403].includes(r.status),
    'not 5xx': (r) => r.status < 500,
  });

  sleep(1);
}
