import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive, CalendarRange, CheckCircle2, CircleDollarSign, ClipboardList,
  FlaskConical, Gauge, Inbox, KeyRound, Library, Loader2, Megaphone, Palette,
  Plus, RefreshCw, Save, SlidersHorizontal, Trash2, TriangleAlert, Webhook, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { TableSkeleton } from '../components/LoadingSkeleton';

import TablePagination, { DEFAULT_PAGE_SIZE, usePagination } from '../components/TablePagination';
export const TENANT_MODULES = {
  // serverPaged: a API pagina e devolve o total; a tela pede uma pagina por vez.
  inbox: { title: 'Caixa de entrada', section: 'Operacao', icon: Inbox, endpoint: '/tenant-modules/inbox', serverPaged: true },
  campaigns: { title: 'Campanhas', section: 'Operacao', icon: Megaphone, endpoint: '/tenant-modules/campaigns', serverPaged: true },
  incidents: { title: 'Ocorrencias', section: 'Operacao', icon: TriangleAlert, endpoint: '/tenant-modules/incidents', serverPaged: true },
  library: { title: 'Biblioteca', section: 'Automacao', icon: Library, endpoint: '/tenant-modules/library?limit=50' },
  rules: { title: 'Regras globais', section: 'Automacao', icon: SlidersHorizontal, settings: true },
  tests: { title: 'Testes', section: 'Automacao', icon: FlaskConical, endpoint: '/flows?summary=1&limit=200&page=1' },
  performance: { title: 'Desempenho', section: 'Equipe', icon: Gauge, endpoint: '/tenant-modules/performance' },
  permissions: { title: 'Permissoes', section: 'Equipe', icon: KeyRound, endpoint: '/users' },
  // Nome que cada nivel de cargo mostra nesta empresa (vazio = nome padrao).
  cargos: { title: 'Cargos', section: 'Equipe', icon: KeyRound, settings: true },
  shifts: { title: 'Escalas', section: 'Equipe', icon: CalendarRange, endpoint: '/schedules' },
  identity: { title: 'Identidade', section: 'Configuracao', icon: Palette, settings: true },
  integrations: { title: 'Webhooks e API', section: 'Configuracao', icon: Webhook, endpoint: '/webhooks' },
  retention: { title: 'Retencao de dados', section: 'Configuracao', icon: Archive, settings: true },
  audit: { title: 'Auditoria', section: 'Configuracao', icon: ClipboardList, endpoint: '/tenant-modules/audit', serverPaged: true },
  usage: { title: 'Cobranca e uso', section: 'Configuracao', icon: CircleDollarSign, endpoint: '/tenant-modules/usage' },
};

const SETTING_FIELDS = {
  cargos: [
    ['A1', 'A1 · leitura do próprio histórico', 'text', 'Atendente (somente leitura)'],
    ['A2', 'A2 · atende a fila', 'text', 'Atendente'],
    ['A3', 'A3 · atende e vê a operação', 'text', 'Atendente com visão da operação'],
    ['A4', 'A4 · atende e inicia conversas', 'text', 'Atendente com atendimento ativo'],
    ['B1', 'B1 · vê operação e relatórios', 'text', 'Gestor (somente leitura)'],
    ['B3', 'B3 · transfere e encerra', 'text', 'Supervisor'],
    ['B5', 'B5 · cuida dos atendentes e filas', 'text', 'Coordenador'],
    ['B7', 'B7 · edita fluxos', 'text', 'Gerente'],
    ['B9', 'B9 · contatos, campanhas e gestores', 'text', 'Gerente geral'],
    ['C5', 'C5 · administra, sem WhatsApp e LGPD', 'text', 'Administrador'],
    ['C6', 'C6 · administra tudo', 'text', 'Administrador total'],
  ],
  identity: [
    ['productName', 'Nome do produto no painel', 'text'], ['organizationName', 'Nome da organizacao', 'text'],
    ['logoUrl', 'URL do logotipo (https)', 'url'], ['faviconUrl', 'URL do icone da aba (https)', 'url'],
    ['loginImageUrl', 'URL da imagem da tela de login (https)', 'url'],
    ['primaryColor', 'Cor principal', 'color'], ['supportWhatsapp', 'WhatsApp de suporte', 'tel'],
    ['supportEmail', 'Email de suporte', 'email'], ['timezone', 'Fuso horario', 'text'],
    ['locale', 'Localidade', 'text'], ['welcomeMessage', 'Mensagem institucional', 'textarea'],
  ],
  rules: [
    ['restartCommand', 'Comando de reinicio', 'text'], ['humanCommand', 'Comando para humano', 'text'],
    ['closeCommand', 'Comando de encerramento', 'text'], ['inactivityMinutes', 'Inatividade maxima (minutos)', 'number'],
    ['closeMessage', 'Mensagem de encerramento', 'textarea'], ['silentClose', 'Encerramento silencioso', 'checkbox'],
    ['silentPickup', 'Assumir em silencio (nao avisar o cliente)', 'checkbox'],
  ],
  retention: [
    ['chatRetentionDays', 'Retencao de chats (dias)', 'number'], ['logRetentionDays', 'Retencao de logs (dias)', 'number'],
    ['mediaRetentionDays', 'Retencao de midias (dias)', 'number'], ['deleteOnRequest', 'Permitir exclusao sob solicitacao', 'checkbox'],
  ],
};

