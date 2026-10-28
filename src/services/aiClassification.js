import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { envFlag, envInt } from '../utils/env.js';
import { getChatMessages } from './chatMessages.js';
import { suppressContact } from './contactSuppression.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { recordCampaignMetricOnce } from './outreachMetrics.js';
import { getTenantSettings } from './tenantSettings.js';
import { stopCadencesForContact } from './cadenceEngine.js';
import {
  COLLECTIONS, INTENTS, NEXT_ACTIONS, SENTIMENTS, clampConfidence,
  createDomainId, normalizeIdentifier, nowIso, stableHash
} from './outreachDomain.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { routeClassifiedReplyToAttendance } from './attendanceRouting.js';
import { withLock } from './chatLocks.js';

const outputSchema = z.object({
  intent: z.enum(INTENTS),
  sentiment: z.enum(SENTIMENTS),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000),
  nextAction: z.enum(NEXT_ACTIONS),
  suggestedReply: z.string().max(4000).nullable(),
  followUpAt: z.string().datetime().nullable(),
  requiresHumanReview: z.boolean(),
  optOutDetected: z.boolean()
}).strict();

const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    sentiment: { type: 'string', enum: SENTIMENTS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    nextAction: { type: 'string', enum: NEXT_ACTIONS },
    suggestedReply: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    followUpAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    requiresHumanReview: { type: 'boolean' },
    optOutDetected: { type: 'boolean' }
  },
  required: [
    'intent', 'sentiment', 'confidence', 'reason', 'nextAction',
    'suggestedReply', 'followUpAt', 'requiresHumanReview', 'optOutDetected'
  ],
  additionalProperties: false
};

const providerCircuits = new Map();

const DEFAULT_PROMPT = `Voce classifica respostas comerciais recebidas no WhatsApp.
Responda somente JSON valido com intent, sentiment, confidence, reason, nextAction,
suggestedReply, followUpAt, requiresHumanReview e optOutDetected. Nao invente contexto.
Opt-out explicito sempre deve resultar em intent opt_out e nextAction suppress_contact.`;

const redact = (value) => String(value || '')
  .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
  .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, '[CNPJ]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
  .replace(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g, '[PHONE]')
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
  .slice(0, 8000);

const SENSITIVE_INPUT_KEY = /(authorization|password|passwd|secret|token|api.?key|access.?key|private.?key)/i;

const sanitizeProviderInput = (value, depth = 0) => {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeProviderInput(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1000);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_INPUT_KEY.test(key))
      .slice(0, 50)
      .map(([key, item]) => [key, sanitizeProviderInput(item, depth + 1)])
  );
};

const getActivePrompt = async (tenantId) => {
  const tenantPrompt = await adapter.findOne('aiPromptVersions', { tenantId, active: true }, { projection: { _id: 0, prompt: 1, version: 1 } });
  const globalPrompt = tenantPrompt || await adapter.findOne('aiPromptVersions', { tenantId: null, active: true }, { projection: { _id: 0, prompt: 1, version: 1 } });
  return globalPrompt || { prompt: DEFAULT_PROMPT, version: 'default-v1' };
};

const parseProviderJson = (value) => {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
};

const ruleBasedClassification = (text) => {
  const value = String(text || '').toLowerCase();
  if (/\b(parar|pare|sair|remover|nao me envie|não me envie|descadastrar)\b/.test(value)) {
    return { intent: 'opt_out', sentiment: 'negative', confidence: 0.99, reason: 'Pedido explicito para interromper mensagens.', nextAction: 'suppress_contact', suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: true };
  }
  if (/\b(demo|demonstracao|demonstração|apresentacao|apresentação)\b/.test(value)) {
    return { intent: 'pediu_demo', sentiment: 'positive', confidence: 0.86, reason: 'A resposta solicita demonstracao.', nextAction: 'notify_sales', suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false };
  }
  if (/\b(preco|preço|valor|quanto custa|orcamento|orçamento)\b/.test(value)) {
    return { intent: 'pediu_preco', sentiment: 'positive', confidence: 0.84, reason: 'A resposta solicita informacoes comerciais de preco.', nextAction: 'notify_sales', suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false };
  }
  if (/\b(nao tenho interesse|não tenho interesse|nao quero|não quero)\b/.test(value)) {
    return { intent: 'negativo', sentiment: 'negative', confidence: 0.9, reason: 'A resposta recusa a oferta.', nextAction: 'stop_cadence', suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false };
  }
  return { intent: 'revisao_humana', sentiment: 'unknown', confidence: 0.45, reason: 'Nao foi possivel determinar a intencao com seguranca.', nextAction: 'request_human_review', suggestedReply: null, followUpAt: null, requiresHumanReview: true, optOutDetected: false };
};

