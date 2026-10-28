/**
 * Falas do assistente do header.
 *
 * Regra de conteudo: dica precisa ser verdadeira e especifica da tela. Se nao
 * houver nada util a dizer sobre uma rota, e melhor nao ter entrada nenhuma do
 * que encher com texto generico, porque o balao so tem valor enquanto o usuario
 * confia que ele fala coisa que importa.
 */

const TIPS_BY_ROUTE = {
  '/agent': [
    { id: 'agent_reply', text: 'Enter envia a mensagem, Shift + Enter quebra a linha.' },
    { id: 'agent_pull', text: 'Enquanto o card estiver em espera voce ainda nao pode responder. Puxe o atendimento primeiro.' },
    { id: 'agent_reply_to', text: 'Passe o mouse sobre uma mensagem para responder direto a ela.' },
  ],
  '/agent-dashboard': [
    { id: 'agentdash_tme', text: 'O TME conta o tempo que o cliente esperou antes de alguem puxar o atendimento.' },
  ],
  '/agent-active': [
    { id: 'active_template', text: 'Atendimento ativo so sai por template aprovado pela Meta. Sem template aprovado, nao ha envio.' },
    { id: 'active_campaign', text: 'Selecionando varios contatos de uma vez voce monta um disparo em massa em vez de um envio unico.' },
  ],
  '/monitor': [
    { id: 'monitor_history', text: 'O historico de cada cliente junta todos os atendimentos anteriores dele, nao so o atual.' },
    { id: 'monitor_transfer', text: 'Ao transferir, confira o nome da fila: fila que nao existe mais faz a transferencia falhar.' },
  ],
  '/analytics': [
    { id: 'analytics_env', text: 'Tenants marcados como desenvolvimento ficam de fora destas metricas.' },
    { id: 'analytics_funnel', text: 'O funil mostra onde as conversas param. Etapa que despenca costuma ser node mal conectado.' },
  ],
  '/history': [
    { id: 'history_filter', text: 'Da para filtrar por periodo antes de exportar, o que evita puxar conversa demais de uma vez.' },
  ],
  '/flows': [
    { id: 'flows_publish', text: 'Publicar cria uma versao nova. Se algo quebrar, o historico do fluxo restaura a anterior.' },
    { id: 'flows_draft', text: 'Alteracao salva sem publicar nao vai para o ar: o cliente continua vendo a ultima versao publicada.' },
  ],
  '/editor': [
    { id: 'editor_undo', text: 'Ctrl + Z desfaz e Ctrl + Shift + Z refaz, direto no canvas.' },
    { id: 'editor_drag', text: 'Arraste da bolinha de um node e solte no vazio: abre a lista para ja criar a proxima etapa.' },
    { id: 'editor_lint', text: 'No painel de problemas, so os erros travam a publicacao. Avisos deixam publicar.' },
    { id: 'editor_vars', text: 'No painel de variaveis, clicar numa variavel usada centraliza o canvas no node dela.' },
  ],
  '/subflows': [
    { id: 'subflow_shared', text: 'Subfluxo publicado e compartilhado: editar ele muda todos os fluxos que o usam.' },
    { id: 'subflow_exits', text: 'Todo subfluxo devolve por tres saidas: concluido, retomado e excecao. Ligue as tres.' },
  ],
  '/variables': [
    { id: 'variables_root', text: 'Marcar como visivel no atendimento faz a variavel aparecer para o agente durante a conversa.' },
  ],
  '/schedules': [
    { id: 'schedules_node', text: 'O expediente so muda o atendimento depois que um node de horario aponta para ele dentro do fluxo.' },
  ],
  '/templates': [
    { id: 'templates_meta', text: 'A aprovacao do template e da Meta, nao daqui. Reprovado costuma ser texto promocional demais.' },
  ],
  '/channels': [
    { id: 'channels_routing', text: 'Credencial e roteamento sao coisas separadas: trocar o fluxo de um canal nao mexe no token.' },
    { id: 'channels_alert', text: 'Quando um canal comeca a dar erro, os admins do tenant recebem aviso automatico.' },
  ],
  '/meta-setup': [
    { id: 'meta_alerts', text: 'Queda de qualidade, limite, nome de exibicao e templates viram alerta na aba Alertas. Os dados da conta se atualizam sozinhos a cada hora.' },
    { id: 'meta_diag', text: 'Na aba Conexao, o diagnostico aponta o que falta passo a passo. Rode ele antes de sair procurando no painel da Meta.' },
    { id: 'meta_webhook', text: 'Numero registrado sem webhook inscrito recebe mensagem e nao entrega. Confira os dois.' },
  ],
  '/users': [
    { id: 'users_roles', text: 'Agente ve apenas o proprio atendimento. Para acompanhar a operacao inteira, o papel precisa ser manager.' },
  ],
  '/catalog': [
    { id: 'catalog_media', text: 'Midia enviada aqui ganha URL fixa, entao pode ser usada dentro dos fluxos sem reenviar.' },
  ],
  '/security': [
    { id: 'security_allowlist', text: 'Entrada temporaria expira sozinha. Use ela para acesso pontual em vez de liberar IP para sempre.' },
  ],
  '/system-logs': [
    { id: 'logs_live', text: 'Esta tela atualiza sozinha conforme os eventos chegam. Nao precisa recarregar.' },
  ],
  '/admin': [
    { id: 'admin_env', text: 'Marque como desenvolvimento os tenants de teste: eles somem das metricas de producao.' },
  ],
  '/super-admin': [
    { id: 'superadmin_limits', text: 'Tenant perto do teto de chats do dia comeca a recusar conversa nova. Vale olhar antes de estourar.' },
  ],
  '/billing': [
    { id: 'billing_status', text: 'O estado de pagamento aqui e informativo: ele nao bloqueia o atendimento sozinho.' },
  ],
  '/library': [
    { id: 'library_vs_subflow', text: 'A biblioteca guarda material de referencia. Trecho para reaproveitar de verdade e subfluxo.' },
  ],
  '/incidents': [
    { id: 'incidents_repeat', text: 'Repeticoes agrupam a mesma ocorrencia. Numero alto quer dizer problema constante, nao caso isolado.' },
  ],
  '/performance': [
    { id: 'performance_p95', text: 'Olhe o P95 junto da media: media boa com P95 ruim quer dizer que alguns clientes esperaram muito.' },
  ],
  '/usage': [
    { id: 'usage_limits', text: 'Esses numeros sao os que contam contra os limites do plano do tenant.' },
  ],
};

