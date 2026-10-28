import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JWT_SECRET = 'ai-routing-test-secret-not-for-production';

const { callClassificationProvider, resetAiProviderCircuits } = await import('../src/services/aiClassification.js');

const originalFetch = global.fetch;
const managedEnv = [
  'AI_PROVIDER', 'AI_API_KEY', 'AI_REASONING_ENABLED', 'AI_REASONING_CONFIDENCE_THRESHOLD',
  'AI_TOTAL_TIMEOUT_MS', 'AI_CIRCUIT_FAILURE_THRESHOLD', 'AI_CIRCUIT_RESET_MS',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_REASONING_MODEL', 'GEMINI_FALLBACK_MODELS',
  'GEMINI_TIMEOUT_MS', 'GEMINI_STRUCTURED_OUTPUTS_ENABLED',
  'GROQ_API_KEY', 'GROQ_MODEL', 'GROQ_FALLBACK_MODELS', 'GROQ_TIMEOUT_MS',
  'GROQ_STRUCTURED_OUTPUTS_ENABLED', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_TOKEN',
  'OPENROUTER_API_KEY'
];
const originalEnv = Object.fromEntries(managedEnv.map((key) => [key, process.env[key]]));

const validResult = (overrides = {}) => ({
  intent: 'pediu_preco',
  sentiment: 'positive',
  confidence: 0.95,
  reason: 'Cliente pediu informacoes de preco.',
  nextAction: 'notify_sales',
  suggestedReply: null,
  followUpAt: null,
  requiresHumanReview: false,
  optOutDetected: false,
  ...overrides
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

const geminiResponse = (result) => jsonResponse({
  candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }]
});

const compatibleResponse = (result) => jsonResponse({
  choices: [{ message: { content: JSON.stringify(result) } }]
});

beforeEach(() => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_API_KEY = '';
  process.env.AI_REASONING_ENABLED = 'true';
  process.env.AI_REASONING_CONFIDENCE_THRESHOLD = '0.78';
  process.env.AI_TOTAL_TIMEOUT_MS = '5000';
  process.env.AI_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.AI_CIRCUIT_RESET_MS = '60000';
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  process.env.GEMINI_MODEL = 'gemini-fast-test';
  process.env.GEMINI_REASONING_MODEL = 'gemini-reasoning-test';
  process.env.GEMINI_FALLBACK_MODELS = '';
  process.env.GEMINI_TIMEOUT_MS = '1000';
  process.env.GEMINI_STRUCTURED_OUTPUTS_ENABLED = 'true';
  process.env.GROQ_API_KEY = 'groq-test-key';
  process.env.GROQ_MODEL = 'groq-reasoning-test';
  process.env.GROQ_FALLBACK_MODELS = '';
  process.env.GROQ_TIMEOUT_MS = '1000';
  process.env.GROQ_STRUCTURED_OUTPUTS_ENABLED = 'true';
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_AI_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  resetAiProviderCircuits();
});

afterEach(() => {
  global.fetch = originalFetch;
  resetAiProviderCircuits();
  for (const key of managedEnv) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('high-confidence Gemini result returns without invoking a fallback', async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return geminiResponse(validResult());
  };

  const response = await callClassificationProvider({
    prompt: 'Classifique.',
    input: { currentMessage: 'Qual e o valor?' }
  });

  assert.equal(response.provider, 'gemini');
  assert.equal(response.model, 'gemini-fast-test');
  assert.equal(response.reasoningUsed, false);
  assert.equal(calls.length, 1);
});

test('low-confidence Gemini result escalates to Groq reasoning', async () => {
  const calls = [];
  global.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('generativelanguage')) {
      return geminiResponse(validResult({
        intent: 'revisao_humana',
        sentiment: 'unknown',
        confidence: 0.48,
        nextAction: 'request_human_review',
        requiresHumanReview: true
      }));
    }
    return compatibleResponse(validResult({ confidence: 0.96 }));
  };

  const response = await callClassificationProvider({
    prompt: 'Classifique.',
    input: { currentMessage: 'Talvez, depende de algumas condicoes.' }
  });

  assert.equal(response.provider, 'groq');
  assert.equal(response.model, 'groq-reasoning-test');
  assert.equal(response.reasoningUsed, true);
  assert.equal(response.result.confidence, 0.96);
  assert.equal(calls.length, 2);
});

test('provider input removes credentials and common personal identifiers', async () => {
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return geminiResponse(validResult());
  };

  await callClassificationProvider({
    prompt: 'Classifique.',
    input: {
      currentMessage: 'Meu CPF e 123.456.789-00, email teste@example.com e telefone +55 11 99999-0000.',
      apiToken: 'must-not-leave-the-backend'
    }
  });

  const serialized = JSON.stringify(requestBody);
  assert.equal(serialized.includes('123.456.789-00'), false);
  assert.equal(serialized.includes('teste@example.com'), false);
  assert.equal(serialized.includes('99999-0000'), false);
  assert.equal(serialized.includes('must-not-leave-the-backend'), false);
  assert.match(serialized, /\[CPF\]|\[PHONE\]/);
});

test('open circuit skips an unhealthy Gemini model on subsequent calls', async () => {
  process.env.AI_CIRCUIT_FAILURE_THRESHOLD = '1';
  const calls = [];
  global.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('gemini-fast-test')) {
      return jsonResponse({ error: { message: 'temporarily unavailable' } }, 503);
    }
    return compatibleResponse(validResult());
  };

  const first = await callClassificationProvider({ prompt: 'Classifique.', input: { currentMessage: 'Preco?' } });
  const callsAfterFirst = calls.length;
  const second = await callClassificationProvider({ prompt: 'Classifique.', input: { currentMessage: 'Preco novamente?' } });

  assert.equal(first.provider, 'groq');
  assert.equal(second.provider, 'groq');
  assert.equal(callsAfterFirst, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((url) => url.includes('gemini-fast-test')).length, 1);
});