// Botoes de resposta rapida dos nossos templates de prospeccao. O texto que
// chega e o rotulo do botao, entao o significado e conhecido: nao precisa (nem
// deve) depender da IA, que sem contexto pode devolver confianca baixa e mandar
// "Quero ver" para revisao humana em vez de seguir a jornada.
const DIACRITICOS = /[̀-ͯ]/g;
const normalizarRotulo = (value) => String(value || '')
  .normalize('NFD').replace(DIACRITICOS, '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const QUICK_REPLY_CLASSIFICATIONS = new Map([
  ['quero ver', { intent: 'pediu_demo', sentiment: 'positive', confidence: 0.99, reason: 'Tocou no botao "Quero ver" do template.', nextAction: 'notify_sales' }],
  ['nao obrigado', { intent: 'negativo', sentiment: 'negative', confidence: 0.99, reason: 'Tocou no botao "Nao, obrigado" do template.', nextAction: 'stop_cadence' }]
]);

export const quickReplyClassification = (text) => {
  const found = QUICK_REPLY_CLASSIFICATIONS.get(normalizarRotulo(text));
  if (!found) return null;
  return { ...found, suggestedReply: null, followUpAt: null, requiresHumanReview: false, optOutDetected: false };
};

const providerTimeout = (envName, fallback = 10000) => (
  envInt(envName, fallback, { min: 1000, max: 120000 })
);

const providerError = (provider, response, body) => {
  const error = new Error(body?.error?.message || body?.errors?.[0]?.message || `${provider} HTTP ${response.status}`);
  error.status = response.status;
  return error;
};

const requestOpenAiCompatible = async ({
  provider, endpoint, apiKey, model, timeoutMs, prompt, input,
  structuredOutputs = false, extraHeaders = {}
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: structuredOutputs
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'commercial_classification',
                strict: true,
                schema: CLASSIFICATION_JSON_SCHEMA
              }
            }
          : { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(input) }
        ]
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw providerError(provider, response, body);
    return parseProviderJson(body?.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timer);
  }
};

const requestGemini = async ({ apiKey, model, timeoutMs, prompt, input, structuredOutputs = true }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          ...(structuredOutputs ? { responseJsonSchema: CLASSIFICATION_JSON_SCHEMA } : {})
        }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw providerError('gemini', response, body);
    const content = body?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
      .join('');
    return parseProviderJson(content);
  } finally {
    clearTimeout(timer);
  }
};

const requestCloudflare = async ({ accountId, apiToken, model, timeoutMs, prompt, input }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const modelPath = String(model).split('/').map(encodeURIComponent).join('/');
  const endpoint = String(process.env.CLOUDFLARE_AI_URL || `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelPath}`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(input) }
        ]
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) throw providerError('cloudflare', response, body);
    return parseProviderJson(body?.result?.response ?? body?.result);
  } finally {
    clearTimeout(timer);
  }
};

const uniqueList = (values) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

const buildProviderPrompt = (prompt) => `${prompt}\n\nContrato obrigatorio da resposta JSON:
- intent: um de ${JSON.stringify(INTENTS)}
- sentiment: um de ${JSON.stringify(SENTIMENTS)}
- confidence: numero entre 0 e 1
- reason: texto curto
- nextAction: um de ${JSON.stringify(NEXT_ACTIONS)}
- suggestedReply: texto ou null
- followUpAt: data ISO 8601 ou null
- requiresHumanReview: boolean
- optOutDetected: boolean
Nao adicione campos, markdown ou comentarios fora do JSON.`;

const sanitizeProviderError = (error) => {
  let message = error?.name === 'AbortError'
    ? 'timeout'
    : String(error?.message || 'falha desconhecida');
  for (const secret of [
    process.env.AI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.CLOUDFLARE_AI_TOKEN,
    process.env.OPENROUTER_API_KEY
  ]) {
    if (secret) message = message.split(String(secret)).join('[REDACTED]');
  }
  return message
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|gsk|AIza|AQ\.)[_A-Za-z0-9.-]{12,}\b/g, '[REDACTED]')
    .slice(0, 300);
};

const circuitKey = (attempt) => `${attempt.provider}:${attempt.model}`;

const isCircuitOpen = (attempt) => {
  const state = providerCircuits.get(circuitKey(attempt));
  if (!state?.openedUntil) return false;
  if (state.openedUntil <= Date.now()) {
    providerCircuits.delete(circuitKey(attempt));
    return false;
  }
  return true;
};