const readJson = async (response) => {
  const payload = await response?.json().catch(() => null);
  if (!response?.ok) throw new Error(payload?.error || `Falha HTTP ${response?.status || 0}`);
  return payload;
};

const display = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Nao';
  if (Array.isArray(value)) return value.join(', ') || '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

// Valores crus do banco (status, canal) viram texto para quem opera. O que nao
// estiver no mapa aparece como veio.
const STATUS_LABELS = {
  bot: 'No bot', open: 'Em atendimento', waiting: 'Em espera', closed: 'Encerrado',
  active: 'Ativo', inactive: 'Inativo', draft: 'Rascunho', published: 'Publicado',
  resolved: 'Resolvido', ignored: 'Ignorado', running: 'Em andamento', completed: 'Concluido',
  failed: 'Falhou', paused: 'Pausado', scheduled: 'Agendado', pending: 'Pendente',
  online: 'Online', offline: 'Offline', away: 'Ausente'
};
const CHANNEL_LABELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Web', simulator: 'Simulador', instagram: 'Instagram' };
const SEVERITY_LABELS = { info: 'Informativo', warning: 'Atencao', error: 'Erro', critical: 'Critico', low: 'Baixa', medium: 'Media', high: 'Alta' };
// Mesmo valor cru, sentido diferente: "open" e conversa em atendimento, mas
// ocorrencia aberta.
const MODULE_STATUS_LABELS = { incidents: { open: 'Aberta', resolved: 'Resolvida', ignored: 'Ignorada', acknowledged: 'Reconhecida' } };
const DATE_KEYS = new Set(['timestamp', 'createdAt', 'updatedAt', 'lastSeenAt', 'lastMessageAt', 'firstSeenAt']);
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const messagePreview = (message) => {
  if (!message || typeof message !== 'object') return message;
  if (message.text) return message.text;
  if (message.media) return `[${message.media.type || 'midia'}]`;
  return '-';
};

const displayCell = (key, value, moduleKey) => {
  if (value === null || value === undefined || value === '') return '-';
  if (key === 'status' && typeof value === 'string') return MODULE_STATUS_LABELS[moduleKey]?.[value.toLowerCase()] || STATUS_LABELS[value.toLowerCase()] || value;
  if (key === 'severity' && typeof value === 'string') return SEVERITY_LABELS[value.toLowerCase()] || value;
  if (key === 'lastMessage') return messagePreview(value);
  if (DATE_KEYS.has(key)) return formatDate(value);
  if (key === 'channel' && typeof value === 'string') return CHANNEL_LABELS[value.toLowerCase()] || value;
  if (typeof value === 'number' && !Number.isInteger(value)) return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  return display(value);
};

const rowsFor = (moduleKey, data) => {
  if (moduleKey === 'usage') return Object.entries(data?.counts || {}).map(([key, value]) => ({ id: key, item: key, total: value }));
  if (moduleKey === 'performance') {
    return Array.isArray(data?.items) ? data.items : [];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.flows)) return data.flows;
  return [];
};

