const table = (headers, rows) => ({ headers, rows });

const page = (slug, group, title, summary, sections) => ({ slug, group, title, summary, sections });

const nodes = [
  ['START', 'Início', 'startNode', 'Ponto único e obrigatório de entrada. Não pode ser apagado e encaminha para a primeira conexão.'],
  ['END', 'Finalizar', 'finalNode', 'Encerra a execução, limpa o estado pendente e aplica a mensagem final configurada quando cabível.'],
  ['MSG', 'Mensagem', 'messageNode', 'Envia texto com placeholders ao cliente e segue imediatamente pela saída padrão.'],
  ['IN', 'Entrada', 'inputNode', 'Envia uma pergunta, aguarda uma resposta e grava o valor em uma variável.'],
  ['HLD', 'Holder', 'holderNode', 'Mantém o fluxo suspenso, acumula mensagens e só libera por regra, comando ou limite configurado.'],
  ['MNU', 'Menu', 'menuNode', 'Apresenta opções, valida a resposta, pode gravar valores e criar uma saída por opção e else.'],
  ['MED', 'Mídia', 'mediaNode', 'Envia imagem, vídeo, áudio ou documento por URL, asset ou variável, com legenda quando suportada.'],
  ['CAT', 'Catálogo', 'catalogNode', 'Exibe produtos configurados; opcionalmente aguarda seleção e grava produto, preço e identificadores.'],
  ['NPS', 'Nota', 'ratingNode', 'Solicita avaliação numérica, valida a faixa e salva a nota para métricas.'],
  ['HSM', 'Template interno', 'templateNode', 'Reutiliza um template interno de fluxo com texto e opções configuradas na aplicação.'],
  ['WTN', 'WhatsApp Template', 'whatsappTemplateNode', 'Envia template aprovado ou mensagem interativa do WhatsApp e pode aguardar resposta.'],
  ['IF', 'Condicional', 'conditionNode', 'Compara variável e valor usando operadores e encaminha para case ou else.'],
  ['DLY', 'Delay', 'delayNode', 'Pausa a execução pelo intervalo configurado e retoma em seguida.'],
  ['SCH', 'Horário', 'scheduleNode', 'Compara a data atual com um expediente e escolhe a saída dentro ou fora do horário.'],
  ['SEQ', 'Sequencial', 'sequentialNode', 'Executa uma lista ordenada de mensagens, entradas, menus e operações no mesmo nó.'],
  ['SET', 'Definir variável', 'setValueNode', 'Grava ou substitui valores no contexto público do fluxo.'],
  ['CART', 'Carrinho', 'cartNode', 'Adiciona produtos e quantidades, calcula subtotal e total e produz um resumo formatado reutilizável.'],
  ['SEC', 'Secret', 'secretNode', 'Carrega credenciais no contexto seguro do backend; nunca deve expor valor ao chat, exportação ou agente.'],
  ['JS', 'Script', 'scriptNode', 'Executa JavaScript validado em sandbox sobre vars, sem acesso irrestrito ao servidor.'],
  ['CMD', 'Comando', 'commandNode', 'Registra um atalho global que pode interromper a espera atual e redirecionar a conversa.'],
  ['HTTP', 'API HTTP', 'httpRequestNode', 'Executa requisição externa, mapeia resposta/status e possui saída de sucesso e erro.'],
  ['ACD', 'Fila', 'queueNode', 'Suspende o bot, move o chat para fila humana e mantém dados de retomada quando configurado.'],
  ['ANC', 'Âncora', 'anchorNode', 'Define um destino nomeado dentro do fluxo sem produzir mensagem.'],
  ['GOTO', 'Ir para', 'gotoNode', 'Salta para uma âncora válida com proteção contra ciclos e destinos ausentes.'],
  ['CASE', 'Caso', 'caseNode', 'Representa visualmente a saída de uma condição, menu ou erro; não executa lógica independente.'],
];