const recordProviderSuccess = (attempt) => providerCircuits.delete(circuitKey(attempt));

const recordProviderFailure = (attempt) => {
  const key = circuitKey(attempt);
  const threshold = envInt('AI_CIRCUIT_FAILURE_THRESHOLD', 3, { min: 1, max: 20 });
  const resetMs = envInt('AI_CIRCUIT_RESET_MS', 60000, { min: 5000, max: 900000 });
  const previous = providerCircuits.get(key) || { failures: 0, openedUntil: 0 };
  const failures = previous.failures + 1;
  providerCircuits.set(key, {
    failures,
    openedUntil: failures >= threshold ? Date.now() + resetMs : 0
  });
};

export const resetAiProviderCircuits = () => providerCircuits.clear();

const shouldEscalateReasoning = (result) => {
  if (!envFlag('AI_REASONING_ENABLED', true)) return false;
  if (result.optOutDetected || result.intent === 'opt_out') return false;
  const threshold = Number(process.env.AI_REASONING_CONFIDENCE_THRESHOLD || 0.78);
  return result.requiresHumanReview
    || result.intent === 'revisao_humana'
    || result.sentiment === 'unknown'
    || Number(result.confidence || 0) < threshold;
};

const resultScore = (result) => (
  Number(result?.confidence || 0)
  + (result?.optOutDetected ? 2 : 0)
  - (result?.requiresHumanReview ? 0.05 : 0)
);

