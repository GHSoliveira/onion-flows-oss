# Política de Privacidade — Onion Web Flows

**Última atualização:** `{{DATA}}`

Esta política descreve como tratamos dados pessoais na plataforma Onion Web Flows (`{{URL}}`), em conformidade com a Lei Geral de Proteção de Dados (Lei 13.709/2018, LGPD).

> A Onion Web Flows é uma plataforma B2B de automação e atendimento conversacional. O cliente final, isto é, a pessoa atendida por uma empresa usuária da solução, não acessa diretamente a plataforma Onion Web Flows. Ele interage apenas pelos canais de atendimento configurados, como WhatsApp, Telegram ou outros meios digitais.
>
> A operação dos fluxos, automações, integrações e análises pode ser conduzida diretamente pelo Onion Web Flows, enquanto a empresa contratante utiliza a plataforma principalmente para atendimento humano, acompanhamento de conversas e acesso a relatórios/indicadores. Conforme o caso concreto, o Onion Web Flows pode atuar como **controlador** de determinados tratamentos e/ou como **operador** em nome da empresa contratante.

---

## 1. Quem somos

O Onion Web Flows é uma plataforma operada pela **`{{NOME DO OPERADOR}}`**, inscrita no CNPJ sob o número **`{{CNPJ}}`**, com operação baseada no Brasil.

A plataforma oferece ferramentas para automação de atendimentos, organização de conversas, roteamento de fluxos, suporte operacional, atendimento humano e geração de relatórios/indicadores via canais digitais como WhatsApp, Telegram e outros meios integrados.

O endereço completo da sede consta dos contratos firmados com as empresas contratantes e pode ser solicitado a qualquer momento pelo e-mail de contato.

Contato para assuntos de privacidade e proteção de dados: `{{EMAIL DE CONTATO}}`

## 2. Que dados tratamos

- **Cadastro de usuários operadores da plataforma**: nome, e-mail corporativo, senha (com hash), papel, telefone opcional.
- **Atendimentos**: nome, telefone, mensagens trocadas, identificadores do canal (como WhatsApp ID), informações fornecidas pelo cliente final durante a conversa, variáveis coletadas pela automação, metadados (horário, canal, status da fila, agente responsável) e, quando configurado para um caso específico, outros dados necessários ao atendimento.
- **Operacional/segurança**: logs de acesso, IP, user-agent, registro de tentativas de login e mudanças administrativas.
- **Faturamento da empresa contratante**: CNPJ quando aplicável, e-mail de cobrança, status de pagamento e dados necessários à gestão comercial.

## 3. Por que tratamos

| Finalidade | Base legal |
|---|---|
| Executar contrato de prestação de serviço com a empresa contratante | Execução de contrato (Art. 7, V) |
| Operar fluxos, automações, roteamentos, integrações e atendimento humano | Execução de contrato e legítimo interesse |
| Gerar relatórios, métricas operacionais e análises de atendimento para a empresa contratante | Execução de contrato e legítimo interesse |
| Atender solicitações do titular feitas diretamente ao Onion Web Flows ou por meio da empresa contratante | Cumprimento de obrigação legal (Art. 7, II) |
| Segurança da plataforma, prevenção a fraude | Legítimo interesse (Art. 7, IX) |
| Faturamento e cobrança | Execução de contrato |
| Comunicações operacionais (e-mails de serviço) | Execução de contrato |

## 4. Com quem compartilhamos

- **Fornecedores e suboperadores** (com obrigações contratuais compatíveis com esta política): Oracle Cloud Infrastructure (hospedagem da aplicação, região Vinhedo/SP), Supabase (banco de dados PostgreSQL, sobre AWS, região São Paulo/SP), Vercel (hospedagem da interface web), Cloudflare (roteamento e proteção do tráfego), WhatsApp Business API (Meta), Telegram Bot API.
- **Autoridades públicas**: somente mediante ordem judicial, requisição legal ou para proteger direitos.

Não vendemos dados pessoais. Não usamos os dados de atendimentos para treinar modelos de IA ou para finalidades incompatíveis com a prestação do serviço contratado.

