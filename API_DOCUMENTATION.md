# Onion Flows API

REST API behind the Onion Flows panel. Node.js + Express, real-time updates over Socket.io, data in Postgres (production) or a JSON file (local sandbox and tests).

This file lists every route the server mounts, grouped by area. It was generated from `index.js` and `src/routes/*.js`; when in doubt, the route file is the source of truth. Request and response bodies are only detailed where they are not obvious from the panel code (`client/src`).

## Basics

| | |
|---|---|
| Base URL | `http://localhost:3001` locally (`PORT`), your API domain in production |
| Format | JSON in and out. Errors come as `{ "error": "message" }`; newer routes answer `{ "code", "message", "correlationId" }` |
| Auth | `Authorization: Bearer <token>` (JWT from `POST /api/auth/login`) |
| Tenant | Taken from the user's token. A super admin picks a tenant with `?tenantId=<id>` |
| Health | `GET /health` is public; see [Health](#health) |

### Login

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "admin", "password": "sandbox123" }
```

```json
{ "token": "<jwt>", "user": { "id": "...", "username": "admin", "role": "SUPER_ADMIN", "tenantId": null, "cargoEfetivo": { } } }
```

Wrong credentials return `401`. The token expires after `JWT_EXPIRES_IN` (default `8h`).

### Roles and permissions

| Role | Who |
|---|---|
| `SUPER_ADMIN` | Platform operator. Passes every role check; some routes also need a super admin permission (e.g. `tenants:write`) and an allowed IP |
| `PARTNER` | Agency that resells the platform. Only sees `/api/partner/*` and its own tenants |
| `ADMIN` | Owner of a tenant (company) |
| `MANAGER` | Supervisor inside a tenant |
| `AGENT` | Attends conversations |

On top of the role, tenant users have a **cargo** (job profile) with fine-grained permissions such as `fluxos.editar`, `atendimento.fila`, `config.whatsapp` or `dados.lgpd`. In the tables below, **Access** shows the roles allowed; the permission each route checks is in the route file. **manager†** means a MANAGER whose cargo manages that area (team, flows, contacts, conversations or canned responses). SUPER_ADMIN passes every role check and is left out of the tables.

Routes marked **IP** go through the super admin IP allowlist (`superAdminIpCheck` / `superAdminIpWhitelist`) when the caller is a super admin.

### Rate limits

| Scope | Limit (production) |
|---|---|
| Everything under `/api` | 200 requests/min per IP |
| Login | 15 attempts per 15 min |
| Two-factor (TOTP) routes | 20 per 15 min |
| Destructive actions (delete tenant, close all chats, bulk delete) | 10 per hour |
| LGPD export/erase | 30 per hour |
| Turizmo server-to-server | 120 per min |

Limits are higher with `NODE_ENV=development`.

---

## Auth

| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/api/auth/login` | public | Sign in, returns token and user |
| POST | `/api/auth/logout` | any | Records the logout and marks the user offline |
| POST | `/api/auth/confirm-password` | any | Re-checks the password before a sensitive action |
| GET | `/api/auth/heartbeat` | any | Keeps the session alive and refreshes presence |
| GET | `/api/auth/totp/status` | any | Whether two-factor auth is on |
| POST | `/api/auth/totp/setup` | any | Starts two-factor setup (secret + QR) |
| POST | `/api/auth/totp/confirm` | any | Confirms setup with a code |
| POST | `/api/auth/totp/disable` | any | Turns two-factor off |
| POST | `/api/auth/totp/elevate` | any | Exchanges a code for an elevated session |

## Tenants

All **IP**.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/tenants` | SUPER_ADMIN | List tenants |
| POST | `/api/tenants` | SUPER_ADMIN | Create a tenant |
| PUT | `/api/tenants/:tenantId` | SUPER_ADMIN | Update a tenant |
| DELETE | `/api/tenants/:tenantId` | SUPER_ADMIN | Delete a tenant |
| PATCH | `/api/tenants/:tenantId/environment` | SUPER_ADMIN | Mark as production/test (affects metrics and billing) |
| POST | `/api/tenants/:tenantId/switch` | SUPER_ADMIN | Switch the super admin into a tenant |
| GET | `/api/tenants/tenant/current` | any | Current tenant of the logged user (also at `/api/tenant/current`) |
| GET | `/api/tenants/:tenantId/users` | ADMIN, MANAGER | Users of the tenant |
| GET | `/api/tenants/:tenantId/analytics` | ADMIN, MANAGER | Tenant analytics summary |
| GET | `/api/tenants/:tenantId/chats` | ADMIN, MANAGER | Tenant chats |
| GET | `/api/tenants/:tenantId/settings` | ADMIN, MANAGER, AGENT | Tenant settings |
| PUT | `/api/tenants/:tenantId/settings` | ADMIN | Update tenant settings |
| POST | `/api/tenants/billing/auto-block-scan` | SUPER_ADMIN | Run the overdue-billing scan now |
| POST | `/api/tenants/:tenantId/billing/block` | SUPER_ADMIN | Pause the tenant for billing (messages are still saved) |
| POST | `/api/tenants/:tenantId/billing/unblock` | SUPER_ADMIN | Lift the billing pause |
| POST | `/api/tenants/:tenantId/billing/trust-unblock` | SUPER_ADMIN | Unblock until `untilDate`, once per month |

## Users, roles and team

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/users` | ADMIN, MANAGER | List users (**IP**) |
| POST | `/api/users` | ADMIN, manager† | Create user |
| PUT | `/api/users/:id` | ADMIN, manager† | Update user |
| DELETE | `/api/users/:id` | ADMIN, manager† | Delete user |
| PUT | `/api/users/:id/permissions` | SUPER_ADMIN | Super admin permissions of another operator |
| GET | `/api/cargos` | any tenant user | Job profiles (cargos) and their permissions |
| GET | `/api/queues` | any tenant user | List queues (**IP**) |
| POST | `/api/queues` | ADMIN, manager† | Create queue |
| PUT | `/api/queues/:id` | ADMIN, manager† | Update queue |
| PUT | `/api/queues/:id/agents` | ADMIN, manager† | Set the agents of a queue |
| DELETE | `/api/queues/:id` | ADMIN, manager† | Delete queue |
| GET | `/api/schedules` | any tenant user | Business hours |
| POST | `/api/schedules` | ADMIN | Create business hours |
| DELETE | `/api/schedules/:id` | ADMIN | Delete business hours |
| GET | `/api/attendance-routing/profile` | ADMIN, MANAGER | Routing profile (how chats are distributed) |
| PUT | `/api/attendance-routing/profile` | ADMIN, MANAGER | Update routing profile |
| GET | `/api/attendance-routing/decisions` | ADMIN, MANAGER | Recent routing decisions |
| POST | `/api/attendance-routing/decisions/:id/retry` | ADMIN, MANAGER | Retry a routing decision |

## Flows

All **IP** for super admins.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/flows` | ADMIN, MANAGER | List flows |
| POST | `/api/flows` | ADMIN, manager† | Create flow |
| GET | `/api/flows/:id` | ADMIN, MANAGER | Get a flow (draft and published) |
| PUT | `/api/flows/:id` | ADMIN, manager† | Save draft or publish |
| DELETE | `/api/flows/:id` | ADMIN, manager† | Delete flow |
| GET | `/api/flows/:id/publish-history` | ADMIN, MANAGER | Published versions |
| POST | `/api/flows/:id/rollback` | ADMIN | Restore a published version |
| POST | `/api/flows/validate-script` | ADMIN, manager† | Validate a script node the same way the engine runs it |
| GET | `/api/flows/snippets/library` | ADMIN, MANAGER | Saved node snippets |
| POST | `/api/flows/snippets/library` | ADMIN, manager† | Save a snippet |
| DELETE | `/api/flows/snippets/library/:snippetId` | ADMIN, manager† | Delete a snippet |
| POST | `/api/flows/:id/test-sessions` | ADMIN, manager† | Start a simulator session |
| POST | `/api/flows/:id/test-sessions/:sessionId/input` | ADMIN, manager† | Send a message or button reply to the simulator |
| DELETE | `/api/flows/:id/test-sessions/:sessionId` | ADMIN, manager† | End a simulator session |
| POST | `/api/flow-assistant` | ADMIN, manager† | AI assistant: turns a request in plain language into proposed flow changes |
| GET | `/api/subflows` | ADMIN, MANAGER | List subflows |
| GET | `/api/subflows/:id` | ADMIN, MANAGER | Get a subflow |
| GET | `/api/subflows/:id/usage` | ADMIN, MANAGER | Which flows use this subflow |
| POST | `/api/subflows` | ADMIN, manager† | Create subflow |
| PUT | `/api/subflows/:id` | ADMIN, manager† | Update subflow |
| DELETE | `/api/subflows/:id` | ADMIN, manager† | Delete subflow |
| GET | `/api/variables` | any tenant user | Tenant variables |
| POST | `/api/variables` | ADMIN, manager† | Create variable |
| PUT | `/api/variables/:id` | ADMIN, manager† | Update variable |
| DELETE | `/api/variables/:id` | ADMIN, manager† | Delete variable |
| GET | `/api/rest-integrations` | any tenant user | Saved REST integrations used by API nodes |
| POST | `/api/rest-integrations` | ADMIN, manager† | Create integration |
| PATCH | `/api/rest-integrations/:id` | ADMIN, manager† | Update integration |
| DELETE | `/api/rest-integrations/:id` | ADMIN, manager† | Delete integration |
| POST | `/api/rest-integrations/:id/test` | ADMIN, manager† | Call the integration once to test it |

## Templates and interactive messages

**IP** for super admins.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/templates` | any tenant user | Local templates |
| POST | `/api/templates` | ADMIN | Create local template |
| DELETE | `/api/templates/:id` | ADMIN | Delete local template |
| GET | `/api/templates/whatsapp` | any tenant user | WhatsApp (Meta) templates of the account |
| POST | `/api/templates/whatsapp/submit` | ADMIN | Submit a new template to Meta and resync |
| POST | `/api/templates/whatsapp/sync` | ADMIN | Resync templates from Meta |
| GET | `/api/templates/whatsapp/interactive` | any tenant user | Saved interactive messages (buttons, lists) |
| POST | `/api/templates/whatsapp/interactive` | ADMIN | Create interactive message |
| PUT | `/api/templates/whatsapp/interactive/:id` | ADMIN | Update interactive message |
| DELETE | `/api/templates/whatsapp/interactive/:id` | ADMIN | Delete interactive message |
| POST | `/api/templates/whatsapp/interactive/export` | ADMIN | Export selected items to a file |
| POST | `/api/templates/whatsapp/interactive/import` | ADMIN | Import a file (`dryRun` previews without saving) |

## Conversations

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/chats` | any tenant user | List chats |
| GET | `/api/chats/:id` | any tenant user | Get a chat with messages |
| GET | `/api/chats/:id/timeline` | any tenant user | Event timeline of a chat |
| GET | `/api/chats/history` | any tenant user | Closed conversations |
| GET | `/api/chats/history/:cpf` | any tenant user | History by customer document |
| GET | `/api/chats/my-queues` | any tenant user | Queues of the logged agent with waiting chats |
| GET | `/api/chats/agent/:agentId` | any tenant user | Chats of an agent |
| GET | `/api/chats/agent-dashboard/me` | any tenant user | Agent's own dashboard (today, month, rating) |
| GET | `/api/chats/transfer-options` | any tenant user | Queues and agents available for transfer |
| POST | `/api/chats/init` | ADMIN, AGENT | Start or reuse a simulation chat |
| POST | `/api/chats/:id/messages` | ADMIN, AGENT | Send a message |
| POST | `/api/chats/:id/media` | ADMIN, AGENT | Send media (image, audio, document) |
| PUT | `/api/chats/:id/vars` | ADMIN, AGENT | Update chat variables |
| POST | `/api/chats/pickup` | ADMIN, AGENT | Take the next chat from a queue |
| POST | `/api/chats/pickup-all` | ADMIN, AGENT | Take every waiting chat the agent can serve |
| POST | `/api/chats/transfer` | ADMIN, AGENT, manager† | Transfer to another queue or agent |
| PUT | `/api/chats/:id/close` | ADMIN, AGENT, manager† | Close a chat |
| POST | `/api/chats/:id/resume` | ADMIN, AGENT, manager† | Hand the chat back to the flow (e.g. for the rating step) |
| POST | `/api/chats/transfer-legacy-disabled` | any tenant user | Old transfer route, kept disabled |
| GET | `/api/cannedResponses` | ADMIN, MANAGER, AGENT | Canned responses |
| POST | `/api/cannedResponses` | ADMIN, manager† | Create canned response |
| PUT | `/api/cannedResponses/:id` | ADMIN, manager† | Update canned response |
| DELETE | `/api/cannedResponses/:id` | ADMIN, manager† | Delete canned response |
| GET | `/api/tags` | ADMIN, MANAGER | Tags |
| POST | `/api/tags` | ADMIN, manager† | Create tag |
| PUT | `/api/tags/:id` | ADMIN, manager† | Update tag |
| DELETE | `/api/tags/:id` | ADMIN, manager† | Delete tag |
| GET | `/api/media/assets` | any tenant user | Media library |
| POST | `/api/media/assets` | ADMIN, AGENT | Upload to the media library |
| DELETE | `/api/media/assets/:id` | ADMIN | Delete media |
| GET | `/api/tasks/assigned` | ADMIN, MANAGER, AGENT | Tasks assigned to the logged user |
| GET | `/api/tasks/internal` | any tenant user | Internal tasks |
| POST | `/api/tasks/internal` | any tenant user | Create internal task |
| GET | `/api/tasks/internal/:id` | any tenant user | Get internal task |
| POST | `/api/tasks/internal/:id/actions` | any tenant user | Move a task (start, finish, cancel...) |

## Voice calls (WhatsApp)

**IP** for super admins.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/voice-calls` | ADMIN, MANAGER | Call log |
| GET | `/api/voice-calls/current` | ADMIN, MANAGER, AGENT | Call ringing or in progress for the user |
| POST | `/api/voice-calls/:callId/accept` | ADMIN, MANAGER, AGENT | Accept (WebRTC SDP answer in `sdp`) |
| POST | `/api/voice-calls/:callId/decline` | ADMIN, MANAGER, AGENT | Decline |
| POST | `/api/voice-calls/:callId/hangup` | ADMIN, MANAGER, AGENT | Hang up |
| GET | `/api/voice-calls/settings` | ADMIN, MANAGER | Call settings in the panel |
| PUT | `/api/voice-calls/settings` | ADMIN | Update call settings |
| GET | `/api/voice-calls/meta` | ADMIN, MANAGER | Call settings on the WhatsApp number |
| PUT | `/api/voice-calls/meta` | ADMIN | Update call settings on Meta |

## Contacts and campaigns

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/contacts` | ADMIN, MANAGER, AGENT | List contacts |
| POST | `/api/contacts` | ADMIN, AGENT, manager† | Create contact |
| POST | `/api/contacts/bulk` | ADMIN, AGENT, manager† | Import contacts |
| PUT | `/api/contacts/:id` | ADMIN, AGENT, manager† | Update contact |
| DELETE | `/api/contacts/:id` | ADMIN, AGENT, manager† | Delete contact |
| DELETE | `/api/contacts` | ADMIN, AGENT* | Bulk delete (needs the `dados.lgpd` permission) |
| GET | `/api/contacts/:id/whatsapp/block-status` | ADMIN | Whether the number is blocked on WhatsApp |
| POST | `/api/contacts/:id/whatsapp/block` | ADMIN | Block the number on WhatsApp |
| DELETE | `/api/contacts/:id/whatsapp/block` | ADMIN | Unblock |
| POST | `/api/contacts/:id/outreach` | ADMIN, AGENT* | Send a template to one contact |
| GET | `/api/contacts/outreach/capabilities` | ADMIN, MANAGER, AGENT | Whether the user may send outbound messages |
| GET | `/api/contacts/outreach/history` | ADMIN, MANAGER, AGENT | Sends history |
| GET | `/api/contacts/outreach/campaigns` | ADMIN, MANAGER, AGENT | Campaigns started from contacts |
| GET | `/api/contacts/outreach/campaigns/:id` | ADMIN, MANAGER, AGENT | Campaign detail |
| POST | `/api/contacts/outreach/campaigns` | ADMIN, AGENT* | Start a campaign from selected contacts |
| GET | `/api/outreach/capabilities` | ADMIN, MANAGER | Outbound limits and channel status (**IP**) |
| GET | `/api/outreach/campaigns` | ADMIN, MANAGER | List campaigns |
| POST | `/api/outreach/campaigns` | ADMIN | Create campaign |
| GET | `/api/outreach/campaigns/:id` | ADMIN, MANAGER | Campaign detail |
| GET | `/api/outreach/campaigns/:id/items` | ADMIN, MANAGER | Recipients and status of each |
| GET | `/api/outreach/campaigns/:id/metrics` | ADMIN, MANAGER | Sent, delivered, read, replied, failed |
| POST | `/api/outreach/campaigns/:id/pause` | ADMIN | Pause |
| POST | `/api/outreach/campaigns/:id/resume` | ADMIN | Resume |
| POST | `/api/outreach/campaigns/:id/cancel` | ADMIN | Cancel |
| POST | `/api/outreach/campaigns/:id/reprocess-failures` | ADMIN | Retry failed recipients |
| GET | `/api/outreach/suppressions` | ADMIN, MANAGER | Do-not-contact list |
| POST | `/api/outreach/suppressions` | ADMIN | Add to the list |
| DELETE | `/api/outreach/suppressions/:id` | ADMIN | Remove from the list |
| GET | `/api/cadences` | ADMIN, MANAGER | Follow-up cadences (**IP**) |
| POST | `/api/cadences` | ADMIN | Create cadence |
| PATCH | `/api/cadences/:id` | ADMIN | Update cadence |
| POST | `/api/cadences/:id/activate` | ADMIN | Activate |
| POST | `/api/cadences/:id/pause` | ADMIN | Pause |
| POST | `/api/cadences/:id/duplicate` | ADMIN | Duplicate |

\* Agents need the matching permission in their cargo (`atendimento.ativo` for sends). Campaigns of a tenant paused for billing return `402 billing_paused`.

## LGPD (data subject requests)

| Method | Path | Access | Description |
|---|---|---|---|
| POST | `/api/contacts/data-subject/export` | ADMIN | Everything stored about a phone number, as JSON (portability) |
| POST | `/api/contacts/data-subject/preview` | ADMIN | What an erasure would remove (counts only) |
| POST | `/api/contacts/data-subject/erase` | ADMIN | Erase the data subject's records |

## WhatsApp, Telegram and catalog

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/channels` | ADMIN | Channel configuration (**IP**) |
| GET | `/api/channels/entries` | ADMIN | Entry points (number → flow) |
| POST | `/api/channels/entries` | ADMIN | Create entry point |
| DELETE | `/api/channels/entries/:channelId` | ADMIN | Delete entry point |
| PATCH | `/api/channels/flow-routing` | ADMIN | Which flow answers each number |
| PUT | `/api/channels/whatsapp` | ADMIN | Save WhatsApp credentials manually |
| POST | `/api/channels/whatsapp/embedded-signup` | ADMIN | Finish Meta Embedded Signup (exchange the `code`) |
| POST | `/api/channels/whatsapp/phone-numbers` | ADMIN | Discover the numbers of a WABA |
| POST | `/api/channels/whatsapp/register-number` | ADMIN | Register the number on the Cloud API |
| POST | `/api/channels/whatsapp/subscribe-webhook` | ADMIN | Subscribe the app to the WABA webhooks |
| POST | `/api/channels/whatsapp/disconnect` | ADMIN | Disconnect the number (`confirm: true` required) |
| GET | `/api/channels/whatsapp/diagnostics` | ADMIN | Connection checks |
| GET | `/api/channels/whatsapp/insights` | ADMIN | Account dashboard (quality, limits, costs); `?refresh=1` skips the cache |
| GET | `/api/channels/whatsapp/alerts` | ADMIN | Account alerts from Meta |
| POST | `/api/channels/whatsapp/alerts/read` | ADMIN | Mark alerts as read (all, without `ids`) |
| GET | `/api/channels/whatsapp/business-profile` | ADMIN | Business profile |
| PUT | `/api/channels/whatsapp/business-profile` | ADMIN | Update business profile |
| GET | `/api/channels/whatsapp/profile-identity` | ADMIN | Display name and picture |
| POST | `/api/channels/whatsapp/display-name` | ADMIN | Request a new display name |
| POST | `/api/channels/whatsapp/profile-picture` | ADMIN | Change profile picture |
| PUT | `/api/channels/telegram` | ADMIN | Save Telegram bot token |
| POST | `/api/channels/telegram/webhook` | ADMIN | Point the Telegram bot to this API |
| GET | `/api/catalog/items` | any tenant user | Product catalog |
| POST | `/api/catalog/items` | ADMIN | Create product |
| PUT | `/api/catalog/items/:id` | ADMIN | Update product |
| DELETE | `/api/catalog/items/:id` | ADMIN | Delete product |
| POST | `/api/catalog/items/:id/meta-sync` | ADMIN | Push one product to the Meta catalog |
| GET | `/api/catalog/meta` | ADMIN | Meta catalog settings |
| PUT | `/api/catalog/meta` | ADMIN | Update Meta catalog settings |
| POST | `/api/catalog/meta/test` | ADMIN | Test the Meta catalog connection |
| POST | `/api/catalog/meta/sync` | ADMIN | Sync the whole catalog |

### Incoming webhooks (public)

| Method | Path | Description |
|---|---|---|
| GET | `/api/whatsapp/webhook` | Meta verification (`hub.verify_token` = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`) |
| POST | `/api/whatsapp/webhook` | Messages, statuses, calls and account events. Checked with `X-Hub-Signature-256`, then queued (Redis/BullMQ) and answered right away |
| POST | `/api/telegram/webhook` | Telegram updates (single bot) |
| POST | `/api/telegram/webhook/:tenantId` | Telegram updates for a tenant's bot |
| GET | `/api/telegram/health` | Telegram integration status |
| POST | `/api/billing/asaas/webhook` | Asaas payment events (checked with the `asaas-access-token` header) |

### Outgoing webhook registrations

**IP** for super admins. Stores `{ name, url, events, secret }` per tenant for external integrations. The API keeps the registrations but does not dispatch them yet.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/webhooks` | ADMIN | List registrations |
| POST | `/api/webhooks` | ADMIN | Create registration |
| PUT | `/api/webhooks/:id` | ADMIN | Update registration |
| DELETE | `/api/webhooks/:id` | ADMIN | Delete registration |

## Analytics and reports

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/analytics/overview` | ADMIN, MANAGER | Totals for a period |
| GET | `/api/analytics/timeseries` | ADMIN, MANAGER | Conversations per day |
| GET | `/api/analytics/funnel` | ADMIN, MANAGER | Flow funnel |
| GET | `/api/analytics/bottlenecks` | ADMIN, MANAGER | Where customers drop or wait |
| GET | `/api/analytics/monthly` | ADMIN, MANAGER | Month summary, ratings per agent and queue |
| GET | `/api/metrics/tenant` | ADMIN, MANAGER | Live metrics for the monitor |
| POST | `/api/metrics/web-vitals` | any | Panel performance samples |
| GET | `/api/reports/summary` | ADMIN, MANAGER | Report summary |
| GET | `/api/reports/export.zip` | ADMIN, MANAGER | Every report in one ZIP |
| GET | `/api/reports/<name>.csv` | ADMIN, MANAGER | One report: `resumo-geral`, `conversas`, `mensagens`, `filas`, `agentes`, `fluxo-nodes`, `campanhas`, `templates-whatsapp`, `erros` |

## Tenant modules

Panel pages that read several sources at once. All under `/api/tenant-modules`, **IP**.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/overview` | ADMIN, MANAGER | Home summary |
| GET | `/inbox` | ADMIN, MANAGER | Inbox overview |
| GET | `/campaigns` | ADMIN, MANAGER | Campaigns overview |
| GET | `/incidents` | ADMIN, MANAGER | Incidents (failed sends, flow errors) |
| PATCH | `/incidents/:incidentId` | ADMIN | Set status: `open`, `resolved` or `ignored` |
| GET | `/audit` | ADMIN, MANAGER | Audit trail |
| GET | `/usage` | ADMIN, MANAGER | Plan usage |
| GET | `/performance` | ADMIN, MANAGER | Team performance |
| GET | `/library` | ADMIN, MANAGER | Content library |
| GET | `/library/:itemId` | ADMIN, MANAGER | Library item |
| POST | `/library` | ADMIN | Create library item |
| PATCH | `/library/:itemId` | ADMIN | Update library item |
| DELETE | `/library/:itemId` | ADMIN | Delete library item |
| GET | `/tests/flows/:flowId` | ADMIN, MANAGER | Static check of a flow (`?source=published` or `draft`) |
| GET | `/settings/:moduleKey` | ADMIN, MANAGER | Module settings |
| PATCH | `/settings/:moduleKey` | ADMIN | Update module settings |

## AI classification

**IP**.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/classifications` | ADMIN, MANAGER | Messages classified by the AI |
| GET | `/api/classifications/:id` | ADMIN, MANAGER | One classification |
| POST | `/api/classifications/:id/review` | ADMIN, MANAGER | Human review of a classification |
| POST | `/api/classifications/:id/reprocess` | ADMIN, MANAGER | Classify again |
| GET | `/api/classifications/prompts/versions` | SUPER_ADMIN | Prompt versions |
| POST | `/api/classifications/prompts/versions` | SUPER_ADMIN | New prompt version |
| POST | `/api/classifications/prompts/versions/:id/activate` | SUPER_ADMIN | Activate a prompt version |

## Branding and partners (white label)

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/branding/public` | public | Brand for the login page, by host (`?host=agency.<domain>`) |
| GET | `/api/branding` | any | Brand of the logged user (partner or tenant) |
| GET | `/api/partner/me` | PARTNER | The partner's own account |
| GET | `/api/partner/tenants` | PARTNER | Tenants of the partner |
| POST | `/api/partner/tenants` | PARTNER | Create a tenant (with its first admin) |
| PATCH | `/api/partner/tenants/:tenantId` | PARTNER | Update a tenant |
| GET | `/api/partner/branding` | PARTNER | Partner brand |
| PATCH | `/api/partner/branding` | PARTNER | Update logo, colors, name, support contact, login image |
| GET | `/api/partner/billing` | PARTNER | Price per tenant, active tenants and invoices |
| GET | `/api/partners` | SUPER_ADMIN | List partners (**IP**) |
| POST | `/api/partners` | SUPER_ADMIN | Create partner |
| POST | `/api/partners/:partnerId/access` | SUPER_ADMIN | Create a login for an existing partner |
| PATCH | `/api/partners/:partnerId/address` | SUPER_ADMIN | Set the agency subdomain (empty removes it) |
| PATCH | `/api/partners/:partnerId/billing` | SUPER_ADMIN | Price and billing data of a partner |
| GET | `/api/partners/:partnerId/invoices` | SUPER_ADMIN | Partner invoices |
| POST | `/api/partners/:partnerId/invoices/generate` | SUPER_ADMIN | Generate this month's invoice now |
| PUT | `/api/partners/tenants/:tenantId` | SUPER_ADMIN | Move a tenant to a partner (`partnerId`, or `null` to detach) |
| GET | `/api/partners/billing-settings` | SUPER_ADMIN | Asaas settings |
| PUT | `/api/partners/billing-settings` | SUPER_ADMIN | Update Asaas settings |
| POST | `/api/partners/billing-settings/test` | SUPER_ADMIN | Test the Asaas connection |

## Super admin and system

**IP** on all of them.

| Method | Path | Description |
|---|---|---|
| GET | `/api/super-admin/dashboard` | Platform dashboard |
| GET | `/api/super-admin/monitoring` | Live load per tenant |
| GET | `/api/super-admin/version` | Running release, uptime and infrastructure |
| GET | `/api/super-admin/errors` | Open Sentry issues (API and panel) |
| GET | `/api/super-admin/web-vitals` | Panel performance |
| GET | `/api/super-admin/web-vitals/export` | Panel performance as CSV |
| POST | `/api/super-admin/chats/close-all` | Close every open chat (only one tenant's with `tenantId`) |
| POST | `/api/super-admin/external-token` | Long-lived token for a tenant user (ADMIN, MANAGER or AGENT) used by an integration |
| GET | `/api/super-admin/external-token/users` | Users that can receive an external token |
| GET | `/api/super-admin/ip-allowlist` | Allowed IPs |
| POST | `/api/super-admin/ip-allowlist` | Add IP or range |
| PATCH | `/api/super-admin/ip-allowlist/:id` | Update entry |
| DELETE | `/api/super-admin/ip-allowlist/:id` | Remove entry |
| POST | `/api/super-admin/ip-allowlist/temporary` | Allow an IP for N hours (default: the caller's) |
| GET | `/api/super-admin/ip-allowlist/audit` | Accesses checked by the allowlist |
| GET | `/api/logs` | Audit log |
| GET | `/api/system/queues` | Redis/BullMQ queue status |
| GET | `/api/system/commercial-health` | Database, Redis, BullMQ, AI provider, cadences, Turizmo bridge and campaign worker status (no credentials) |
| GET | `/api/documentation` | In-panel technical docs |

## Integrations

### Turizmo (server-to-server)

Bridge with Turizmo, a separate prospecting system that hands leads and campaigns to Onion Flows. Calls use `X-API-Key` (`TURIZMO_INBOUND_API_KEY`); the status, test and outbox routes use a super admin JWT. See [docs/OUTREACH_ECOSYSTEM_API.md](docs/OUTREACH_ECOSYSTEM_API.md).

| Method | Path | Description |
|---|---|---|
| POST | `/api/integrations/turizmo/contacts/upsert` | Create or update a lead as contact |
| DELETE | `/api/integrations/turizmo/contacts/:turizmoLeadId` | Remove a lead |
| POST | `/api/integrations/turizmo/campaigns` | Create a campaign |
| GET | `/api/integrations/turizmo/campaigns/:turizmoCampaignId` | Campaign status |
| POST | `/api/integrations/turizmo/campaigns/:turizmoCampaignId/:action` | Pause, resume or cancel |
| POST | `/api/integrations/turizmo/commands` | Generic command |
| POST | `/api/integrations/turizmo/media/assets` | Upload media for campaigns |
| GET | `/api/integrations/turizmo/events` | Pull pending events (replies, statuses) |
| POST | `/api/integrations/turizmo/events/ack` | Acknowledge events |
| GET | `/api/integrations/turizmo/status` | Bridge status (super admin) |
| POST | `/api/integrations/turizmo/test` | Send a test event (super admin) |
| GET | `/api/integrations/turizmo/outbox` | Outgoing events not delivered yet (super admin) |
| POST | `/api/integrations/turizmo/outbox/:id/retry` | Retry an outgoing event (super admin) |

### Load test helpers

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/load-test/smoke` | ADMIN | Times the main tenant queries, used by `load-tests/` |
| POST | `/api/load-test/seed-client` | ADMIN | Create a fake customer with a conversation (open or waiting) |

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ "status": "ok" }`. Public, for uptime monitors; does not expose versions |
| GET | `/health/live` | Process is up |
| GET | `/health/ready` | Database reachable, and Redis when `REDIS_ENABLED=true`; `503` otherwise |
| GET | `/health/recursos` | `503` when available memory is under 200 MB or the 5-minute load is above 1.5 |

## Real-time events (Socket.io)

Connect to the API URL with the JWT: `io(API_URL, { auth: { token } })`. The server puts each socket in the rooms `tenant:<id>`, `user:<id>` and `agent:<id>` (plus `role:SUPER_ADMIN` for super admins). A super admin (or a partner, for its own tenants) joins another tenant with `subscribe_tenant`.

**Server → client**

| Event | When |
|---|---|
| `new_chat_in_queue` | A conversation entered a queue |
| `agent_assigned` | A conversation was assigned to an agent |
| `new_message` | New message in a conversation |
| `message_delivery` | WhatsApp status (sent, delivered, read, failed) |
| `chat_event` | New event in a chat timeline |
| `chat_closed` | Conversation closed |
| `user_status` | Agent went online or offline |
| `voice_call_ringing` / `voice_call_ringing_stop` / `voice_call_ended` | Incoming WhatsApp call lifecycle |
| `campaign_created` / `campaign_update` / `campaign.started` / `campaign.completed` | Campaign progress |
| `whatsapp_error` | Send failure reported by Meta |
| `whatsapp_account_alert` | New account alert (quality, limits, name review) |
| `new_log` | New audit log entry (sent to every connected socket) |

**Client → server**

| Event | Purpose |
|---|---|
| `subscribe_tenant` | Join a tenant's room (super admin or partner) |
| `ext:*`, `cmd:resultado` | Used by the browser extension that mirrors conversations into an external contact center (the server also emits `new_chat` on that path) |

## Configuration

Every environment variable is listed with comments in [`.env.example`](.env.example) (API), [`.env.sandbox.example`](.env.sandbox.example) (local mode) and [`client/.env.example`](client/.env.example) (panel).
