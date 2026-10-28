import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Pencil, Plug, Plus, Trash2, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { can } from '../utils/managerPermissions';
import useEditorPanelTop from '../hooks/useEditorPanelTop';
import { INTEGRATION_ICONS, INTEGRATION_ICON_LABELS, integrationIcon } from '../utils/integrationIcons';

// Integracoes REST do cliente, abertas dentro do editor de fluxo: endereco base
// e chave secreta ficam aqui, e o node HTTP so escolhe a integracao e informa
// o caminho. Lista, formulario e teste trocam dentro da mesma barra lateral.
export const OPEN_INTEGRATIONS_EVENT = 'onion:open-integrations';
export const INTEGRATIONS_CHANGED_EVENT = 'onion:integrations-changed';

const AUTH_LABELS = {
  none: 'Sem autenticação',
  bearer: 'Bearer token',
  header: 'Cabeçalho próprio',
  basic: 'Usuário e senha (Basic)'
};

const EMPTY_FORM = { name: '', icon: 'globe', description: '', baseUrl: 'https://', authType: 'bearer', headerName: 'X-Api-Key', username: '', secret: '' };

const inputClass = 'h-9 w-full rounded-[2px] border border-slate-400 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-white dark:focus:border-slate-300';
const labelClass = 'mb-1 block font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400';
const botaoSecundario = 'h-8 rounded-[2px] border border-slate-500 bg-slate-100 px-3 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const botaoPrimario = 'flex h-8 items-center gap-1.5 rounded-[2px] border border-slate-950 bg-slate-950 px-3 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-200 dark:bg-slate-100 dark:text-slate-950';

const lerJson = async (res) => (res ? res.json().catch(() => null) : null);
const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const avisarMudanca = () => window.dispatchEvent(new Event(INTEGRATIONS_CHANGED_EVENT));