export const docsPages = [
  page('inicio', 'Introdução', 'Onion Flows', 'Manual operacional e técnico da plataforma de automação, atendimento humano e mensageria multitenant.', [
    { title: 'O que a plataforma faz', paragraphs: ['O Onion Flows recebe eventos de canais, identifica o tenant e o contato, executa fluxos publicados, encaminha conversas para filas humanas e registra métricas, histórico e auditoria.', 'O painel reúne a operação da empresa, o espaço do agente e o editor de fluxos. O cliente final conversa pelo canal e não acessa o painel.'] },
    { title: 'Caminho de uma mensagem', steps: ['O WhatsApp ou o Telegram entrega a mensagem ao Onion.', 'O Onion identifica a empresa e o canal e descarta entregas repetidas.', 'A conversa é localizada ou criada e o contato é atualizado.', 'Mensagens do mesmo cliente são tratadas uma por vez, na ordem em que chegaram.', 'O fluxo continua de onde parou ou o fluxo publicado começa.', 'Mensagens, estados e métricas ficam registrados e aparecem no painel na hora.'] },
    { title: 'Mapa da documentação', table: table(['Área', 'Conteúdo'], [['Introdução', 'Conceitos e primeiros passos'], ['Administração', 'Tenants, papéis, equipe, filas e expediente'], ['Canais', 'WhatsApp, Telegram, webhooks e roteamento'], ['Atendimento', 'Ciclo da conversa, agente, monitoramento e ativo'], ['Automação', 'Fluxos, todos os nodes, variáveis, scripts e templates'], ['Dados', 'Analytics, relatórios, retenção e auditoria'], ['API', 'Autenticação, convenções, endpoints e tempo real'], ['Segurança', 'Controles de acesso e LGPD']]) },
  ]),
  page('primeiros-passos', 'Introdução', 'Primeiros passos', 'Sequência recomendada para colocar um tenant em operação.', [
    { title: 'Configuração mínima', steps: ['Crie ou acesse o tenant.', 'Cadastre equipe e filas.', 'Defina expediente e regras globais.', 'Crie variáveis de contexto necessárias.', 'Crie e publique ao menos um fluxo.', 'Adicione o canal e conclua sua configuração técnica.', 'Conecte o canal ao fluxo em Roteamento.', 'Envie uma mensagem real e acompanhe em Monitoramento.'] },
    { title: 'Checklist antes do go-live', bullets: ['Canal ativo e webhook validado.', 'Fluxo publicado sem erros estruturais.', 'Fila com ao menos um agente alocado.', 'Comandos de reinício, humano e encerramento testados.', 'Templates e variáveis revisados.', 'Política de retenção e expediente definidos.', 'Teste de texto, mídia, erro HTTP, transferência e encerramento concluído.'] },
  ]),
  page('tenants-papeis', 'Administração', 'Tenants, papéis e acesso', 'Modelo de isolamento, responsabilidades e permissões.', [
    { title: 'Papéis', table: table(['Papel', 'Escopo'], [['SUPER_ADMIN', 'Equipe da Onion: suporte e administração da plataforma'], ['ADMIN', 'Configuração completa do próprio tenant, usuários, filas, canais e fluxos'], ['MANAGER', 'Acompanhamento e gestão permitida, sem acesso a secrets e ações administrativas críticas'], ['AGENT', 'Atendimento, contatos ativos, dashboard próprio e operações autorizadas de chat']]) },
    { title: 'Regras de acesso', bullets: ['Nunca reutilize usuário entre pessoas.', 'Tokens externos devem ter papel e tenant explícitos.', 'Ações destrutivas podem exigir senha, segundo fator (TOTP) e permissão específica.', 'Secrets não aparecem para manager ou agent.'] },
    { title: 'Ciclo do tenant', bullets: ['Criação e configuração inicial.', 'Operação ativa ou período de teste.', 'Bloqueio por inadimplência sem remoção imediata de dados.', 'Desbloqueio após a regularização.', 'Exclusão controlada conforme retenção e contrato.'] },
  ]),
  page('equipe-filas', 'Administração', 'Equipe, filas e expediente', 'Configuração de usuários, capacidade e distribuição de atendimento.', [
    { title: 'Usuário', table: table(['Campo', 'Uso'], [['Nome e username', 'Identidade e login'], ['Papel', 'Permissões base'], ['Email e telefone', 'Contato administrativo opcional'], ['Avatar', 'Identificação visual opcional'], ['Filas', 'Escopo de atendimento'], ['Disponibilidade', 'auto, disponível, ausente ou offline'], ['Máximo simultâneo', 'Limite entre 1 e 100 chats'], ['Agenda', 'Timezone, dias e intervalo'], ['Notificações', 'Navegador, som e email']]) },
    { title: 'Fila', bullets: ['Possui nome, cor operacional e agentes alocados.', 'O Queue Node envia a conversa para uma fila.', 'Pickup individual ou em massa atribui o chat ao agente.', 'Transferência pode apontar para outra fila ou agente não-admin.', 'Capacidade e disponibilidade devem ser consideradas antes da atribuição.'] },
    { title: 'TME', paragraphs: ['No Onion Flows, TME representa o tempo médio em que o cliente aguardou sem ser puxado por um agente. Não é a duração total do atendimento.', 'O dashboard do agente separa período diário e mensal e mantém histórico dos atendimentos atribuídos.'] },
  ]),
  page('canais-roteamento', 'Canais', 'Canais e roteamento', 'Identidade técnica do canal e vínculo com fluxos publicados.', [
    { title: 'Modelo operacional', bullets: ['A aba Operação mostra conexões e fluxo atual.', 'Canais configurados lista identidades existentes sem expor credenciais.', 'Detalhes reúne status, identificador, histórico, segurança e exclusão.', 'Configuração técnica contém apenas credenciais da plataforma.', 'Roteamento contém exclusivamente a escolha do fluxo.'] },
    { title: 'Criação', steps: ['Informe nome do canal.', 'Escolha Web, WhatsApp ou Telegram.', 'Informe seed para geração do token Onion.', 'Opcionalmente defina senha de modificação.', 'Copie o token gerado uma única vez.', 'Conclua a configuração técnica.', 'Selecione o fluxo publicado no roteamento.'] },
    { title: 'Estados', table: table(['Estado', 'Significado'], [['Pendente', 'Identidade criada, mas configuração técnica ainda não foi salva'], ['Ativo', 'Configuração técnica concluída e canal habilitado'], ['Inativo', 'Canal mantido, porém sem processamento operacional'], ['Legado', 'Configuração anterior ao modelo de channel entry']]) },
  ]),
  page('whatsapp', 'Canais', 'WhatsApp Cloud API', 'Configuração, webhooks, templates e limitações do canal.', [
    { title: 'Dados técnicos', table: table(['Campo', 'Origem'], [['Access Token', 'Token de sistema ou temporário da Meta com permissões adequadas'], ['Phone Number ID', 'Identificador do número remetente na Cloud API'], ['WABA ID', 'Identificador da conta WhatsApp Business; usado para templates e catálogo'], ['Verify Token', 'Texto definido por você e repetido na configuração do webhook'], ['App Secret', 'Segredo do aplicativo Meta usado para validar assinatura'], ['Remetentes', 'Lista de Phone Number IDs e rótulos disponíveis']]) },
    { title: 'Webhook', paragraphs: ['A Meta confirma o webhook com o Verify Token. Depois, cada mensagem chega assinada e vai para a empresa certa pelo Phone Number ID.'], steps: ['Abra a configuração do canal WhatsApp no painel.', 'No passo Ligar o webhook, copie a URL de callback.', 'Na Meta, cole a URL em Callback URL e use o mesmo Verify Token salvo no painel.'] },
    { title: 'Mensagens', bullets: ['Texto livre é permitido dentro da janela de atendimento da Meta.', 'Fora da janela, inicie contato com template aprovado.', 'Listas e reply buttons interativos não exigem aprovação prévia, mas seguem limites da Meta.', 'Single product e product list exigem catálogo Meta e retailer IDs válidos.', 'Status sent, delivered, read e failed chegam por webhook e atualizam a mensagem.'] },
    { title: 'Limites interativos', table: table(['Tipo', 'Limite'], [['Reply buttons', '1 a 3 botões'], ['List message', 'Até 10 linhas no total'], ['Multi product', 'Até 10 seções e 30 produtos'], ['Single product', 'Um retailer ID; sem header de texto']]) },
    { title: 'Mídia', note: { title: 'Limite efetivo é do provedor', text: 'A aplicação pode aceitar upload maior que o limite da Cloud API. Vídeos enviados ao WhatsApp precisam respeitar o limite e codec retornados pela Meta; erro 131053 indica falha de mídia.' } },
  ]),
  page('telegram-webhooks', 'Canais', 'Telegram, webhooks e integrações', 'Recebimento por webhook ou polling e webhooks externos do tenant.', [
    { title: 'Telegram', bullets: ['Bot Token vem do BotFather.', 'Polling e webhook são mutuamente exclusivos no Telegram.', 'Se um webhook estiver ativo, getUpdates retorna conflito até deleteWebhook.', 'Webhook Secret protege a chamada recebida.', 'Texto, botões e mídia são adaptados às capacidades do Telegram.'] },
    { title: 'Webhook de Telegram', paragraphs: ['A URL de webhook do Telegram é opcional na configuração do canal. Se precisar dela, peça ao suporte da Onion o endereço da sua empresa.'] },
    { title: 'Webhooks externos', paragraphs: ['A área Webhooks e API registra destinos externos do tenant. Cada configuração possui nome, URL, eventos e secret opcional. Use HTTPS e valide assinatura no consumidor.'], bullets: ['Não coloque bearer tokens em URLs.', 'Rotacione secrets após exposição.', 'Trate retry e idempotência no destino.', 'Não presuma ordem global entre eventos distintos.'] },
  ]),
  page('ciclo-atendimento', 'Atendimento', 'Ciclo do atendimento', 'Estados, fila, humano, transferência, retomada e encerramento.', [
    { title: 'Estados principais', table: table(['Status', 'Comportamento'], [['bot', 'Motor de fluxo controla a conversa'], ['waiting', 'Cliente aguarda em uma fila'], ['human', 'Agente assumiu e o bot não deve reiniciar'], ['open', 'Conversa aberta em contexto operacional'], ['closed', 'Conversa encerrada; nova entrada pode criar ou reiniciar sessão conforme regra']]) },
    { title: 'Atendimento ativo', steps: ['Agente seleciona contato, canal, remetente e template.', 'Backend envia o template e cria chat humano com origem ATIVO.', 'Input fica bloqueado até resposta quando aplicável.', 'A resposta do cliente é anexada ao mesmo chat e não inicia fluxo.', 'Encerramento envia apenas a mensagem definida ou é silencioso quando solicitado.'] },
    { title: 'Transferência', bullets: ['Pode direcionar para fila ou agente elegível.', 'A atribuição anterior é registrada no timeline.', 'Mensagens de sistema aparecem no painel; mensagens destinadas ao cliente são enviadas pelo canal.', 'A conversa deve manter o mesmo chatId e histórico.'] },
    { title: 'Concorrência', paragraphs: ['O Onion trata uma ação por vez em cada conversa: mensagem do cliente, resposta do agente, transferência e encerramento nunca se atropelam. Mensagens rápidas do mesmo cliente são processadas na ordem em que chegaram.'] },
  ]),
  page('agente-monitoramento', 'Atendimento', 'Agente, monitoramento e histórico', 'Uso diário da área de atendimento e supervisão.', [
    { title: 'Espaço do agente', bullets: ['Lista prioriza conversas com atividade recente e não lidas.', 'Contador vermelho indica mensagens ainda não vistas.', 'Painel lateral do cliente é colapsável.', 'Shift+Enter quebra linha; Enter envia.', 'Mídia abre preview com legenda opcional.', 'Respostas rápidas reduzem repetição.', 'Transferência e encerramento ficam no cabeçalho do chat.'] },
    { title: 'Informações visíveis', bullets: ['Nome definido no contato ou identificador do canal.', 'Canal e WA ID/identificador.', 'Somente variáveis marcadas como contexto visível ao atendimento.', 'Nunca secureVars, tokens, secrets ou dump completo do fluxo.'] },
    { title: 'Monitoramento', paragraphs: ['Administradores acompanham status, fila, agente, mensagens e timeline. Encerramento silencioso fecha o chat sem enviar texto ao cliente.'], bullets: ['Use a conversa detalhada para mensagens.', 'Use timeline para eventos de sistema.', 'Use histórico para atendimentos encerrados.', 'Use analíticas para agregados; não substitua auditoria por métricas.'] },
  ]),
  page('contatos-campanhas', 'Atendimento', 'Contatos, ativo e campanhas', 'Cadastro, deduplicação, disparos e follow-up.', [
    { title: 'Contato', table: table(['Campo', 'Descrição'], [['agentDefinedName', 'Nome escolhido pela equipe'], ['company', 'Empresa opcional'], ['email', 'Email opcional'], ['notes', 'Observações internas'], ['tags', 'Segmentação'], ['phones', 'Números e WA IDs'], ['channelIdentities', 'Identidades normalizadas por canal e opt-in']]) },
    { title: 'Cadastro em massa', code: { language: 'http', value: 'POST /api/contacts/bulk\nAuthorization: Bearer <token>\nContent-Type: application/json\n\n{ "contacts": [{ "name": "Maria", "tags": ["Campanha 5"], "phones": [{ "channel": "whatsapp", "number": "5511999999999" }] }] }' } },
    { title: 'Campanhas', bullets: ['Recebem contactIds, templateId, senderPhoneNumberId e values.', 'Cada contato vira item independente para retry e auditoria.', 'Parâmetros devem respeitar header, body e buttons esperados pelo template.', 'O token do agente atribui o atendimento ao agente correspondente.', 'Follow-up fora da janela deve usar template aprovado.'] },
    { title: 'Conformidade', note: { title: 'Base legal obrigatória', text: 'O contratante é responsável por autorização, relação prévia ou outra base legal adequada. Listas compradas, raspadas ou sem autorização não devem ser usadas.' } },
  ]),
  page('editor-fluxos', 'Automação', 'Editor de fluxos', 'Criação, conexão, publicação, versões e organização visual.', [
    { title: 'Estrutura', bullets: ['Draft contém nodes e edges em edição.', 'Published é a versão executada pelos canais.', 'Start é único e indestrutível.', 'Case nodes representam ramificações geradas.', 'Blocos visuais organizam grupos sem alterar execução.', 'Publicar cria versão no histórico.'] },
    { title: 'Interação', table: table(['Ação', 'Comando'], [['Selecionar área', 'Mouse 1 arrastando'], ['Mover canvas', 'Mouse 2 arrastando'], ['Copiar/colar', 'Ctrl+C / Ctrl+V'], ['Ações da seleção', 'Alt']]) },
    { title: 'Publicação e rollback', steps: ['Salve o draft.', 'Valide conexões, scripts e referências.', 'Publique para gerar uma nova versão.', 'Use Histórico de publicações para revisar.', 'Rollback exige papel autorizado, confirmação e senha quando configurado.'] },
    { title: 'Regras estruturais', bullets: ['Evite saídas duplicadas, nodes órfãos e ciclos sem controle.', 'Nodes que aguardam resposta retomam do mesmo ponto quando o cliente responde.', 'Nodes sem espera devem avançar automaticamente.', 'Fluxo publicado deve conter start e caminho alcançável.', 'Secrets são mascarados somente na exportação, nunca substituídos no fluxo salvo.'] },
  ]),
  page('nodes', 'Automação', 'Referência de nodes', 'Operação e responsabilidade de cada tipo disponível no editor.', [
    { title: 'Todos os nodes', table: table(['Código', 'Nome', 'Tipo interno', 'Operação'], nodes) },
    { title: 'Saídas', bullets: ['Saída padrão: avanço linear.', 'Cases: uma saída por condição/opção e else opcional.', 'HTTP: saída padrão de sucesso e saída inferior de erro.', 'Schedule: dentro e fora do expediente.', 'Holder/Input/WTN podem pausar até nova mensagem.'] },
    { title: 'Inatividade por node', paragraphs: ['Nodes que aguardam resposta podem definir tempo menor que o limite global. Ao expirar, o motor executa a política configurada de encerramento ou ramificação. O limite global atua como teto de segurança.'] },
  ]),
  page('variaveis-scripts', 'Automação', 'Variáveis, placeholders e scripts', 'Tipos, escopos, variáveis globais e sandbox de JavaScript.', [
    { title: 'Tipos declarados', table: table(['Tipo', 'Exemplo'], [['text', '"5"'], ['number', '5'], ['boolean', 'true'], ['json', 'arrays e objetos serializáveis']]) },
    { title: 'Escopos', bullets: ['vars: contexto público usado pelo fluxo.', 'secureVars: contexto secreto apenas no backend.', 'Contexto visível ao atendimento: variáveis explicitamente marcadas para o agente.', 'Root/default: valor inicial do tenant aplicado à conversa.', 'Placeholders globais incluem CHANNEL, CHANNEL_USER_ID, CHANNEL_CHAT_ID, WA_ID e TG_ID.'] },
    { title: 'Sintaxe', code: { language: 'javascript', value: 'const lista = Array.isArray(vars.ITENS_PEDIDO) ? vars.ITENS_PEDIDO : [];\nlista.push({ item: vars.PEDIDO_NOME, qtd: Number(vars.QUANTIDADE_PEDIDO || 0) });\nvars.ITENS_PEDIDO = lista;\nvars.TOTAL_PEDIDO = Number(vars.TOTAL_PEDIDO || 0) + Number(vars.PRODUTO_PRECO || 0);' } },
    { title: 'Script seguro', bullets: ['Use somente vars e APIs permitidas pelo sandbox.', 'Não use imports, require, process, filesystem ou rede direta.', 'Valide arrays antes de map/push.', 'Preserve valor numérico separado da versão formatada em BRL.', 'Trate respostas HTTP ausentes e arrays vazios.', 'Scripts são validados antes de salvar/publicar.'] },
    { title: 'Placeholder em JSON', code: { language: 'json', value: '{\n  "pedido": "{PEDIDO_FORMAT}",\n  "total": "{TOTAL_PEDIDO_BRL}",\n  "wa_id": "{WA_ID}"\n}' } },
  ]),
  page('templates-catalogo', 'Automação', 'Templates, interativos, catálogo e mídia', 'Conteúdo reutilizável para fluxo e atendimento.', [
    { title: 'Separação de finalidade', table: table(['Recurso', 'Uso'], [['Template de fluxo', 'Menu ou conteúdo reutilizado por automações'], ['Resposta rápida', 'Mensagem curta usada pelo agente'], ['Template WhatsApp', 'HSM aprovado pela Meta para envio ativo'], ['Interativo WhatsApp', 'List, reply buttons, single product ou product list'], ['Catálogo interno', 'Produtos e serviços usados pelo Catalog Node'], ['Asset de mídia', 'Arquivo enviado ao canal ou usado em catálogo']]) },
    { title: 'Variáveis de template Meta', paragraphs: ['O frontend detecta placeholders posicionais e nomeados. O envio monta components de header, body e buttons sem enviar nome vazio. A quantidade fornecida deve coincidir com a esperada pela Meta.'] },
    { title: 'Resposta interativa', bullets: ['A resposta textual pode ser salva em LAST_MESSAGE_FLOW.', 'O payload/row id pode ser salvo separadamente.', 'Condition Node pode comparar texto ou payload.', 'Listas usam até 10 rows; reply buttons usam até 3 botões.'] },
    { title: 'Uploads', bullets: ['Assets pertencem ao tenant.', 'Imagens exibem preview no chat.', 'Áudios usam player e fallback de abertura direta.', 'Documentos exibem nome e download.', 'Legenda é opcional e depende do tipo/canal.'] },
  ]),
  page('dados-relatorios', 'Dados', 'Analytics, relatórios e métricas', 'Leitura operacional e exportação completa por período.', [
    { title: 'Analytics', bullets: ['Overview: volume, estados e principais indicadores.', 'Timeseries: evolução por intervalo.', 'Funnel: etapas e conversão operacional.', 'Bottlenecks: filas, nodes ou etapas com maior retenção.', 'Métricas possuem margem de erro por eventos de terceiros.'] },
    { title: 'Relatórios', paragraphs: ['ADMIN, MANAGER e SUPER_ADMIN podem consultar resumo e exportar CSVs individuais ou ZIP. Filtros incluem tenant, período, canal, fila, agente, status e fluxo quando suportados.'] },
    { title: 'Indicadores', table: table(['Indicador', 'Definição'], [['TME', 'Tempo médio até o agente assumir'], ['Atendimentos', 'Chats atribuídos no período'], ['Duração', 'Tempo entre abertura/assunção e encerramento conforme relatório'], ['NPS/nota', 'Média das avaliações recebidas'], ['Não lidas', 'Mensagens do cliente ainda não visualizadas pelo agente'], ['Funil', 'Passagens registradas por etapa/node'], ['Falhas', 'Eventos de integração ou execução classificados como erro']]) },
  ]),
  page('auditoria-retencao', 'Dados', 'Ocorrências, auditoria e retenção', 'Rastreabilidade, incidentes e ciclo de vida dos dados.', [
    { title: 'Ocorrências', bullets: ['Agrupam erros por origem, severidade e repetição.', 'Podem ser resolvidas ou ignoradas por papel autorizado.', 'Alertas WhatsApp são traduzidos e enviados por toast/socket aos administradores.'] },
    { title: 'Auditoria', bullets: ['Criação, alteração e exclusão de recursos.', 'Publicação e rollback de fluxo.', 'Roteamento e configuração de canal.', 'Assunção, transferência e encerramento de chat.', 'Ações administrativas sensíveis.'] },
    { title: 'Retenção', paragraphs: ['Chats, mensagens, logs e mídia possuem prazos configuráveis. Exclusão de chat deve remover também mensagens e eventos relacionados. Solicitações LGPD usam exportação e apagamento por titular, respeitando obrigações legais.'] },
  ]),
  page('api-convencoes', 'API', 'API: autenticação e convenções', 'Como consumir a API com tenant, token, paginação e erros.', [
    { title: 'Base e autenticação', code: { language: 'http', value: 'Authorization: Bearer <JWT_OU_TOKEN_EXTERNO>\nContent-Type: application/json\nAccept: application/json\nx-tenant-id: tenant_xxx' }, paragraphs: ['O tenant vem do próprio token. Quando o token não fixa um tenant, informe-o pelo header x-tenant-id ou pela query tenantId.'] },
    { title: 'Paginação', code: { language: 'text', value: '?page=1&limit=50&summary=1' }, bullets: ['Use summary=1 em listagens.', 'Não espere messages ou graph completo em respostas resumidas.', 'Busque detalhe por ID.', 'Respeite limites e rate limiting.'] },
    { title: 'Erros', table: table(['Status', 'Significado'], [['400', 'Payload ou contexto inválido'], ['401', 'Token ausente, inválido ou expirado'], ['403', 'Papel, permissão, tenant, senha ou TOTP insuficiente'], ['404', 'Recurso não encontrado no tenant'], ['409', 'Conflito ou duplicidade'], ['429', 'Limite de requisições'], ['500', 'Falha interna; use correlation/logs sem expor secrets']]) },
    { title: 'Idempotência', paragraphs: ['Webhooks usam IDs do provedor. Integrações externas devem enviar identificador estável quando o endpoint oferecer suporte e tratar retries sem criar contato, campanha ou mensagem duplicada.'] },
  ]),
  page('tempo-real', 'API', 'Socket.IO e eventos em tempo real', 'Eventos usados para sincronizar chat, filas, status e alertas.', [
    { title: 'Conexão', paragraphs: ['O cliente conecta ao mesmo host do backend usando JWT. A conexão é autenticada e associada ao usuário/tenant. Reconexão não substitui a leitura inicial da API.'] },
    { title: 'Eventos principais', table: table(['Evento', 'Uso'], [['queue_update', 'Fila recebeu ou alterou atendimento'], ['chat_update', 'Estado, atribuição ou resumo do chat mudou'], ['chat_message', 'Nova mensagem persistida'], ['message_status', 'sent/delivered/read/failed'], ['new_log', 'Novo evento de log autorizado'], ['whatsapp_error', 'Falha traduzida da integração WhatsApp']]) },
    { title: 'Consistência', bullets: ['Carregue snapshot por REST ao abrir a tela.', 'Aplique eventos por messageId/chatId.', 'Deduplicate atualizações otimistas e eventos do socket.', 'Ao reconectar, refaça a leitura do chat selecionado.', 'Socket melhora latência, mas o banco permanece fonte de verdade.'] },
  ]),
  page('seguranca-lgpd', 'Segurança', 'Segurança e LGPD', 'Controles técnicos e responsabilidades de tratamento.', [
    { title: 'Controles', bullets: ['JWT com expiração e heartbeat.', 'bcrypt para senhas.', 'TOTP e elevação para operações sensíveis.', 'Rate limiting geral, login, destrutivo e titular.', 'CORS por origem permitida.', 'Cabeçalhos de segurança e limites de payload.', 'Segregação por tenant.', 'Secrets mascarados em API, logs, exportação e interface.', 'Validação de script e tipos de arquivo.'] },
    { title: 'Papéis LGPD', paragraphs: ['Normalmente o cliente contratante é controlador dos dados dos clientes finais e o Onion Flows atua como operador conforme instruções. O Onion pode atuar como controlador de tratamentos próprios de segurança, auditoria, faturamento e defesa legal.'] },
    { title: 'Dados tratados', bullets: ['Nome, telefone e identificadores de canal.', 'Histórico e mídia enviados voluntariamente.', 'Fila, agente, status e métricas.', 'Logs técnicos e identificadores de segurança.'] },
    { title: 'Não coletar por padrão', bullets: ['CPF, RG e documentos pessoais.', 'Dados de saúde e biometria.', 'Dados bancários e senhas.', 'Dados sensíveis sem necessidade, base legal e contrato específico.'] },
    { title: 'Resposta a incidente', steps: ['Conter e preservar evidências.', 'Identificar tenants, titulares e dados afetados.', 'Rotacionar credenciais quando necessário.', 'Avaliar risco e obrigação de comunicação.', 'Notificar cliente/ANPD/titulares conforme papel e orientação jurídica.', 'Registrar correção e prevenção.'] },
  ]),
  page('glossario', 'Introdução', 'Glossário', 'Termos usados na operação e nas integrações da plataforma.', [
    { title: 'Plataforma', table: table(['Termo', 'Definição'], [['Tenant', 'Ambiente isolado de uma empresa cliente'], ['Fluxo publicado', 'Versão ativa executada pelo motor'], ['Fila', 'Destino de conversas aguardando atendimento humano'], ['TME', 'Tempo médio em que o cliente aguardou sem ser assumido'], ['Outreach', 'Contato ativo iniciado pela empresa'], ['WA ID', 'Identificador do cliente no WhatsApp'], ['WABA', 'Conta do WhatsApp Business na Meta'], ['Phone Number ID', 'Identificador técnico do número remetente'], ['Provider Message ID', 'Identificador da mensagem no provedor'], ['Idempotência', 'Garantia de que repetir um evento não repete seu efeito']]) },
    { title: 'Automação', table: table(['Termo', 'Definição'], [['Node', 'Unidade de comportamento do fluxo'], ['Edge', 'Conexão entre nodes'], ['Case', 'Saída visual de uma decisão'], ['Placeholder', 'Referência a uma variável dentro de texto ou configuração'], ['Secure variable', 'Valor disponível somente no backend'], ['Draft', 'Versão em edição'], ['Rollback', 'Retorno controlado a uma publicação anterior']]) },
  ]),
  page('versoes-docs', 'Introdução', 'Versões da documentação', 'Como interpretar atualizações e compatibilidade do manual.', [
    { title: 'Política', bullets: ['A documentação descreve o comportamento da versão atual da plataforma.', 'Mudanças de provedores externos podem ocorrer sem alteração imediata da aplicação.', 'Guias detalhados por perfil aparecem depois do login.', 'Se algo aqui não bater com o que você vê no painel, fale com o suporte da Onion.'] },
    { title: 'Última revisão', paragraphs: ['Revisada em setembro de 2026. Inclui guias por perfil, receitas, permissões, ciclo do chat, variáveis, limites, erros, recuperação, webhooks e campanhas.'] },
  ]),];

