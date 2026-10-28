const table = (headers, rows) => ({ headers, rows });
const page = (slug, group, title, summary, access, sections) => ({ slug, group, title, summary, access, sections });

const tenantPages = [
  page('guia-agente', 'Guias por perfil', 'Guia do agente', 'Rotina de atendimento, transferência, mídia e encerramento.', 'authenticated', [
    { title: 'Início do turno', steps: ['Acesse Meu atendimento e confirme sua disponibilidade.', 'Revise conversas não lidas e atendimentos em espera.', 'Confirme as filas às quais você está alocado.', 'Abra a conversa e leia o histórico antes de responder.'] },
    { title: 'Durante o atendimento', bullets: ['Mensagens novas sobem a conversa na lista e incrementam o contador de não lidas.', 'Use respostas rápidas somente quando forem adequadas ao contexto.', 'Envie imagens, vídeos, áudios e documentos pelo seletor de mídia.', 'Transfira para outra fila ou agente quando a responsabilidade mudar.', 'Não copie tokens, variáveis técnicas ou dados desnecessários para a conversa.'] },
    { title: 'Encerramento', steps: ['Confirme que a solicitação foi concluída.', 'Registre as informações operacionais necessárias.', 'Escolha encerramento normal ou silencioso conforme a política do tenant.', 'Verifique se o status saiu da sua lista de atendimentos ativos.'] },
  ]),
  page('guia-gestao', 'Guias por perfil', 'Guia de gestão', 'Operação diária para manager e admin do tenant.', 'authenticated', [
    { title: 'Rotina diária', bullets: ['Acompanhe fila, não lidas, TME e conversas sem agente.', 'Valide disponibilidade dos canais e erros recentes.', 'Redistribua capacidade entre filas.', 'Investigue atendimentos parados antes de alterar o fluxo.'] },
    { title: 'Mudanças controladas', steps: ['Edite o rascunho do fluxo.', 'Valide conexões, esperas, erros e saídas.', 'Publique somente após teste funcional.', 'Acompanhe as primeiras conversas e mantenha uma versão anterior disponível.'] },
    { title: 'Responsabilidades', table: table(['Ação', 'Responsável recomendado'], [['Atender e transferir', 'Agente'], ['Filas, equipe e expediente', 'Manager ou admin'], ['Publicar fluxo e configurar canal', 'Admin autorizado'], ['Infraestrutura e administração global', 'Super-admin']]) },
  ]),
  page('matriz-permissoes', 'Guias por perfil', 'Matriz de permissões', 'Responsabilidades e limites esperados por papel.', 'authenticated', [
    { title: 'Papéis', table: table(['Papel', 'Pode operar', 'Não deve acessar'], [['AGENT', 'Próprio dashboard, contatos e conversas atribuídas', 'Configuração técnica, tokens e administração'], ['MANAGER', 'Monitoramento, analytics, equipe e operação permitida', 'Administração global e secrets'], ['ADMIN', 'Configuração do tenant, fluxos, canais e relatórios', 'Outros tenants e infraestrutura global'], ['SUPER_ADMIN', 'Administração global e suporte técnico', 'Ações fora da política e sem auditoria']]) },
    { title: 'Princípio', paragraphs: ['A interface não substitui a autorização do backend. Toda leitura ou alteração protegida deve validar token, papel, permissão e tenant no servidor.'] },
  ]),
  page('receitas-fluxos', 'Automação prática', 'Receitas de fluxos', 'Estruturas reutilizáveis para cenários comuns.', 'authenticated', [
    { title: 'Triagem com atendimento humano', code: { language: 'text', value: 'START -> MSG -> MENU -> CASE -> QUEUE -> END' }, bullets: ['Defina else para opção inválida.', 'Garanta fila com agentes.', 'Configure mensagem única de entrada no humano.'] },
    { title: 'Formulário sequencial', code: { language: 'text', value: 'START -> SEQ[INPUT, INPUT, MENU] -> HTTP -> IF -> END' }, bullets: ['Valide campos antes da API.', 'Mapeie status e erro HTTP.', 'Use Holder quando o fluxo não deve encerrar após falha.'] },
    { title: 'Consulta externa', code: { language: 'text', value: 'INPUT -> HTTP -> IF(HTTP_OK) -> SCRIPT -> MSG\n                         \\-> CASE_ERROR -> HOLDER' }, bullets: ['Não exponha resposta técnica ao cliente.', 'Salve apenas os campos necessários.', 'Mantenha saída de erro conectada.'] },
    { title: 'Catálogo e pedido', code: { language: 'text', value: 'CAT -> INPUT(quantidade) -> SCRIPT(itens) -> MSG(resumo) -> HTTP' }, bullets: ['Use arrays reais em vars.', 'Mantenha total numérico separado do total formatado.', 'Catálogo sem seleção deve avançar imediatamente.'] },
  ]),
  page('ciclo-chat-detalhado', 'Atendimento', 'Ciclo detalhado da conversa', 'Estados, transições e efeitos no fluxo e na fila.', 'authenticated', [
    { title: 'Estados principais', table: table(['Estado', 'Significado', 'Próxima ação'], [['bot', 'Motor controla a conversa', 'Executar ou aguardar node'], ['waiting', 'Conversa em fila', 'Agente assumir'], ['human', 'Agente controla a conversa', 'Responder, transferir ou encerrar'], ['open', 'Conversa ativa compatível com operação', 'Depende do contexto'], ['closed', 'Atendimento encerrado', 'Nova entrada cria ou reabre conforme regra']]) },
    { title: 'Concorrência', bullets: ['Mensagens do mesmo chat são serializadas.', 'IDs do provedor evitam processar o mesmo webhook duas vezes.', 'Ações de agente, flow runner e webhook devem respeitar o mesmo estado persistido.', 'Socket atualiza a interface; o banco permanece fonte de verdade.'] },
    { title: 'Retomada', paragraphs: ['Queue, Delay, Input, Menu, WTN e Holder podem persistir estado de espera. O próximo evento só deve retomar o ponto correspondente, nunca reiniciar o START sem uma regra explícita.'] },
  ]),
  page('dicionario-variaveis', 'Automação prática', 'Dicionário de variáveis', 'Escopos, placeholders e valores gerados pelo runtime.', 'authenticated', [
    { title: 'Escopos', table: table(['Escopo', 'Uso', 'Visibilidade'], [['vars', 'Dados públicos do fluxo', 'Nodes e campos autorizados da interface'], ['secureVars', 'Tokens e credenciais', 'Somente backend; nunca chat, agente ou exportação'], ['Variáveis de atendimento', 'Resumo operacional selecionado', 'Painel do agente conforme configuração'], ['Root/configuração', 'Valores reutilizáveis do tenant', 'Runtime e telas autorizadas']]) },
    { title: 'Variáveis comuns', table: table(['Variável', 'Origem'], [['WA_ID', 'Identificador do cliente no WhatsApp'], ['LAST_MESSAGE_FLOW', 'Último texto recebido pelo fluxo'], ['WTN_BOTAO_TEXTO', 'Texto da opção interativa'], ['WTN_BOTAO_PAYLOAD', 'ID/payload da opção'], ['HTTP_STATUS', 'Status da resposta HTTP'], ['HTTP_OK', 'Resultado booleano da requisição'], ['HTTP_RESPONSE', 'JSON interpretado da resposta'], ['HTTP_ERROR_MESSAGE', 'Mensagem técnica controlada para ramificação']]) },
    { title: 'Boas práticas', bullets: ['Use nomes em maiúsculas e descritivos.', 'Mantenha valor numérico separado da apresentação em moeda.', 'Valide Array.isArray antes de map/push.', 'Nunca copie secureVars para vars.', 'Remova dados que não são necessários após o atendimento.'] },
  ]),
  page('limites-provedores', 'Operação', 'Limites e compatibilidade', 'Restrições da aplicação e dos canais externos.', 'authenticated', [
    { title: 'WhatsApp', bullets: ['Templates fora da janela exigem aprovação e parâmetros compatíveis.', 'Reply buttons aceitam até 3 opções; listas aceitam até 10 linhas por estrutura suportada.', 'A mídia deve respeitar formato e tamanho aceitos pela Graph API, mesmo que o upload interno permita arquivo maior.', 'Status sent, delivered, read e failed dependem dos webhooks da Meta.', 'Políticas, preços e limites podem mudar no provedor.'] },
    { title: 'Telegram', bullets: ['Polling e webhook não podem operar simultaneamente.', 'Recursos interativos e mídia seguem capacidades próprias do Telegram.', 'Bot token deve permanecer somente no backend.'] },
    { title: 'Aplicação', bullets: ['Listagens são paginadas.', 'Campanhas possuem limite por lote e controle de concorrência.', 'Uploads e retenção seguem configuração do tenant e infraestrutura.', 'Fluxos devem ter START único e caminhos estruturalmente válidos.'] },
  ]),
  page('catalogo-erros', 'Operação', 'Catálogo de erros', 'Diagnóstico seguro de falhas frequentes.', 'authenticated', [
    { title: 'HTTP e autenticação', table: table(['Sintoma', 'Verificar'], [['401', 'Token ausente, expirado ou inválido'], ['403', 'Papel, tenant, TOTP, permissão ou política de acesso'], ['404', 'Rota, ID, tenant ou versão não encontrada'], ['409', 'Duplicidade ou conflito de estado'], ['429', 'Rate limit da aplicação ou provedor'], ['5xx', 'Correlation ID, logs e dependências externas']]) },
    { title: 'WhatsApp', table: table(['Código/sintoma', 'Causa provável'], [['132000', 'Quantidade de parâmetros diferente do template'], ['131009', 'Valor ou estrutura interativa inválida'], ['131053', 'Mídia rejeitada por tamanho, formato ou download'], ['Parameter name is missing', 'Parâmetro nomeado enviado sem nome válido'], ['Webhook 403', 'Assinatura ou segredo incompatível']]) },
    { title: 'Fluxo', bullets: ['Node parado: confira estado de espera e próxima conexão.', 'Fluxo reiniciado: confira currentNodeId, deduplicação e chat encerrado.', 'HTTP não é JSON: trate texto bruto e status antes do mapeamento.', 'Variável undefined: confirme nome, escopo e momento de atribuição.'] },
  ]),
  page('backup-recuperacao', 'Operação', 'Backup e recuperação', 'Exportação, versões, rollback e restauração segura.', 'authenticated', [
    { title: 'Fluxos', bullets: ['Exporte o JSON sem valores de secrets.', 'Use histórico de publicações para voltar a uma versão conhecida.', 'Rollback exige confirmação e autorização.', 'Valide o rascunho restaurado antes de republicar.'] },
    { title: 'Dados', bullets: ['Backups de banco devem ser criptografados e testados.', 'Uploads exigem backup separado quando não estão no banco.', 'Retenção e exclusão LGPD também devem alcançar cópias conforme política.', 'Restauração deve preservar isolamento por tenant.'] },
    { title: 'Procedimento', steps: ['Identifique o escopo e interrompa alterações concorrentes.', 'Registre versão e horário do incidente.', 'Restaure em ambiente isolado quando possível.', 'Valide contagens, mensagens, canais e fluxos.', 'Retome produção e monitore eventos.'] },
  ]),
  page('webhooks-eventos', 'Integrações', 'Webhooks e eventos', 'Assinatura, idempotência e entrega confiável.', 'authenticated', [
    { title: 'Entrada', bullets: ['Valide assinatura antes do processamento.', 'Responda rapidamente e processe trabalho pesado em fila.', 'Use ID estável do provedor para deduplicar.', 'Resolva o tenant pelo identificador técnico do canal.'] },
    { title: 'Saída', bullets: ['Assine o payload quando a integração suportar.', 'Use outbox com status pending, retry, delivered e dead_letter.', 'Respeite nextAttemptAt e backoff.', 'Não reenvie eventos delivered automaticamente.'] },
    { title: 'Eventos em tempo real', paragraphs: ['Socket.IO acelera a interface, mas consumidores devem recarregar o snapshot REST após reconexão e deduplicar por chatId/messageId.'] },
  ]),
  page('campanhas-conformidade', 'Integrações', 'Campanhas e conformidade', 'Boas práticas para contatos ativos e follow-up.', 'authenticated', [
    { title: 'Antes do disparo', steps: ['Confirme base legal e origem da lista.', 'Remova contatos em opt-out ou suprimidos.', 'Sincronize contato e identificador do canal.', 'Valide template, idioma, variáveis e remetente.', 'Comece com lote pequeno.'] },
    { title: 'Durante e depois', bullets: ['Respeite limites do provedor e concorrência configurada.', 'Não reenvie automaticamente falhas permanentes.', 'Resposta positiva deve ser roteada para atendimento humano conforme regra do tenant.', 'Opt-out deve impedir novos disparos e registrar o motivo.', 'Métricas devem diferenciar entregue, lida, respondida, falha e suprimida.'] },
  ]),
  page('api-tenant', 'API', 'API de integração do tenant', 'Operações suportadas para integrações externas autenticadas.', 'authenticated', [
    { title: 'Autenticação', code: { language: 'http', value: 'Authorization: Bearer <TOKEN_DO_USUARIO_OU_TOKEN_EXTERNO>\nContent-Type: application/json\nx-tenant-id: tenant_xxx' }, bullets: ['Use token com o menor papel necessário.', 'Tokens de agente preservam autoria em atendimento ativo.', 'Nunca coloque token no frontend de outro produto ou repositório público.'] },
    { title: 'Domínios disponíveis', table: table(['Domínio', 'Finalidade'], [['Contatos', 'Consultar, criar, atualizar e importar'], ['Outreach', 'Disparar template e acompanhar campanha'], ['Conversas', 'Consultar estado e respostas permitidas'], ['Templates', 'Listar modelos disponíveis'], ['Relatórios', 'Exportar métricas autorizadas']]) },
    { title: 'Convenções', bullets: ['Use paginação em listagens.', 'Envie tenant explicitamente apenas quando o token permitir.', 'Trate 401, 403, 409, 429 e 5xx.', 'Use IDs retornados pela API, não nomes visuais.', 'Implemente retry apenas para falhas transitórias.'] },
  ]),
];