const IntegrationsDrawer = ({ open, onClose }) => {
  const { user } = useAuth();
  const reduceMotion = useReducedMotion();
  const topo = useEditorPanelTop(open);
  const podeEditar = can(user, 'fluxos.editar');
  const [itens, setItens] = useState(null);
  const [form, setForm] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [teste, setTeste] = useState(null);
  const [excluindo, setExcluindo] = useState(null);
  const subTela = useRef(false);
  subTela.current = Boolean(form || teste);

  const carregar = async () => {
    try {
      const res = await apiRequest('/rest-integrations');
      const body = await lerJson(res);
      if (!res?.ok) throw new Error(body?.error || 'Falha ao carregar as integrações');
      setItens(body || []);
    } catch (error) {
      toast.error(error.message);
      setItens([]);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    carregar();
    setForm(null);
    setTeste(null);
    // Esc volta da tela de formulario/teste para a lista; na lista, fecha.
    // Em captura, para nao fechar junto a configuracao do node que esta atras.
    const tecla = (event) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      if (subTela.current) {
        setForm(null);
        setTeste(null);
      } else {
        onClose?.();
      }
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [open]);

  const salvar = async (event) => {
    event.preventDefault();
    const editando = Boolean(form.id);
    const corpo = {
      name: form.name,
      icon: form.icon,
      description: form.description,
      baseUrl: form.baseUrl,
      authType: form.authType,
      headerName: form.headerName,
      username: form.username,
      ...(form.secret ? { secret: form.secret } : {})
    };
    setSalvando(true);
    try {
      const res = await apiRequest(editando ? `/rest-integrations/${form.id}` : '/rest-integrations', {
        method: editando ? 'PATCH' : 'POST',
        body: JSON.stringify(corpo)
      });
      const body = await lerJson(res);
      if (!res?.ok) throw new Error(body?.error || 'Falha ao salvar');
      setItens((atual) => (editando ? atual.map((item) => (item.id === body.id ? body : item)) : [...(atual || []), body]));
      setForm(null);
      avisarMudanca();
      toast.success(editando ? 'Integração salva' : 'Integração criada');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvando(false);
    }
  };

  // Confirmacao na propria linha: o dialogo padrao abriria atras da barra.
  const excluir = async (item) => {
    setExcluindo(null);
    const res = await apiRequest(`/rest-integrations/${item.id}`, { method: 'DELETE' });
    const body = await lerJson(res);
    if (!res?.ok) {
      toast.error(res?.status === 409 ? `Em uso no fluxo: ${(body?.flows || []).slice(0, 3).join(', ')}` : (body?.error || 'Falha ao excluir'));
      return;
    }
    setItens((atual) => atual.filter((x) => x.id !== item.id));
    avisarMudanca();
    toast.success('Integração excluída');
  };

  const testar = async () => {
    setTeste((atual) => ({ ...atual, rodando: true, resultado: null }));
    try {
      const res = await apiRequest(`/rest-integrations/${teste.item.id}/test`, { method: 'POST', body: JSON.stringify({ path: teste.path }) });
      const body = await lerJson(res);
      if (!res?.ok) throw new Error(body?.error || 'Falha ao testar');
      setTeste((atual) => ({ ...atual, rodando: false, resultado: body }));
      carregar();
    } catch (error) {
      setTeste((atual) => ({ ...atual, rodando: false, resultado: { ok: false, error: error.message } }));
    }
  };

  if (!open) return null;

  const titulo = form ? (form.id ? 'Editar integração' : 'Nova integração') : teste ? `Testar ${teste.item.name}` : 'Integrações';
  const voltar = () => { setForm(null); setTeste(null); };

  return (
    <motion.aside
      style={{ top: topo }}
      className="fixed bottom-0 right-0 z-[10000] flex w-[440px] max-w-full flex-col border-l border-slate-500 bg-slate-100 shadow-[-8px_0_24px_rgba(15,23,42,0.14)] dark:border-slate-600 dark:bg-slate-900"
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Integrações"
    >
      <div className="flex min-h-12 items-center gap-2 border-b border-slate-500 bg-slate-300 px-3 dark:bg-slate-800">
        {(form || teste) && (
          <button type="button" onClick={voltar} aria-label="Voltar para a lista" className="grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><ArrowLeft size={14} /></button>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">API REST</p>
          <h3 className="truncate font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">{titulo}</h3>
        </div>
        {!form && !teste && podeEditar && (
          <button type="button" onClick={() => setForm({ ...EMPTY_FORM })} className={botaoPrimario}><Plus size={12} /> Nova</button>
        )}
        <button type="button" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)" className="grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><X size={15} /></button>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {form ? (
          <form id="form-integracao" onSubmit={salvar} className="space-y-4 p-4">
            <label className="block">
              <span className={labelClass}>Nome</span>
              <input required autoFocus maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ERP da loja" className={inputClass} />
            </label>
            <div>
              <span className={labelClass}>Ícone</span>
              <div className="flex flex-wrap gap-1">
                {Object.entries(INTEGRATION_ICONS).map(([chave, Icon]) => (
                  <button key={chave} type="button" onClick={() => setForm({ ...form, icon: chave })} aria-label={INTEGRATION_ICON_LABELS[chave]} title={INTEGRATION_ICON_LABELS[chave]} aria-pressed={form.icon === chave}
                    className={`grid h-8 w-8 place-items-center rounded-[2px] border transition ${form.icon === chave ? 'border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950' : 'border-slate-400 text-slate-600 hover:border-slate-700 dark:border-slate-600 dark:text-slate-300'}`}>
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className={labelClass}>Descrição (opcional)</span>
              <input maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Consulta de pedidos e estoque" className={inputClass} />
            </label>
            <label className="block">
              <span className={labelClass}>Endereço base</span>
              <input required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.suaempresa.com.br/v1" className={`${inputClass} font-mono text-xs`} />
              <span className="mt-1 block text-[11px] text-slate-500">No node HTTP você informa só o caminho, como /pedidos/{'{numero}'}.</span>
            </label>
            <label className="block">
              <span className={labelClass}>Autenticação</span>
              <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })} className={inputClass}>
                {Object.entries(AUTH_LABELS).map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
              </select>
            </label>
            {form.authType === 'header' && (
              <label className="block">
                <span className={labelClass}>Nome do cabeçalho</span>
                <input required value={form.headerName} onChange={(e) => setForm({ ...form, headerName: e.target.value })} className={`${inputClass} font-mono text-xs`} />
              </label>
            )}
            {form.authType === 'basic' && (
              <label className="block">
                <span className={labelClass}>Usuário</span>
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={inputClass} />
              </label>
            )}
            {form.authType !== 'none' && (
              <label className="block">
                <span className={labelClass}>{form.authType === 'basic' ? 'Senha' : 'Chave secreta'}</span>
                <input type="password" autoComplete="new-password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  required={!form.hasSecret} placeholder={form.hasSecret ? 'Guardada. Deixe em branco para manter' : ''} className={`${inputClass} font-mono text-xs`} />
                <span className="mt-1 block text-[11px] text-slate-500">Fica cifrada e não volta para a tela, nem para quem criou.</span>
              </label>
            )}
          </form>
        ) : teste ? (
          <div className="space-y-4 p-4">
            <label className="block">
              <span className={labelClass}>Caminho (GET com a chave guardada)</span>
              <div className="flex">
                <span className="flex h-9 max-w-[55%] items-center truncate rounded-l-[2px] border border-r-0 border-slate-400 bg-slate-200 px-2 font-mono text-[11px] text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">{teste.item.baseUrl}</span>
                <input autoFocus value={teste.path} onChange={(e) => setTeste({ ...teste, path: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') testar(); }} placeholder="/status" className={`${inputClass} rounded-l-none font-mono text-xs`} />
              </div>
            </label>
            {teste.resultado && (
              <div className={`rounded-[2px] border p-3 text-xs ${teste.resultado.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200' : 'border-red-300 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'}`}>
                <div className="font-mono font-bold">
                  {teste.resultado.status ? `HTTP ${teste.resultado.status}` : 'Sem resposta'}
                  {teste.resultado.durationMs != null && <span className="font-normal opacity-70"> · {teste.resultado.durationMs} ms</span>}
                </div>
                {teste.resultado.error && <p className="mt-1">{teste.resultado.error}</p>}
                {teste.resultado.preview && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">{teste.resultado.preview}</pre>}
              </div>
            )}
          </div>
        ) : !itens ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-[2px] bg-slate-200 dark:bg-slate-800" />)}</div>
        ) : itens.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <Plug size={24} className="text-slate-400" />
            <p className="text-sm text-slate-600 dark:text-slate-400">Cadastre a API do seu sistema (ERP, loja, agenda) uma vez e use em qualquer node HTTP sem colar a chave em cada um.</p>
            {podeEditar && <button type="button" onClick={() => setForm({ ...EMPTY_FORM })} className={botaoPrimario}><Plus size={12} /> Criar integração</button>}
          </div>
        ) : (
          <ul className="divide-y divide-slate-300 dark:divide-slate-700">
            {itens.map((item) => {
              const Icon = integrationIcon(item.icon);
              return (
                <li key={item.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[2px] border border-slate-400 text-slate-700 dark:border-slate-600 dark:text-slate-200"><Icon size={15} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-950 dark:text-white">{item.name}</div>
                      {item.description && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{item.description}</p>}
                      <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500 dark:text-slate-400" title={item.baseUrl}>{item.baseUrl} · {AUTH_LABELS[item.authType] || item.authType}</p>
                      {item.lastOk === false && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">Último erro {quando(item.lastErrorAt)}: {item.lastError}</p>}
                    </div>
                    {podeEditar && excluindo === item.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => setExcluindo(null)} className={botaoSecundario}>Manter</button>
                        <button type="button" onClick={() => excluir(item)} className="h-8 rounded-[2px] border border-red-700 bg-red-600 px-3 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-red-700">Excluir</button>
                      </div>
                    ) : podeEditar && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => setTeste({ item, path: '', resultado: null })} className={botaoSecundario}>Testar</button>
                        <button type="button" onClick={() => setForm({ ...EMPTY_FORM, ...item, headerName: item.headerName || 'X-Api-Key', secret: '' })} aria-label={`Editar ${item.name}`} className="grid h-8 w-8 place-items-center rounded-[2px] border border-slate-500 text-slate-600 transition-colors hover:bg-slate-300 dark:text-slate-300 dark:hover:bg-slate-800"><Pencil size={13} /></button>
                        <button type="button" onClick={() => setExcluindo(item.id)} aria-label={`Excluir ${item.name}`} className="grid h-8 w-8 place-items-center rounded-[2px] border border-slate-500 text-slate-600 transition-colors hover:border-red-600 hover:text-red-600 dark:text-slate-300"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(form || teste) && (
        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-500 bg-slate-200 p-2.5 dark:bg-slate-800">
          <button type="button" onClick={voltar} className={botaoSecundario}>{form ? 'Cancelar' : 'Voltar'}</button>
          {form
            ? <button type="submit" form="form-integracao" disabled={salvando} className={botaoPrimario}>{salvando ? 'Salvando...' : 'Salvar'}</button>
            : <button type="button" onClick={testar} disabled={teste.rodando} className={botaoPrimario}>{teste.rodando ? 'Chamando...' : 'Chamar'}</button>}
        </div>
      )}
    </motion.aside>
  );
};

export default IntegrationsDrawer;