/**
 * Falas ambiente. Aparecem no lugar de uma dica de vez em quando, no maximo uma
 * por dia, so para o assistente nao virar exclusivamente um manual.
 */
const AMBIENT_BY_PERIOD = {
  madrugada: [
    { id: 'amb_madrugada_1', text: 'Ainda de pe a essa hora? A fila aguenta ate amanha.' },
    { id: 'amb_madrugada_2', text: 'Madrugada adentro de novo. Amanha tambem tem, viu.' },
    { id: 'amb_madrugada_3', text: 'Se ficar ate o sol nascer, pelo menos foi por escolha propria.' },
  ],
  // Faixa das 4h as 6h: nao da para saber se a pessoa acordou cedo ou ainda nao
  // dormiu, entao a fala assume a duvida em vez de chutar um lado.
  virada: [
    { id: 'amb_virada_1', text: 'Voce ainda nao dormiu ou ja acordou? Daqui nao da para saber.' },
    { id: 'amb_virada_2', text: 'Essa hora e terra de ninguem. Bom dia ou boa noite, voce escolhe.' },
  ],
  manha: [
    { id: 'amb_manha_1', text: 'Bom dia. Fila aberta, cafe primeiro.' },
    { id: 'amb_manha_2', text: 'Bom dia. Comecando mais um por aqui.' },
  ],
  tarde: [
    { id: 'amb_tarde_1', text: 'Boa tarde. Metade do dia ja foi.' },
    { id: 'amb_tarde_2', text: 'Como esta indo o dia por ai?' },
  ],
  noite: [
    { id: 'amb_noite_1', text: 'E ai, como foi o seu dia?' },
    { id: 'amb_noite_2', text: 'Ainda por aqui a essa hora? Uma hora tem que fechar o notebook.' },
    { id: 'amb_noite_3', text: 'Boa noite. A fila costuma respirar melhor agora.' },
  ],
};

export const periodOfDay = (hour) => {
  if (hour < 4) return 'madrugada';
  if (hour < 6) return 'virada';
  if (hour < 12) return 'manha';
  if (hour < 18) return 'tarde';
  return 'noite';
};

export const ambientLinesFor = (hour) => AMBIENT_BY_PERIOD[periodOfDay(hour)] || [];

/**
 * O super admin navega dentro de /tenant/<id>/..., que reaproveita as mesmas
 * telas. Sem tirar esse prefixo nenhuma dica apareceria para ele.
 */
export const normalizeRoute = (pathname) => {
  const semTenant = String(pathname || '/').replace(/^\/tenant\/[^/]+/, '');
  return semTenant || '/';
};

export const tipsForRoute = (pathname) => {
  const rota = normalizeRoute(pathname);
  const chave = Object.keys(TIPS_BY_ROUTE)
    .filter((prefixo) => rota === prefixo || rota.startsWith(`${prefixo}/`))
    .sort((a, b) => b.length - a.length)[0];
  return chave ? TIPS_BY_ROUTE[chave] : [];
};

export default TIPS_BY_ROUTE;