const createProviderAttempts = ({ prompt, input }) => {
  const configuredProvider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();
  const attempts = [];
  const seen = new Set();
  const add = (attempt) => {
    if (!attempt?.configured) return;
    const key = circuitKey(attempt);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(attempt);
  };

  const geminiKey = String(process.env.GEMINI_API_KEY || '');
  const geminiPrimaryModel = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite');
  const groqKey = String(process.env.GROQ_API_KEY || '');
  const groqModels = uniqueList([
    process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    ...String(process.env.GROQ_FALLBACK_MODELS || '').split(',')
  ]);
  const openAiKey = String(process.env.AI_API_KEY || '');
  const openAiModel = String(process.env.AI_MODEL || 'gpt-4.1-mini');
  const openAiEndpoint = String(process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions');
  const cloudflareAccountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '');
  const cloudflareToken = String(process.env.CLOUDFLARE_AI_TOKEN || '');
  const cloudflareModel = String(process.env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  const openRouterKey = String(process.env.OPENROUTER_API_KEY || '');
  const openRouterModel = String(process.env.OPENROUTER_MODEL || 'openrouter/free');
  const openAiProvider = ['gemini', 'groq', 'cloudflare', 'openrouter'].includes(configuredProvider)
    ? 'openai'
    : configuredProvider;

  const geminiAttempt = (model, tier) => ({
    configured: Boolean(geminiKey && model),
    provider: 'gemini', model, tier,
    timeoutMs: providerTimeout('GEMINI_TIMEOUT_MS'),
    execute: (timeoutMs) => requestGemini({
      apiKey: geminiKey,
      model,
      timeoutMs,
      prompt,
      input,
      structuredOutputs: envFlag('GEMINI_STRUCTURED_OUTPUTS_ENABLED', true)
    })
  });
  const groqAttempt = (model, tier) => ({
    configured: Boolean(groqKey && model),
    provider: 'groq', model, tier,
    timeoutMs: providerTimeout('GROQ_TIMEOUT_MS'),
    execute: (timeoutMs) => requestOpenAiCompatible({
      provider: 'groq',
      endpoint: String(process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions'),
      apiKey: groqKey,
      model,
      timeoutMs,
      prompt,
      input,
      structuredOutputs: envFlag('GROQ_STRUCTURED_OUTPUTS_ENABLED', true)
        && String(model).startsWith('openai/gpt-oss')
    })
  });
  const openAiAttempt = (tier) => ({
    configured: Boolean(openAiKey),
    provider: openAiProvider,
    model: openAiModel,
    tier,
    timeoutMs: providerTimeout('AI_CLASSIFICATION_TIMEOUT_MS'),
    execute: (timeoutMs) => requestOpenAiCompatible({
      provider: openAiProvider,
      endpoint: openAiEndpoint,
      apiKey: openAiKey,
      model: openAiModel,
      timeoutMs,
      prompt,
      input,
      structuredOutputs: envFlag('AI_STRUCTURED_OUTPUTS_ENABLED', true)
    })
  });
  const cloudflareAttempt = (tier) => ({
    configured: Boolean(cloudflareAccountId && cloudflareToken),
    provider: 'cloudflare', model: cloudflareModel, tier,
    timeoutMs: providerTimeout('CLOUDFLARE_AI_TIMEOUT_MS'),
    execute: (timeoutMs) => requestCloudflare({
      accountId: cloudflareAccountId,
      apiToken: cloudflareToken,
      model: cloudflareModel,
      timeoutMs,
      prompt,
      input
    })
  });
  const openRouterAttempt = (tier) => ({
    configured: Boolean(openRouterKey),
    provider: 'openrouter', model: openRouterModel, tier,
    timeoutMs: providerTimeout('OPENROUTER_TIMEOUT_MS'),
    execute: (timeoutMs) => requestOpenAiCompatible({
      provider: 'openrouter',
      endpoint: String(process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions'),
      apiKey: openRouterKey,
      model: openRouterModel,
      timeoutMs,
      prompt,
      input,
      structuredOutputs: false,
      extraHeaders: {
        'HTTP-Referer': String(process.env.OPENROUTER_SITE_URL || process.env.CLIENT_URL || 'http://localhost:5173'),
        'X-Title': 'Onion Web Flows'
      }
    })
  });

  if (configuredProvider === 'gemini') add(geminiAttempt(geminiPrimaryModel, 'fast'));
  else if (configuredProvider === 'groq') add(groqAttempt(groqModels[0], 'fast'));
  else if (configuredProvider === 'cloudflare') add(cloudflareAttempt('fast'));
  else if (configuredProvider === 'openrouter') add(openRouterAttempt('fast'));
  else add(openAiAttempt('fast'));

  if (!attempts.length && geminiKey) add(geminiAttempt(geminiPrimaryModel, 'fast'));
  if (!attempts.length && groqKey) add(groqAttempt(groqModels[0], 'fast'));

  for (const model of groqModels) add(groqAttempt(model, 'reasoning'));
  add(geminiAttempt(String(process.env.GEMINI_REASONING_MODEL || 'gemini-3.7-flash'), 'reasoning'));
  for (const model of uniqueList(String(process.env.GEMINI_FALLBACK_MODELS || '').split(','))) {
    add(geminiAttempt(model, 'fallback'));
  }
  add(cloudflareAttempt('fallback'));
  add(openRouterAttempt('fallback'));
  add(openAiAttempt('fallback'));

  return attempts;
};

export const callClassificationProvider = async ({ prompt, input }) => {
  const botao = quickReplyClassification(input?.currentMessage);
  if (botao) return { result: botao, provider: 'quick_reply', model: 'quick_reply' };
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();
  if (provider === 'rules' || provider === 'rule_based') {
    return { result: ruleBasedClassification(input.currentMessage), provider: 'rules', model: 'rules' };
  }

  const providerPrompt = buildProviderPrompt(prompt);
  const safeInput = sanitizeProviderInput(input);
  const attempts = createProviderAttempts({ prompt: providerPrompt, input: safeInput });
  if (!attempts.length) throw new Error('Nenhum provedor de IA configurado');

  const deadlineAt = Date.now() + envInt('AI_TOTAL_TIMEOUT_MS', 20000, { min: 3000, max: 120000 });
  const failures = [];
  let best = null;

  for (const attempt of attempts) {
    if (best && attempt.tier !== 'fast' && !shouldEscalateReasoning(best.result)) break;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 500) {
      failures.push('deadline: prazo total esgotado');
      break;
    }
    if (isCircuitOpen(attempt)) {
      failures.push(`${attempt.provider}/${attempt.model}: circuit_open`);
      continue;
    }

    try {
      const rawResult = await attempt.execute(Math.min(attempt.timeoutMs, remainingMs));
      const result = outputSchema.parse(applyConfidencePolicy(rawResult));
      recordProviderSuccess(attempt);
      const candidate = {
        result,
        provider: attempt.provider,
        model: attempt.model,
        route: attempt.tier,
        reasoningUsed: attempt.tier !== 'fast'
      };
      if (!best || resultScore(candidate.result) > resultScore(best.result)) best = candidate;
      if (!shouldEscalateReasoning(result)) return candidate;
    } catch (error) {
      recordProviderFailure(attempt);
      const reason = sanitizeProviderError(error);
      failures.push(`${attempt.provider}/${attempt.model}: ${reason}`);
      console.warn('[AI_CLASSIFICATION] Provider failed; trying fallback', {
        provider: attempt.provider,
        model: attempt.model,
        reason
      });
    }
  }

  if (best) return best;
  throw new Error(`Todos os provedores de IA falharam: ${failures.join(' | ')}`);
};

const applyConfidencePolicy = (result) => {
  const automaticThreshold = Number(process.env.AI_CLASSIFICATION_CONFIDENCE_THRESHOLD || 0.8);
  const reviewThreshold = Number(process.env.AI_CLASSIFICATION_REVIEW_THRESHOLD || 0.6);
  const confidence = clampConfidence(result.confidence);
  if (result.optOutDetected || result.intent === 'opt_out') {
    return { ...result, intent: 'opt_out', confidence, nextAction: 'suppress_contact', requiresHumanReview: false, optOutDetected: true };
  }
  if (confidence < reviewThreshold) return { ...result, intent: 'revisao_humana', confidence, nextAction: 'request_human_review', requiresHumanReview: true };
  if (confidence < automaticThreshold) return { ...result, confidence, requiresHumanReview: true };
  return { ...result, confidence };
};

const messageText = (message) => message?.text || message?.media?.caption || '';

const buildConversationContext = async ({ tenantId, message, force = false }) => {
  const timestampMs = new Date(message?.timestamp || message?.createdAt || 0).getTime();
  const before = !force && Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs + 1).toISOString()
    : null;
  const stored = await getChatMessages(message.chatId, {
    tenantId,
    limit: 10,
    sort: 'desc',
    ...(before ? { before } : {})
  });
  const byId = new Map();
  for (const item of [...stored, message]) {
    const id = String(item?.messageId || item?.id || '');
    if (!id) continue;
    if (!force && Number.isFinite(timestampMs)) {
      const itemMs = new Date(item?.timestamp || item?.createdAt || 0).getTime();
      if (Number.isFinite(itemMs) && itemMs > timestampMs) continue;
    }
    byId.set(id, item);
  }
  const messages = [...byId.values()]
    .sort((a, b) => new Date(a?.timestamp || a?.createdAt || 0) - new Date(b?.timestamp || b?.createdAt || 0))
    .slice(-10);
  const current = force
    ? [...messages].reverse().find((item) => String(item?.sender || '').toLowerCase() === 'user') || message
    : message;
  const recentMessages = messages.map((item) => ({
    messageId: item.messageId || item.id || null,
    sender: item.sender || null,
    text: redact(messageText(item)),
    timestamp: item.timestamp || item.createdAt || null
  }));
  return {
    currentMessage: redact(messageText(current)),
    recentMessages,
    conversationContextHash: stableHash(JSON.stringify(recentMessages))
  };
};

export const buildClassificationIdempotencyKey = (record) => {
  const revision = Math.max(1, Number(record?.classificationRevision || 1));
  const contextHash = String(record?.conversationContextHash || stableHash('empty'));
  return `classification:${record.id}:${record.promptVersion}:r${revision}:${contextHash.slice(0, 16)}`;
};

const publishClassificationEvent = async ({ record, campaign, campaignItem }) => {
  const classificationRevision = Math.max(1, Number(record.classificationRevision || 1));
  const conversationContextHash = String(record.conversationContextHash || stableHash(JSON.stringify(record.recentMessages || [])));
  const idempotencyKey = record.optOutDetected
    ? `lead-opted-out:${record.tenantId}:${normalizeIdentifier(campaignItem?.phoneNumber) || record.contactId}`
    : buildClassificationIdempotencyKey(record);
  const existingEvent = await adapter.findOne(COLLECTIONS.outbox, {
    tenantId: record.tenantId,
    destination: 'turizmo',
    idempotencyKey
  }, { projection: { id: 1 } });
  const event = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId: record.tenantId,
    type: record.optOutDetected ? 'lead.opted_out' : 'lead.classified',
    aggregateType: 'lead',
    aggregateId: record.turizmoLeadId || record.contactId,
    idempotencyKey,
    data: record.optOutDetected ? {
      turizmoLeadId: record.turizmoLeadId,
      contactId: record.contactId,
      channel: 'whatsapp',
      identifier: campaignItem?.phoneNumber || null,
      reason: 'opt_out',
      optedOutAt: record.updatedAt
    } : {
      turizmoLeadId: record.turizmoLeadId,
      contactId: record.contactId,
      chatId: record.chatId,
      campaignId: record.campaignId,
      classificationId: record.id,
      classificationRevision,
      conversationContextHash,
      reprocessedAt: record.reprocessedAt || null,
      intent: record.intent,
      sentiment: record.sentiment,
      confidence: record.confidence,
      nextAction: record.nextAction,
      suggestedReply: record.suggestedReply,
      requiresHumanReview: record.requiresHumanReview,
      reason: record.reason,
      messageId: record.messageId,
      currentMessage: record.currentMessage || record.inputText || '',
      recentMessages: Array.isArray(record.recentMessages) ? record.recentMessages : [],
      automationManagedBy: record.automationManagedBy || campaign?.automationManagedBy || 'onion',
      journeyVersion: campaign?.journeyVersion || 1
    }
  }));
  if (event && !existingEvent) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
  return { event, duplicate: Boolean(existingEvent), idempotencyKey };
};