const columnsFor = (moduleKey) => ({
  inbox: [['status', 'Status'], ['channelUserId', 'Cliente'], ['queue', 'Fila'], ['agentName', 'Agente'], ['lastMessage', 'Ultima mensagem'], ['lastMessageAt', 'Quando'], ['unreadByAgentCount', 'Nao lidas']],
  campaigns: [['name', 'Campanha'], ['status', 'Status'], ['templateName', 'Template'], ['totalContacts', 'Contatos'], ['successCount', 'Enviados'], ['failedCount', 'Falhas']],
  incidents: [['severity', 'Nivel'], ['title', 'Ocorrencia'], ['source', 'Origem'], ['occurrenceCount', 'Repeticoes'], ['status', 'Status'], ['lastSeenAt', 'Ultimo evento']],
  audit: [['timestamp', 'Data'], ['type', 'Evento'], ['actorName', 'Responsavel'], ['summary', 'Resumo']],
  library: [['name', 'Nome'], ['type', 'Tipo'], ['tags', 'Tags'], ['updatedAt', 'Atualizado em'], ['updatedBy', 'Responsavel']],
  permissions: [['name', 'Usuario'], ['role', 'Papel'], ['permissions', 'Permissoes'], ['queues', 'Filas'], ['status', 'Status']],
  shifts: [['name', 'Escala'], ['timezone', 'Fuso'], ['active', 'Ativa'], ['updatedAt', 'Atualizada em']],
  integrations: [['name', 'Webhook'], ['url', 'URL'], ['events', 'Eventos'], ['updatedAt', 'Atualizado em']],
  usage: [['item', 'Recurso'], ['total', 'Total']],
  performance: [['name', 'Agente'], ['atendidos', 'Atendidos'], ['emAtendimento', 'Em atendimento'], ['duracaoMediaMin', 'Duracao media (min)'], ['duracaoP95Min', 'P95 (min)'], ['ratingAvg', 'Nota media']],
  tests: [['name', 'Fluxo'], ['status', 'Status'], ['updatedAt', 'Atualizado em'], ['version', 'Versao']],
}[moduleKey] || [['name', 'Nome'], ['status', 'Status'], ['updatedAt', 'Atualizado em']]);

