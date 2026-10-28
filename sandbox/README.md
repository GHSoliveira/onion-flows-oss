# Sandbox local

Ambiente local separado da producao, com banco JSON. Nao precisa de Postgres,
Redis nem conta na Meta.

## Subir

```bash
cp .env.sandbox.example .env.sandbox
npm run sandbox                 # API em http://localhost:3001
npm --prefix client run dev     # painel em http://localhost:5173
```

`npm run sandbox` cria (ou atualiza) os usuarios de teste e sobe a API.

## Logins

- Super admin: `admin` / `sandbox123`
- Atendente: `agent` / `sandbox123`

## Arquivos locais

- Banco JSON: `sandbox/data/db.json`
- Midia falsa do WhatsApp: `sandbox/fake-whatsapp-media/`

`sandbox/data`, `sandbox/logs` e `.env.sandbox` nao devem ser versionados.