const classifyMessageLocked = async ({
  tenantId,
  messageId,
  force = false,
  classificationId = null,
  reprocessRequestId = null,
  resolvedMessage = null
}) => {
  if (!envFlag('AI_CLASSIFICATION_ENABLED', false)) return { disabled: true };
  const tenantSettings = await getTenantSettings(tenantId);
  if (tenantSettings.aiClassificationEnabled === false) return { disabled: true, tenantDisabled: true };
  let prompt = await getActivePrompt(tenantId);
  const requestedExisting = classificationId
    ? await adapter.findOne(COLLECTIONS.classifications, { tenantId, id: classificationId })
    : null;
  if (requestedExisting?.promptVersion && requestedExisting.promptVersion !== prompt.version) {
    const originalPrompt = await adapter.findOne('aiPromptVersions', {
      version: requestedExisting.promptVersion,
      $or: [{ tenantId }, { tenantId: null }]
    }, { projection: { prompt: 1, version: 1 } });
    prompt = {
      prompt: originalPrompt?.prompt || prompt.prompt,
      version: requestedExisting.promptVersion
    };
  }
  if (requestedExisting?.messageId) messageId = requestedExisting.messageId;
  const existing = requestedExisting || await adapter.findOne(
    COLLECTIONS.classifications,
    { tenantId, messageId, promptVersion: prompt.version }
  );
  const repeatedRevision = Boolean(
    existing
    && force
    && reprocessRequestId
    && existing.lastReprocessRequestId === reprocessRequestId
  );
  if (existing && (!force || repeatedRevision)) {
    const existingCampaignItem = existing.campaignItemId
      ? await adapter.findOne(COLLECTIONS.campaignItems, { tenantId, id: existing.campaignItemId })
      : null;
    const existingCampaign = existing.campaignId
      ? await adapter.findOne(COLLECTIONS.campaigns, { tenantId, id: existing.campaignId })
      : null;
    const turizmoManaged = existing.automationManagedBy === 'turizmo'
      || existingCampaign?.automationManagedBy === 'turizmo';
    if (!turizmoManaged) {
      await routeClassifiedReplyToAttendance({ classification: existing }).catch((error) => {
        console.warn('[ATTENDANCE_ROUTING] Falha ao retomar roteamento de classificacao existente', {
          tenantId, messageId, error: error?.message || 'routing_failed'
        });
      });
    }
    const publication = await publishClassificationEvent({
      record: existing,
      campaign: existingCampaign,
      campaignItem: existingCampaignItem
    });
    return { ...existing, duplicate: true, outboxDuplicate: publication.duplicate };
  }
  const message = resolvedMessage?.messageId === messageId
    ? resolvedMessage
    : await adapter.findOne('chatMessages', { tenantId, messageId });
  if (!message) throw new Error('Mensagem para classificacao nao encontrada');
  const campaignItem = message.campaignItemId
    ? await adapter.findOne(COLLECTIONS.campaignItems, { tenantId, id: message.campaignItemId })
    : (existing?.campaignItemId
      ? await adapter.findOne(COLLECTIONS.campaignItems, { tenantId, id: existing.campaignItemId })
      : null);
  const campaignId = message.campaignId || campaignItem?.campaignId || existing?.campaignId || null;
  const campaign = campaignId
    ? await adapter.findOne(COLLECTIONS.campaigns, { tenantId, id: campaignId }, { projection: { _id: 0, name: 1, templateName: 1, automationManagedBy: 1, journeyVersion: 1, turizmoCampaignId: 1 } })
    : null;
  const conversation = await buildConversationContext({ tenantId, message, force });
  const input = {
    currentMessage: conversation.currentMessage,
    recentMessages: conversation.recentMessages,
    templateName: campaign?.templateName || null,
    campaignName: campaign?.name || null,
    company: message.companyName ? redact(message.companyName) : null,
    previousIntent: campaignItem?.intent || null
  };
  const startedAt = Date.now();
  const providerResponse = await callClassificationProvider({ prompt: prompt.prompt, input });
  const parsed = providerResponse.result;
  const now = nowIso();
  const previousRevision = existing
    ? Math.max(1, Number(existing.classificationRevision || 1))
    : 0;
  const classificationRevision = previousRevision + 1;
  const record = {
    id: existing?.id || createDomainId('classification'),
    tenantId,
    contactId: message.contactId || campaignItem?.contactId || null,
    chatId: message.chatId,
    messageId,
    providerMessageId: message.providerMessageId || null,
    outreachId: message.outreachId || campaignItem?.outreachId || null,
    campaignId,
    campaignItemId: message.campaignItemId || campaignItem?.id || null,
    turizmoLeadId: message.turizmoLeadId || campaignItem?.turizmoLeadId || existing?.turizmoLeadId || null,
    turizmoCampaignId: message.turizmoCampaignId || campaign?.turizmoCampaignId || existing?.turizmoCampaignId || null,
    automationManagedBy: message.automationManagedBy || campaign?.automationManagedBy || existing?.automationManagedBy || null,
    protectedAttendance: message.protectedAttendance === true || existing?.protectedAttendance === true,
    inputText: input.currentMessage,
    currentMessage: input.currentMessage,
    recentMessages: input.recentMessages,
    conversationContextHash: conversation.conversationContextHash,
    classificationRevision,
    reprocessedAt: existing ? now : null,
    lastReprocessRequestId: force ? (reprocessRequestId || null) : null,
    provider: providerResponse.provider,
    model: providerResponse.model,
    promptVersion: prompt.version,
    ...parsed,
    reviewStatus: parsed.requiresHumanReview ? 'pending' : 'not_required',
    reviewedBy: null,
    reviewedAt: null,
    rawProviderResponse: null,
    attemptCount: Number(existing?.attemptCount || 0) + 1,
    processingTimeMs: Date.now() - startedAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await adapter.updateOne(COLLECTIONS.classifications, { tenantId, id: record.id }, { $set: record }, { upsert: true });
  const turizmoManaged = record.automationManagedBy === 'turizmo'
    || campaign?.automationManagedBy === 'turizmo';

  if (record.campaignItemId) {
    const qualified = ['positivo', 'pediu_demo', 'pediu_preco', 'pediu_proposta'].includes(record.intent);
    const itemStatus = record.optOutDetected ? 'opted_out' : (qualified ? 'qualified' : 'classified');
    await adapter.updateOne(COLLECTIONS.campaignItems, { tenantId, id: record.campaignItemId }, {
      $set: {
        classificationId: record.id,
        intent: record.intent,
        sentiment: record.sentiment,
        confidence: record.confidence,
        nextAction: record.nextAction,
        status: itemStatus,
        ...(record.optOutDetected ? { optedOutAt: now } : {}),
        updatedAt: now
      }
    });
    await recordCampaignMetricOnce({
      tenantId,
      campaignId: record.campaignId,
      campaignItemId: record.campaignItemId,
      type: record.optOutDetected ? 'opted_out' : `intent:${record.intent}`,
      sourceId: record.optOutDetected ? record.messageId : record.id,
      dimensions: { intent: record.intent, sentiment: record.sentiment, model: record.model, promptVersion: record.promptVersion }
    });
  }

  if (!turizmoManaged && record.optOutDetected && campaignItem?.phoneNumber) {
    await suppressContact({
      tenantId,
      contactId: record.contactId,
      identifier: campaignItem.phoneNumber,
      reason: 'opt_out',
      source: 'ai_classification',
      createdBy: 'system'
    });
  }

  if (!turizmoManaged && record.contactId && ['positivo', 'pediu_demo', 'pediu_preco', 'pediu_proposta'].includes(record.intent)) {
    await stopCadencesForContact({ tenantId, contactId: record.contactId, reason: 'stopped_by_positive' });
  } else if (!turizmoManaged && record.contactId && ['negativo', 'objecao_preco', 'objecao_tempo', 'ja_possui_sistema'].includes(record.intent)) {
    await stopCadencesForContact({ tenantId, contactId: record.contactId, reason: 'stopped_by_negative' });
  }

  if (!turizmoManaged && ['notify_sales', 'create_task', 'request_human_review'].includes(record.nextAction)) {
    const taskId = `commercial_task_${record.id}`;
    await adapter.updateOne('commercialTasks', { tenantId, id: taskId }, {
      $set: {
        id: taskId,
        tenantId,
        contactId: record.contactId,
        turizmoLeadId: record.turizmoLeadId,
        chatId: record.chatId,
        campaignId: record.campaignId,
        campaignItemId: record.campaignItemId,
        classificationId: record.id,
        title: record.requiresHumanReview ? 'Revisar resposta comercial' : 'Lead requer atendimento comercial',
        description: record.reason,
        priority: ['pediu_demo', 'pediu_proposta'].includes(record.intent) ? 'high' : 'normal',
        status: 'open',
        assignedTo: null,
        dueAt: record.followUpAt || now,
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    }, { upsert: true });
  }

  if (!turizmoManaged) {
    await routeClassifiedReplyToAttendance({ classification: record, force }).catch((error) => {
      console.warn('[ATTENDANCE_ROUTING] Falha ao encaminhar resposta classificada', {
        tenantId, messageId, classificationId: record.id, error: error?.message || 'routing_failed'
      });
    });
  }

  const publication = await publishClassificationEvent({ record, campaign, campaignItem });
  if (!turizmoManaged && record.intent === 'pediu_demo') {
    const meetingEvent = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId,
      type: 'meeting.requested',
      aggregateType: 'lead',
      aggregateId: record.turizmoLeadId || record.contactId,
      idempotencyKey: `meeting-requested:${record.messageId}`,
      data: {
        turizmoLeadId: record.turizmoLeadId,
        contactId: record.contactId,
        chatId: record.chatId,
        requestedAt: now,
        messageId: record.messageId
      }
    }));
    if (meetingEvent) enqueueTurizmoDelivery({ outboxId: meetingEvent.id }).catch(() => {});
  }
  return {
    ...record,
    duplicate: false,
    outboxDuplicate: publication.duplicate,
    classificationEventId: publication.event?.id || null,
    classificationIdempotencyKey: publication.idempotencyKey
  };
};