export const docsGroups = [...new Set(docsPages.map((item) => item.group))];
export const defaultDocsSlug = 'inicio';
export const getDocsPage = (slug) => docsPages.find((item) => item.slug === slug) || docsPages[0];
export const restrictedDocsIndex = [
  { slug: 'guia-agente', group: 'Guias por perfil', title: 'Guia do agente', access: 'authenticated' },
  { slug: 'guia-gestao', group: 'Guias por perfil', title: 'Guia de gestão', access: 'authenticated' },
  { slug: 'matriz-permissoes', group: 'Guias por perfil', title: 'Matriz de permissões', access: 'authenticated' },
  { slug: 'receitas-fluxos', group: 'Automação prática', title: 'Receitas de fluxos', access: 'authenticated' },
  { slug: 'dicionario-variaveis', group: 'Automação prática', title: 'Dicionário de variáveis', access: 'authenticated' },
  { slug: 'ciclo-chat-detalhado', group: 'Atendimento', title: 'Ciclo detalhado da conversa', access: 'authenticated' },
  { slug: 'limites-provedores', group: 'Operação', title: 'Limites e compatibilidade', access: 'authenticated' },
  { slug: 'catalogo-erros', group: 'Operação', title: 'Catálogo de erros', access: 'authenticated' },
  { slug: 'backup-recuperacao', group: 'Operação', title: 'Backup e recuperação', access: 'authenticated' },
  { slug: 'webhooks-eventos', group: 'Integrações', title: 'Webhooks e eventos', access: 'authenticated' },
  { slug: 'campanhas-conformidade', group: 'Integrações', title: 'Campanhas e conformidade', access: 'authenticated' },
  { slug: 'api-tenant', group: 'API', title: 'API de integração do tenant', access: 'authenticated' },
  { slug: 'arquitetura', group: 'Interno', title: 'Arquitetura', access: 'super_admin' },
  { slug: 'api-interna', group: 'Interno', title: 'API administrativa interna', access: 'super_admin' },
  { slug: 'infraestrutura-interna', group: 'Interno', title: 'Infraestrutura e deploy', access: 'super_admin' },
  { slug: 'runbook-incidentes', group: 'Interno', title: 'Runbook de incidentes', access: 'super_admin' },
  { slug: 'performance-interna', group: 'Interno', title: 'Performance e capacidade', access: 'super_admin' },
];
