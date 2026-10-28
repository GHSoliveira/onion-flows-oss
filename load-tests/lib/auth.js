import http from 'k6/http';
import { check } from 'k6';

export function login(baseUrl, username, password) {
  const res = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'login status 200': (r) => r.status === 200,
    'login has token': (r) => Boolean(r.json('token')),
  });

  const token = res.json('token');
  if (!token) {
    throw new Error(`Login falhou para username="${username}". Status=${res.status} Body=${res.body}`);
  }

  return token;
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
