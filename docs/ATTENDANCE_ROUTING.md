# Roteamento de atendimento

O roteamento de respostas e um recurso multi-tenant e orientado por perfis. Nenhuma regra de empresa, fila ou campanha fica codificada no processamento de mensagens.

## Fluxo

1. A campanha envia o template e cria apenas um chat diferido (`attendanceDeferred=true`).
2. A resposta do contato e atribuida ao outreach, item e campanha.
3. A classificacao e persistida.
4. O perfil ativo do tenant e avaliado na ordem das regras.
5. A decisao pode enfileirar, suprimir ou ignorar a resposta.
6. Ao enfileirar, o chat existente passa para `waiting`; nao e criado um segundo atendimento.
7. Tomada, transferencia e encerramento usam as rotas normais de chats e sincronizam a tarefa comercial e a outbox.

O outreach ativo manual nao usa o estado diferido e continua abrindo um atendimento atribuido ao agente que realizou o envio.

## Configuracao

Endpoints protegidos:

- `GET /api/attendance-routing/profile?tenantId=...&trigger=campaign_reply`
- `PUT /api/attendance-routing/profile?tenantId=...`
- `GET /api/attendance-routing/decisions?tenantId=...`
- `POST /api/attendance-routing/decisions/:id/retry?tenantId=...`

O perfil referencia filas por `id`. O nome da fila pode mudar sem invalidar a regra. Se nao existir perfil, o backend cria um perfil inicial usando filas ativas do tenant. Se nenhuma fila estiver disponivel, a decisao fica em `routing_pending` e pode ser repetida depois da configuracao.

As condicoes de uma regra sao declarativas e combinadas por `AND`. `any` e `all` permitem agrupamentos. Campos aceitos:

- `optOutDetected`
- `requiresHumanReview`
- `intentIn`
- `sentimentIn`
- `nextActionIn`
- `nextActionNotIn`
- `confidenceLt`
- `confidenceGte`
- `sourceIn`

As acoes aceitas sao `enqueue`, `suppress` e `ignore`.

## Idempotencia

A chave da decisao combina tenant, mensagem, perfil e versao. Reprocessar o mesmo job nao duplica decisao, atendimento ou tarefa. Uma nova versao do perfil permite reavaliacao explicita, mas reutiliza o chat aberto.

## Integracoes

Os eventos `attendance.queued`, `attendance.assigned`, `attendance.transferred` e `attendance.closed` usam a outbox existente. Falhas no destino externo nao bloqueiam o atendimento no Onion.