## 5. Transferência internacional

Os dados da plataforma são armazenados no Brasil: a aplicação roda na Oracle Cloud, região Vinhedo/SP, e o banco de dados no Supabase sobre AWS, região São Paulo/SP.

Há transferência internacional nas integrações de mensageria: as rotas da API do WhatsApp passam por servidores da Meta e as do Telegram por servidores da Telegram, ambos fora do Brasil. Nesses casos aplicamos as garantias adequadas previstas na LGPD: cláusulas contratuais padrão e/ou decisões de adequação.

## 6. Retenção

Os dados são retidos enquanto o contrato com a empresa contratante estiver vigente, e por prazo adicional:

- **Conversas encerradas**: prazo definido conforme a operação contratada e necessidade de auditoria, histórico de atendimento ou suporte.
- **Logs do sistema**: até 30 dias.
- **Backups**: até 14 dias após a eliminação na base principal.

Após esses prazos, os dados são apagados ou anonimizados.

## 7. Seus direitos, incluindo exclusão de dados

Como titular, você tem direito a:

- **Acesso** aos seus dados pessoais
- **Correção** de dados incompletos ou inexatos
- **Eliminação** dos dados pessoais tratados com consentimento ou desnecessários
- **Portabilidade** a outro fornecedor
- **Informação** sobre compartilhamento
- **Oposição** a tratamento com base em legítimo interesse
- **Revogação** de consentimento

### Como exercer

- Se você é **cliente final atendido por uma empresa que utiliza o Onion Web Flows**: você pode direcionar sua solicitação à empresa que te atendeu ou ao Onion Web Flows pelo e-mail `{{EMAIL DE CONTATO}}`. Dependendo do caso, a solicitação poderá ser tratada diretamente pelo Onion Web Flows ou encaminhada/validada com a empresa contratante.
- Se você é **usuário operador da plataforma**: `{{EMAIL DE CONTATO}}`.

Responderemos em até 15 dias.

## 8. Segurança

Aplicamos medidas técnicas e organizacionais, incluindo: TLS na comunicação, senhas com bcrypt, JWT, MFA para administradores, allowlist de IPs em rotas privilegiadas, criptografia at-rest de credenciais de canal, mascaramento de PII em logs, isolamento multi-tenant, auditoria de acessos administrativos.

Em caso de incidente de segurança envolvendo dados pessoais, comunicamos a ANPD e os titulares conforme exigido pelos Arts. 48 da LGPD.

## 9. Cookies e armazenamento local

Não utilizamos cookies de rastreamento nem cookies de terceiros para publicidade.

Para funcionar, a plataforma guarda informações no armazenamento local do seu navegador (`localStorage`), no próprio dispositivo. Esses dados não são enviados a terceiros:

- **Autenticação**: token de sessão e dados do seu usuário (nome, e-mail, papel e empresa vinculada), para manter você conectado entre visitas.
- **Preferências**: tema, idioma, som e volume das notificações, layout do painel e empresa selecionada.
- **Estado de operação**: última conversa aberta, ordenação dos cards de atendimento e quais dicas do assistente já foram exibidas.
- **Experimentos de interface**: identificador da variante atribuída ao seu usuário quando um teste está ativo.

Esse armazenamento é necessário ao funcionamento da plataforma. Ao sair da sua conta, os dados de autenticação e a empresa selecionada são removidos. Os demais podem ser apagados a qualquer momento limpando os dados do site no navegador.

## 10. Crianças e adolescentes

A plataforma não é dirigida a menores de 18 anos. Se uma empresa contratante atender adolescentes ou crianças via seus canais, ela deve informar previamente essa necessidade para que a operação seja configurada com base legal e cuidados adequados.

## 11. Mudanças nesta política

Podemos atualizar esta política. Mudanças relevantes serão comunicadas com 30 dias de antecedência por e-mail ou notificação dentro da plataforma.

## 12. Contato

- `{{EMAIL DE CONTATO}}`

Você também pode registrar reclamação na **Autoridade Nacional de Proteção de Dados (ANPD)** — https://www.gov.br/anpd.