const superAdminPages = [
  page('arquitetura', 'Interno', 'Arquitetura', 'Como frontend, API, banco, filas e provedores se conectam.', 'super_admin', [
    { title: 'Componentes', table: table(['Componente', 'Responsabilidade'], [['React + Vite', 'Painel, administração, editor e área do agente'], ['Express', 'API REST, webhooks, autenticação e uploads'], ['PostgreSQL (Supabase) via adapter', 'Tenants, fluxos, chats, mensagens, contatos e configurações; o sandbox local usa o adapter JSON'], ['Redis + BullMQ', 'Cache e execução assíncrona quando habilitados'], ['Socket.IO', 'Atualizações de fila, chat, status e alertas'], ['Meta / Telegram', 'Entrega e recebimento de mensagens'], ['Vercel', 'Hospedagem do frontend'], ['VPS Oracle Cloud + túnel nomeado da Cloudflare', 'API e workers em produção (serviços onion-flows e cloudflared)'], ['Quick Tunnel', 'Só para expor o sandbox local; ver Infraestrutura e deploy']]) },
    { title: 'Isolamento multitenant', paragraphs: ['Dados operacionais carregam tenantId e as rotas protegidas aplicam requireTenant. Super-admin seleciona explicitamente o tenant; usuários comuns herdam o tenant do token.', 'Canais são resolvidos por identificadores do provedor, como phone_number_id, evitando depender de tenantId na URL pública do webhook.'] },
    { title: 'Persistência e concorrência', bullets: ['Mensagens novas podem ser armazenadas separadamente do documento leve do chat.', 'Locks por usuário de canal e por chat evitam avanço concorrente do mesmo fluxo.', 'providerMessageId e processedMessageIds impedem processamento duplicado.', 'Jobs assíncronos usam retry e backoff quando BullMQ está habilitado.', 'O sistema mantém fallback síncrono quando Redis/BullMQ estão desligados.'] },
  ]),
  page('api-interna', 'Interno', 'API administrativa interna', 'Referência restrita da administração global.', 'super_admin', [
    { title: 'Administração global', code: { language: 'text', value: 'Base: /api/super-admin\nGET /dashboard\nGET /monitoring\nGET /web-vitals\nGET /web-vitals/export\nPOST /chats/close-all\nPOST /external-token\nGET /external-token/users\nGET /ip-allowlist\nPOST /ip-allowlist\nPATCH /ip-allowlist/:id\nDELETE /ip-allowlist/:id\nGET /ip-allowlist/audit\nPOST /ip-allowlist/temporary' } },
    { title: 'Sistema', code: { language: 'text', value: 'Base: /api/system\nGET /queues\nGET /commercial-health' } },
    { title: 'Requisitos', bullets: ['JWT válido de SUPER_ADMIN.', 'Permissão específica quando configurada.', 'TOTP/elevation para ação sensível.', 'IP permitido quando a política estiver ativa.', 'Tenant explícito para ação contextual.', 'Auditoria obrigatória em alteração destrutiva.'] },
    { title: 'Nunca publicar', bullets: ['Tokens reais, JWTs e segredos de webhook.', 'Valores de env.', 'IPs autorizados e detalhes de infraestrutura.', 'Payloads contendo dados pessoais reais.', 'Procedimentos que contornem controles de acesso.'] },
  ]),
  page('infraestrutura-interna', 'Interno', 'Infraestrutura e deploy', 'Runbook restrito de produção, workers e dependências.', 'super_admin', [
    { title: 'Camadas', table: table(['Camada', 'Responsabilidade'], [['Vercel', 'Frontend versionado'], ['Cloudflare (túnel nomeado)', 'TLS, DNS e WebSocket'], ['VPS Oracle Cloud', 'API e workers'], ['PostgreSQL (Supabase)', 'Persistência e índices'], ['Redis/BullMQ', 'Cache, filas e retries'], ['Object storage/volume', 'Uploads persistentes']]) },
    { title: 'Famílias de configuração', bullets: ['Runtime e URLs públicas.', 'JWT, criptografia e autenticação.', 'Banco e pool.', 'Redis, BullMQ e concorrência.', 'Meta/WhatsApp e Telegram.', 'CORS, proxy e Socket.IO.', 'Retenção, uploads e observabilidade.'] },
    { title: 'Deploy', steps: ['Confirme diff e backup.', 'Rode testes e build.', 'Atualize somente os arquivos planejados.', 'Instale pelo lockfile.', 'Aplique env sem versionar segredos.', 'Reinicie API e workers controladamente.', 'Valide health, login, socket e webhooks.', 'Monitore filas e erros; reverta se necessário.'] },
    { title: 'Ambientes', note: { title: 'Sandbox não é produção', text: 'Quick Tunnel muda quando o cloudflared reinicia e não oferece disponibilidade garantida. Use domínio e túnel nomeado ou proxy permanente em produção.' } },
  ]),
  page('runbook-incidentes', 'Interno', 'Runbook de incidentes', 'Resposta técnica a falhas de segurança e disponibilidade.', 'super_admin', [
    { title: 'Classificação', table: table(['Nível', 'Exemplo', 'Ação'], [['Crítico', 'Vazamento, invasão ou indisponibilidade total', 'Conter imediatamente e preservar evidências'], ['Alto', 'Canal principal parado ou perda de mensagens', 'Mitigar, comunicar e acompanhar'], ['Médio', 'Degradação parcial ou fila atrasada', 'Reduzir carga e corrigir'], ['Baixo', 'Erro isolado sem impacto relevante', 'Registrar e programar correção']]) },
    { title: 'Sequência', steps: ['Abra registro com horário e correlation IDs.', 'Congele mudanças não essenciais.', 'Contenha credenciais, acesso ou componente afetado.', 'Avalie tenants e dados impactados.', 'Restaure serviço por fallback ou rollback.', 'Comunique conforme contrato e LGPD.', 'Finalize causa raiz, correção e prevenção.'] },
    { title: 'Sinais técnicos', bullets: ['Fila crescendo e retries em massa.', 'Pool de banco saturado ou queries lentas.', 'Webhooks recebidos sem processamento.', 'Sockets desconectando continuamente.', 'Falhas de assinatura ou autenticação anormais.', 'Aumento de 401, 403, 429 ou 5xx.'] },
  ]),
  page('performance-interna', 'Interno', 'Performance e capacidade', 'Diagnóstico restrito de latência, filas e banco.', 'super_admin', [
    { title: 'Ordem de investigação', steps: ['Meça a rota específica, não apenas health.', 'Separe tempo de rede, API, banco e provedor.', 'Verifique query plan, índices, projection e payload.', 'Observe pool, CPU, memória e event loop.', 'Observe filas, concorrência, retries e dead letters.', 'Aumente capacidade somente após remover gargalos objetivos.'] },
    { title: 'Teste de carga', code: { language: 'powershell', value: 'k6 run .\\load-tests\\api-smoke-load.js' }, bullets: ['Use credenciais e tenant descartáveis.', 'Comece com smoke.', 'Defina thresholds de p95 e falha.', 'Não teste operações destrutivas em produção.', 'Monitore MongoDB, Redis, workers e VPS durante o teste.'] },
  ]),
];

export const getDocumentationPagesForRole = (role) => {
  const normalizedRole = String(role || '').toUpperCase();
  if (!normalizedRole) return [];
  return normalizedRole === 'SUPER_ADMIN' ? [...tenantPages, ...superAdminPages] : tenantPages;
};

export const getDocumentationIndexForRole = (role) => getDocumentationPagesForRole(role).map(({ sections: _sections, ...metadata }) => metadata);