export const classifyMessage = async ({
  tenantId,
  messageId,
  force = false,
  classificationId = null,
  reprocessRequestId = null
}) => {
  if (!envFlag('AI_CLASSIFICATION_ENABLED', false)) return { disabled: true };
  let requestedClassification = null;
  if (classificationId) {
    requestedClassification = await adapter.findOne(COLLECTIONS.classifications, {
      tenantId,
      id: classificationId
    }, { projection: { messageId: 1, chatId: 1 } });
    if (!requestedClassification) {
      const error = new Error('Classificacao para reprocessamento nao encontrada');
      error.code = 'classification_not_found';
      error.status = 404;
      throw error;
    }
    messageId = requestedClassification.messageId;
  }
  const message = await adapter.findOne('chatMessages', { tenantId, messageId });
  if (!message) throw new Error('Mensagem para classificacao nao encontrada');
  const lockKey = `ai-classification:${tenantId}:${message.chatId}`;
  return withLock(lockKey, () => classifyMessageLocked({
    tenantId,
    messageId,
    force,
    classificationId,
    reprocessRequestId,
    resolvedMessage: message
  }));
};

export const reviewClassification = async ({ tenantId, classificationId, reviewer, patch }) => {
  const existing = await adapter.findOne(COLLECTIONS.classifications, { tenantId, id: classificationId });
  if (!existing) return null;
  const validated = outputSchema.partial().pick({ intent: true, sentiment: true, nextAction: true, reason: true, suggestedReply: true }).parse(patch || {});
  const updated = { ...existing, ...validated, reviewStatus: 'reviewed', reviewedBy: reviewer?.id || null, reviewedAt: nowIso(), updatedAt: nowIso() };
  await adapter.updateOne(COLLECTIONS.classifications, { id: existing.id }, { $set: updated });
  await routeClassifiedReplyToAttendance({ classification: updated, force: true }).catch((error) => {
    console.warn('[ATTENDANCE_ROUTING] Falha ao aplicar revisao humana ao atendimento', {
      tenantId, classificationId, error: error?.message || 'routing_failed'
    });
  });
  return updated;
};

export const activatePromptVersion = async ({ tenantId = null, promptId, actorId }) => {
  const prompts = await adapter.findMany('aiPromptVersions', { query: { tenantId }, limit: 1000 });
  const target = prompts.find((item) => item.id === promptId);
  if (!target) return null;
  for (const item of prompts) {
    await adapter.updateOne('aiPromptVersions', { id: item.id }, { $set: { active: item.id === promptId, updatedAt: nowIso(), updatedBy: actorId } });
  }
  return { ...target, active: true };
};