const TenantModulePage = ({ moduleKey }) => {
  const { tenantId } = useParams();
  const navigate = useNavigate();
  const module = TENANT_MODULES[moduleKey];
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testReport, setTestReport] = useState(null);
  const [libraryEditorOpen, setLibraryEditorOpen] = useState(false);
  const [serverPage, setServerPage] = useState(1);
  const [libraryDraft, setLibraryDraft] = useState({ name: '', description: '', type: 'block', tags: '', payload: '{\n  "nodes": [],\n  "edges": []\n}' });

  const load = async (page = serverPage) => {
    setLoading(true);
    try {
      const endpoint = module.settings
        ? `/tenant-modules/settings/${moduleKey}`
        : module.serverPaged ? `${module.endpoint}?page=${page}&limit=${DEFAULT_PAGE_SIZE}` : module.endpoint;
      const payload = await readJson(await apiRequest(endpoint));
      if (module.settings) setSettings(payload?.settings || {});
      else setData(payload);
    } catch (error) {
      toast.error(error.message || 'Falha ao carregar modulo');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setServerPage(1); load(1); }, [moduleKey, tenantId]);
  const goToServerPage = (page) => { setServerPage(page); load(page); };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const payload = await readJson(await apiRequest(`/tenant-modules/settings/${moduleKey}`, {
        method: 'PATCH', body: JSON.stringify(settings)
      }));
      setSettings(payload.settings || {});
      if (moduleKey === 'identity') window.dispatchEvent(new Event('brand:changed'));
      toast.success('Configuracao salva');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar');
    } finally { setSaving(false); }
  };

  const updateIncident = async (id, status) => {
    try {
      await readJson(await apiRequest(`/tenant-modules/incidents/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));
      await load();
      toast.success('Ocorrencia atualizada');
    } catch (error) { toast.error(error.message); }
  };

  const validateFlow = async (flowId) => {
    try {
      const report = await readJson(await apiRequest(`/tenant-modules/tests/flows/${flowId}?source=published`));
      setTestReport(report);
    } catch (error) { toast.error(error.message); }
  };

  const createLibraryEntry = async () => {
    setSaving(true);
    try {
      const payload = JSON.parse(libraryDraft.payload || '{}');
      await readJson(await apiRequest('/tenant-modules/library', {
        method: 'POST',
        body: JSON.stringify({
          name: libraryDraft.name,
          description: libraryDraft.description,
          type: libraryDraft.type,
          tags: libraryDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          payload
        })
      }));
      setLibraryEditorOpen(false);
      setLibraryDraft({ name: '', description: '', type: 'block', tags: '', payload: '{\n  "nodes": [],\n  "edges": []\n}' });
      await load();
      toast.success('Item adicionado a biblioteca');
    } catch (error) {
      toast.error(error instanceof SyntaxError ? 'O payload nao e um JSON valido' : error.message);
    } finally { setSaving(false); }
  };

  const removeLibraryEntry = async (id) => {
    if (!window.confirm('Remover este item da biblioteca?')) return;
    try {
      await readJson(await apiRequest(`/tenant-modules/library/${id}`, { method: 'DELETE' }));
      await load();
      toast.success('Item removido');
    } catch (error) { toast.error(error.message); }
  };

  const rows = module ? rowsFor(moduleKey, data) : [];
  const clientPage = usePagination(rows);
  const serverTotal = Number(data?.pagination?.total) || 0;
  const rowsPage = module?.serverPaged && data?.pagination ? {
    pageItems: rows,
    page: serverPage,
    setPage: goToServerPage,
    totalPages: Math.max(1, Number(data.pagination.pages) || 1),
    total: serverTotal,
    from: serverTotal ? (serverPage - 1) * DEFAULT_PAGE_SIZE + 1 : 0,
    to: Math.min(serverPage * DEFAULT_PAGE_SIZE, serverTotal)
  } : clientPage;

  if (!module) return null;
  const columns = columnsFor(moduleKey);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <header className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">{module.title}</h1>
        <div className="flex items-center gap-2">
          {moduleKey === 'library' && <button onClick={() => setLibraryEditorOpen(true)} className="inline-flex items-center gap-2 bg-blue-600 px-3 py-2 text-xs font-semibold text-white"><Plus size={14} /> Novo item</button>}
          <button onClick={() => load()} className="inline-flex items-center gap-2 border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-blue-300 hover:text-blue-600 dark:border-slate-700 dark:text-slate-300"><RefreshCw size={14} /> Atualizar</button>
        </div>
      </header>

      {loading ? <TableSkeleton rows={6} cols={4} /> : module.settings ? (
        <section className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="grid gap-5 p-5 md:grid-cols-2">
            {moduleKey === 'cargos' && <p className="md:col-span-2 text-xs text-slate-500 dark:text-slate-400">Como cada cargo aparece para a sua equipe. Em branco, vale o nome sugerido.</p>}
            {(SETTING_FIELDS[moduleKey] || []).map(([key, label, type, placeholder]) => (
              <label key={key} className={type === 'textarea' ? 'md:col-span-2' : ''}>
                <span className="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</span>
                {type === 'textarea' ? <textarea rows={4} value={settings[key] || ''} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700" />
                  : type === 'checkbox' ? <input type="checkbox" checked={Boolean(settings[key])} onChange={(event) => setSettings({ ...settings, [key]: event.target.checked })} className="h-4 w-4 accent-blue-600" />
                    : type === 'color' ? <span className="flex items-center gap-3"><input type="color" value={settings[key] || '#155dfc'} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} className="h-9 w-14 cursor-pointer border border-slate-200 bg-transparent p-0.5 dark:border-slate-700" /><span className="font-mono text-xs text-slate-500">{settings[key] || 'Padrão'}</span>{settings[key] ? <button type="button" onClick={() => setSettings({ ...settings, [key]: '' })} className="text-xs font-semibold text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Usar padrão</button> : null}</span>
                    : <input type={type} value={settings[key] ?? ''} placeholder={placeholder || undefined} onChange={(event) => setSettings({ ...settings, [key]: type === 'number' ? Number(event.target.value) : event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700" />}
              </label>
            ))}
          </div>
          <div className="flex justify-end border-t border-slate-200 p-4 dark:border-slate-800"><button onClick={saveSettings} disabled={saving} className="inline-flex items-center gap-2 bg-blue-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar</button></div>
        </section>
      ) : (
        <section className="overflow-hidden border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-950/50"><tr>{columns.map(([, label]) => <th key={label} className="px-4 py-3 font-semibold">{label}</th>)}{['incidents', 'tests', 'library'].includes(moduleKey) && <th className="px-4 py-3">Acoes</th>}</tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{rowsPage.pageItems.map((row, index) => <tr key={row.id || index} className="text-slate-600 dark:text-slate-300">{columns.map(([key]) => <td key={key} className="max-w-xs truncate px-4 py-3">{displayCell(key, row[key], moduleKey)}</td>)}{moduleKey === 'incidents' && <td className="whitespace-nowrap px-4 py-3"><button onClick={() => updateIncident(row.id, 'resolved')} className="mr-3 text-blue-600">Resolver</button><button onClick={() => updateIncident(row.id, 'ignored')} className="text-slate-400">Ignorar</button></td>}{moduleKey === 'tests' && <td className="px-4 py-3"><button onClick={() => validateFlow(row.id)} className="text-blue-600">Validar</button></td>}{moduleKey === 'library' && <td className="px-4 py-3"><button onClick={() => removeLibraryEntry(row.id)} className="text-slate-400 hover:text-red-500" title="Remover"><Trash2 size={14} /></button></td>}</tr>)}</tbody></table><TablePagination {...rowsPage} label="registros" /></div> : <div className="px-5 py-14 text-center text-sm text-slate-400">Nenhum registro encontrado.</div>}
        </section>
      )}

      {testReport && <section className="border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><div className="mb-4 flex items-center gap-2"><CheckCircle2 size={17} className={testReport.valid ? 'text-emerald-500' : 'text-red-500'} /><strong className="text-sm">{testReport.valid ? 'Estrutura valida' : 'Estrutura com erros'}</strong></div><div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">{[...(testReport.errors || []), ...(testReport.warnings || [])].map((entry, index) => <div key={`${entry.code}-${index}`} className="border-l-2 border-slate-300 pl-3"><strong>{entry.code}</strong> {entry.message} {entry.nodeId ? `(${entry.nodeId})` : ''}</div>)}</div></section>}

      {moduleKey === 'permissions' && <button onClick={() => navigate(tenantId ? `/tenant/${tenantId}/users` : '/users')} className="text-xs font-semibold text-blue-600">Gerenciar usuarios e permissoes</button>}
      {moduleKey === 'shifts' && <button onClick={() => navigate(tenantId ? `/tenant/${tenantId}/schedules` : '/schedules')} className="text-xs font-semibold text-blue-600">Gerenciar expediente</button>}
      {moduleKey === 'integrations' && <button onClick={() => navigate(tenantId ? `/tenant/${tenantId}/channels` : '/channels')} className="text-xs font-semibold text-blue-600">Gerenciar canais</button>}

      {libraryEditorOpen && <div className="fixed inset-0 z-[200] grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && setLibraryEditorOpen(false)}><section className="w-full max-w-3xl border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"><header className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800"><div><div className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">Automacao</div><h2 className="text-base font-semibold">Novo item da biblioteca</h2></div><button onClick={() => setLibraryEditorOpen(false)} className="text-slate-400 hover:text-slate-900 dark:hover:text-white"><X size={18} /></button></header><div className="grid gap-4 p-5 md:grid-cols-2"><label><span className="mb-1 block text-xs font-semibold">Nome</span><input value={libraryDraft.name} onChange={(event) => setLibraryDraft({ ...libraryDraft, name: event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700" /></label><label><span className="mb-1 block text-xs font-semibold">Tipo</span><select value={libraryDraft.type} onChange={(event) => setLibraryDraft({ ...libraryDraft, type: event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700"><option value="block">Bloco</option><option value="flow">Fluxo</option><option value="template">Template</option></select></label><label className="md:col-span-2"><span className="mb-1 block text-xs font-semibold">Descricao</span><input value={libraryDraft.description} onChange={(event) => setLibraryDraft({ ...libraryDraft, description: event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700" /></label><label className="md:col-span-2"><span className="mb-1 block text-xs font-semibold">Tags separadas por virgula</span><input value={libraryDraft.tags} onChange={(event) => setLibraryDraft({ ...libraryDraft, tags: event.target.value })} className="w-full border border-slate-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700" /></label><label className="md:col-span-2"><span className="mb-1 block text-xs font-semibold">Payload JSON</span><textarea rows={12} value={libraryDraft.payload} onChange={(event) => setLibraryDraft({ ...libraryDraft, payload: event.target.value })} className="w-full border border-slate-200 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-blue-500 dark:border-slate-700" /></label></div><footer className="flex justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-800"><button onClick={() => setLibraryEditorOpen(false)} className="border border-slate-200 px-4 py-2 text-xs font-semibold dark:border-slate-700">Cancelar</button><button onClick={createLibraryEntry} disabled={saving || !libraryDraft.name.trim()} className="inline-flex items-center gap-2 bg-blue-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar</button></footer></section></div>}
    </div>
  );
};

export default TenantModulePage;
