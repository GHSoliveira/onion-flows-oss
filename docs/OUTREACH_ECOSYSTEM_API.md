# API do ecossistema comercial

Base: `/api`. Todas as rotas exigem JWT e isolamento pelo tenant resolvido no backend. O `tenantId` do corpo nunca define o escopo. Erros novos seguem `{ "code", "message", "correlationId" }`.

## Campanhas

- `POST /outreach/campaigns`: cria campanha. ADMIN.
- `GET /outreach/capabilities`: informa permissoes comerciais e estado das flags para a interface.
- `GET /outreach/campaigns?page=1&limit=25&status=&search=`: lista resumida. ADMIN; MANAGER somente com `CLIENT_CAMPAIGN_ACCESS_ENABLED=true`.
- `GET /outreach/campaigns/:id`: detalhe da campanha.
- `GET /outreach/campaigns/:id/items?page=1&limit=25&status=`: destinatarios.
- `GET /outreach/campaigns/:id/metrics`: funil e tempos de resposta.
- `POST /outreach/campaigns/:id/pause`: pausa.
- `POST /outreach/campaigns/:id/resume`: retoma.
- `POST /outreach/campaigns/:id/cancel`: cancela itens ainda nao processados.
- `POST /outreach/campaigns/:id/reprocess-failures`: reenfileira falhas.

Exemplo de criacao:

```json
{
  "name": "Prospeccao agosto",
  "channel": "whatsapp",
  "contactIds": ["contact_1", "contact_2"],
  "templateId": "wa_tpl_1",
  "senderPhoneNumberId": "100000000000001",
  "cadenceId": null,
  "values": { "body": ["Maria"] }
}
```

O limite padrao e de 250 contatos por campanha e pode ser ajustado no backend com `OUTREACH_CAMPAIGN_MAX_CONTACTS` (intervalo tecnico de 1 a 1000). Requisicoes acima do limite retornam `400` com `code: "campaign_contact_limit_exceeded"`. O limite e validado tanto na API moderna quanto na rota legada e novamente no servico, evitando bypass por chamadas internas.

## Cadencias

- `POST /cadences`: cria rascunho ou cadencia ativa. ADMIN.
- `GET /cadences?page=1&limit=25`: lista. ADMIN; MANAGER somente com `CLIENT_CAMPAIGN_ACCESS_ENABLED=true`.
- `PATCH /cadences/:id`: edita. ADMIN.
- `POST /cadences/:id/activate`: ativa.
- `POST /cadences/:id/pause`: pausa.
- `POST /cadences/:id/duplicate`: cria copia em rascunho.

Cada etapa aceita `delayMinutes`, `action`, `templateId`, remetente, valores, condicoes e regras de desvio. `action` pode ser `send_template` ou `close_cadence`.

## Classificacoes

- `GET /classifications?page=1&limit=25&reviewStatus=&intent=`: fila de classificacoes.
- `GET /classifications/:id`: detalhe sanitizado.
- `POST /classifications/:id/review`: revisao humana.
- `POST /classifications/:id/reprocess`: novo job assincrono.

Gestao de prompts, exclusiva para SUPER_ADMIN:

- `GET /classifications/prompts/versions`
- `POST /classifications/prompts/versions`
- `POST /classifications/prompts/versions/:id/activate`

## Integracao Turizmo

Exclusiva para SUPER_ADMIN:

- `GET /integrations/turizmo/status`
- `POST /integrations/turizmo/test`
- `GET /integrations/turizmo/outbox?page=1&limit=25&status=`
- `POST /integrations/turizmo/outbox/:id/retry`

O endpoint de teste persiste um evento `integration.test` na outbox e realiza um POST real no Turizmo, sem criar contato, campanha ou mensagem comercial. Respostas `2xx` confirmam conectividade; `401/403` retornam falha de autenticacao; timeout retorna `504`; indisponibilidade ou `5xx` retornam `502`. A resposta e os logs nunca incluem a API key.

Ponte inbound servidor-a-servidor, autenticada por `X-API-Key` e sem JWT:

- `POST /integrations/turizmo/contacts/upsert`: sincroniza contatos por `tenantId + turizmoLeadId`, com reconciliacao por telefone.
- `POST /integrations/turizmo/campaigns`: cria campanha a partir de `turizmoLeadIds` sincronizados.
- `GET /integrations/turizmo/campaigns/:turizmoCampaignId?tenantId=...`: reconcilia o estado da campanha.
- `POST /integrations/turizmo/test`: valida chave e tenant sem criar dados comerciais.

Os dois endpoints de escrita exigem `Idempotency-Key`. Consulte `docs/TURIZMO_INBOUND_BRIDGE.md` para contratos e exemplos completos.

## Diagnostico comercial

- `GET /system/commercial-health`: exclusivo para SUPER_ADMIN. Resume banco, Redis, BullMQ, IA, cadencias, Turizmo, worker de campanhas e metricas V2 sem expor credenciais.

Os campos `enabled` indicam configuracao por feature flag. Os campos `ready`, `configured` e `workerActive` indicam capacidade operacional real no processo consultado.

## Workspace e metricas

- `GET /tasks/assigned`: tarefas do agente ou do tenant.
- `GET /metrics/tenant?from=&to=`: atendimento, funil comercial e desempenho por atendente autorizado.
- `GET /chats/:id`: inclui `commercialInsights` quando houver classificacao, sem dados brutos do provedor.

## LGPD

- `POST /contacts/data-subject/export`: exporta contato, chats, mensagens, eventos, outreach e classificacoes.
- `POST /contacts/data-subject/erase`: elimina dados vinculaveis, incluindo classificacoes e itens comerciais. Exige confirmacao e motivo.
