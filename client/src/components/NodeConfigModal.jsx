import React, { useState, useEffect, useRef } from 'react';
import { X, Save, Plus, Trash2, Code, Split, FileText, Send, Clock, Users, Hourglass, Hand, Anchor, Database, Globe, Flag, Command, Image, Upload, Key, Smartphone, Settings, MessageSquare, FormInput, List, ChevronUp, ChevronDown, ChevronRight, ListOrdered, Check, ShoppingCart, Download } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import useEditorPanelTop from '../hooks/useEditorPanelTop';
import WhatsAppPreview, { buildWhatsAppPreview } from './WhatsAppPreview';
import { uploadMediaAsset } from '../services/media';
import { apiRequest } from '../services/api';
import { INTEGRATIONS_CHANGED_EVENT, OPEN_INTEGRATIONS_EVENT } from './IntegrationsDrawer';

// Configuracao do node numa barra fixa a direita, com a altura toda: o canvas
// continua visivel e navegavel enquanto se edita. A largura segue o tamanho
// que cada tipo de node pede (os de template e catalogo sao mais largos).
const ConfigWrapper = ({ title, onClose, onSave, children, sizeClass = 'max-w-lg' }) => {
    const reduceMotion = useReducedMotion();
    const topo = useEditorPanelTop();
    const largura = sizeClass.includes('max-w-5xl') ? 760 : sizeClass.includes('max-w-3xl') ? 620 : 440;

    useEffect(() => {
        const fecharComEsc = (event) => { if (event.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', fecharComEsc);
        return () => window.removeEventListener('keydown', fecharComEsc);
    }, [onClose]);

    return (
        <motion.aside
            className="node-config-inspector fixed bottom-0 right-0 z-[9999] flex max-w-full flex-col border-l border-slate-500 bg-slate-100 shadow-[-8px_0_24px_rgba(15,23,42,0.14)] dark:border-slate-600 dark:bg-slate-900"
            style={{ width: largura, top: topo }}
            initial={reduceMotion ? false : { x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            aria-label={`Configuração: ${title}`}
        >
                <div className="flex min-h-12 items-center justify-between border-b border-slate-500 bg-slate-300 px-3 dark:bg-slate-800">
                    <div className="min-w-0">
                        <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Configuração do node</p>
                        <h3 className="truncate font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">{title}</h3>
                    </div>
                    <button onClick={onClose} aria-label="Fechar" title="Fechar (Esc)" className="ml-3 grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><X size={15} /></button>
                </div>
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-slate-100 p-4 dark:bg-slate-900">
                    {children}
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-slate-500 bg-slate-200 p-2.5 dark:bg-slate-800">
                    {onSave ? <>
                    <button onClick={onClose} className="rounded-[2px] border border-slate-500 bg-slate-100 px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200">Cancelar</button>
                    <button onClick={onSave} className="flex items-center gap-2 rounded-[2px] border border-slate-950 bg-slate-950 px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 dark:border-slate-200 dark:bg-slate-100 dark:text-slate-950">
                        <Save size={13} /> Salvar
                    </button>
                    </> : (
                    // Somente visualizacao: sem salvar, o que for mexido aqui se perde ao fechar.
                    <>
                    <span className="mr-auto self-center font-mono text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">Somente visualização</span>
                    <button onClick={onClose} className="rounded-[2px] border border-slate-500 bg-slate-100 px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200">Fechar</button>
                    </>
                    )}
                </div>
        </motion.aside>
    );
};

const AnchorConfig = ({ data, onChange }) => (
    <div className="space-y-4">
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Nome desta Âncora</label>
            <input
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="Ex: menu_principal"
                value={data.anchorName || ''}
                onChange={e => onChange({ anchorName: e.target.value })}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Dê um nome único. Use este mesmo nome no nó "Ir Para" (GoTo) para criar um salto no fluxo.
            </p>
        </div>
    </div>
);



const ScriptConfig = ({ data, onChange }) => {
    const [status, setStatus] = useState({ type: 'idle', message: 'Sem validação.' });
    const [validating, setValidating] = useState(false);

    useEffect(() => {
        setStatus({ type: 'idle', message: 'Sem validação.' });
    }, [data.script]);

    // Chama o validador do backend (mesmas regras aplicadas no save). Evita
    // que o front diga "Sintaxe OK" e o salvamento depois retorne 400 por
    // construções proibidas (constructor, eval, Function, etc).
    const validateScript = async () => {
        setValidating(true);
        try {
            const res = await apiRequest('/flows/validate-script', {
                method: 'POST',
                body: JSON.stringify({ script: data.script || '' })
            });
            if (!res) return;
            const payload = await res.json().catch(() => ({}));
            if (res.ok && payload.ok) {
                setStatus({ type: 'ok', message: 'Script válido. Pode publicar.' });
            } else {
                setStatus({
                    type: 'error',
                    message: payload.reason || payload.error || 'Script inválido'
                });
            }
        } catch (error) {
            setStatus({ type: 'error', message: error?.message || 'Falha ao validar.' });
        } finally {
            setValidating(false);
        }
    };

    const statusStyles = status.type === 'ok'
        ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-200'
        : status.type === 'error'
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200'
            : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400';

    return (
        <div className="space-y-4">
            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Código JavaScript (Sandbox)</label>
                <p className="mb-2 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Use o objeto 'vars' para ler/escrever. Ex: vars.nome = vars.nome.toUpperCase();</p>
                <textarea
                    className="w-full p-3 border rounded-[2px] h-64 font-mono text-xs dark:bg-slate-900 dark:text-green-400 outline-none"
                    value={data.script || ''}
                    onChange={e => onChange({ script: e.target.value })}
                    placeholder="// Escreva seu código aqui..."
                />
            </div>

            <div className="flex items-center justify-between">
                <span className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">A validação verifica sintaxe e construções proibidas (eval, constructor, etc).</span>
                <button
                    type="button"
                    onClick={validateScript}
                    disabled={validating}
                    className="h-8 rounded-[2px] border border-slate-950 bg-slate-950 px-3 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950"
                >
                    {validating ? 'Validando…' : 'Validar'}
                </button>
            </div>

            <div className={`border rounded-[2px] p-3 text-[11px] font-mono ${statusStyles}`}>
                {status.message}
            </div>
        </div>
    );
};

const ConditionConfig = ({ data, onChange, vars }) => (
    <div className="space-y-4">
        <div className="flex justify-between items-center">
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Regras de Condicao (IF)</label>
            <button
                onClick={() => onChange({ conditions: [...(data.conditions || []), { id: Date.now(), variable: '', operator: '==', value: '' }] })}
                className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
                <Plus size={14} /> Add Regra
            </button>
        </div>
        <div className="space-y-3">
            {(data.conditions || []).map((cond, i) => (
                <div key={cond.id} className="p-3 bg-slate-50 dark:bg-slate-700 rounded-[2px] border border-slate-200 dark:border-slate-600 space-y-2">
                    <div className="flex gap-2">
                        <select
                            className="flex-1 p-2 border rounded-[2px] text-xs dark:bg-slate-800"
                            value={cond.variable}
                            onChange={e => {
                                const newC = [...data.conditions]; newC[i].variable = e.target.value; onChange({ conditions: newC });
                            }}
                        >
                            <option value="">Variavel...</option>
                            {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                        </select>
                        <select
                            className="w-20 p-2 border rounded-[2px] text-xs dark:bg-slate-800"
                            value={cond.operator}
                            onChange={e => {
                                const newC = [...data.conditions]; newC[i].operator = e.target.value; onChange({ conditions: newC });
                            }}
                        >
                            <option value="==">==</option>
                            <option value="!=">!=</option>
                            <option value=">">&gt;</option>
                            <option value="<">&lt;</option>
                            <option value="contains">contem</option>
                        </select>
                    </div>
                    <div className="flex gap-2">
                        <input
                            className="flex-1 p-2 border rounded-[2px] text-xs dark:bg-slate-800"
                            placeholder="Valor"
                            value={cond.value}
                            onChange={e => {
                                const newC = [...data.conditions]; newC[i].value = e.target.value; onChange({ conditions: newC });
                            }}
                        />
                        <button onClick={() => onChange({ conditions: data.conditions.filter(c => c.id !== cond.id) })} className="text-red-500"><Trash2 size={16} /></button>
                    </div>
                </div>
            ))}
            <div className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">Cada regra acima gera uma saida lateral no no.</div>
        </div>
        <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
            <label className="flex items-center gap-3 cursor-pointer group">
                <div className="relative flex items-center">
                    <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={data.hasElse ?? true}
                        onChange={e => onChange({ hasElse: e.target.checked })}
                    />
                    <div className="w-10 h-5 bg-slate-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-slate-900 dark:peer-checked:bg-slate-200"></div>
                </div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200 uppercase tracking-wide group-hover:text-slate-950 dark:group-hover:text-white transition-colors">
                    Gerar saida Else
                </span>
            </label>
            <p className="mt-1 pl-13 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Se desmarcado, o fluxo para caso nenhuma condicao seja atendida.
            </p>
        </div>
    </div>
);

const TemplateConfig = ({ data, onChange, templates }) => (
    <div className="space-y-4">
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Selecionar Template (HSM)</label>
            <select
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700"
                value={data.templateId || ''}
                onChange={e => onChange({ templateId: e.target.value })}
            >
                <option value="">Selecione um modelo...</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
        </div>
        {data.templateId && (
            <div className="border border-slate-300 bg-slate-200/60 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-300">Os botões configurados neste template aparecerão automaticamente como saídas no fluxo.</p>
            </div>
        )}
    </div>
);

const HttpRequestConfig = ({ data, onChange, vars }) => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const responseTypes = ['json', 'text'];
    const [integrations, setIntegrations] = useState(null);

    // Recarrega quando uma integracao e criada ou editada na barra de integracoes.
    useEffect(() => {
        let ativo = true;
        const carregar = () => apiRequest('/rest-integrations')
            .then((res) => (res?.ok ? res.json() : []))
            .then((lista) => { if (ativo) setIntegrations(Array.isArray(lista) ? lista : []); })
            .catch(() => { if (ativo) setIntegrations([]); });
        carregar();
        window.addEventListener(INTEGRATIONS_CHANGED_EVENT, carregar);
        return () => { ativo = false; window.removeEventListener(INTEGRATIONS_CHANGED_EVENT, carregar); };
    }, []);

    const integration = (integrations || []).find((item) => item.id === data.integrationId);
    // Nome e icone vao junto no node so para o canvas mostrar; o servidor
    // resolve endereco e chave pelo id.
    const escolherIntegracao = (id) => {
        const escolhida = (integrations || []).find((item) => item.id === id);
        onChange(escolhida
            ? { integrationId: escolhida.id, integrationName: escolhida.name, integrationIcon: escolhida.icon, path: data.path || '' }
            : { integrationId: '', integrationName: '', integrationIcon: '' });
    };

    const addMapping = () => {
        const newMappings = [...(data.mappings || []), { jsonPath: '', varName: '' }];
        onChange({ mappings: newMappings });
    };

    const updateMapping = (index, field, value) => {
        const newMappings = [...data.mappings];
        newMappings[index][field] = value;
        onChange({ mappings: newMappings });
    };

    const removeMapping = (index) => {
        onChange({ mappings: data.mappings.filter((_, i) => i !== index) });
    };

    return (
        <div className="space-y-4">
            <div>
                <div className="flex items-center justify-between">
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Integração</label>
                    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_INTEGRATIONS_EVENT))} className="font-mono text-[10px] font-bold uppercase text-slate-700 underline-offset-2 hover:text-slate-950 hover:underline dark:text-slate-300 dark:hover:text-white">
                        {integrations && integrations.length === 0 ? 'Criar integração' : 'Gerenciar'}
                    </button>
                </div>
                <select
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                    value={data.integrationId || ''}
                    onChange={e => escolherIntegracao(e.target.value)}
                    disabled={integrations === null}
                >
                    <option value="">Nenhuma (URL completa)</option>
                    {(integrations || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    {data.integrationId && integrations && !integration && <option value={data.integrationId}>{data.integrationName || 'Integração removida'}</option>}
                </select>
                {data.integrationId && integrations && !integration && (
                    <p className="mt-1 text-[10px] text-red-600">Essa integração não existe mais. Escolha outra ou use URL completa.</p>
                )}
            </div>

            <div className="grid grid-cols-4 gap-2">
                <div className="col-span-1">
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Método</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.method || 'GET'}
                        onChange={e => onChange({ method: e.target.value })}
                    >
                        {methods.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </div>
                {data.integrationId ? (
                <div className="col-span-3">
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Caminho</label>
                    <input
                        type="text"
                        className="w-full mt-1 p-2 border rounded-[2px] font-mono text-sm dark:bg-slate-700 dark:text-white"
                        placeholder="/pedidos/{numero_pedido}"
                        value={data.path || ''}
                        onChange={e => onChange({ path: e.target.value })}
                    />
                </div>
                ) : (
                <div className="col-span-3">
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Endpoint (URL)</label>
                    <input
                        type="text"
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        placeholder="https://api.exemplo.com/v1/cliente/{cpf}"
                        value={data.url || ''}
                        onChange={e => onChange({ url: e.target.value })}
                    />
                </div>
                )}
            </div>

            <p className="break-all text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                {integration
                    ? <>Chama <code>{integration.baseUrl}{data.path ? (data.path.startsWith('/') || data.path.startsWith('?') ? data.path : `/${data.path}`) : ''}</code> com a chave da integração.</>
                    : <>Dica: Use <code>{'{variavel}'}</code> na URL para enviar dados dinâmicos.</>}
            </p>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Tipo de resposta</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.responseType || 'json'}
                        onChange={e => onChange({ responseType: e.target.value })}
                    >
                        {responseTypes.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Timeout (ms)</label>
                    <input
                        type="number"
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.timeoutMs || 10000}
                        onChange={e => onChange({ timeoutMs: Number(e.target.value) || 10000 })}
                    />
                </div>
            </div>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Headers (JSON)</label>
                <textarea
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white font-mono h-24"
                    placeholder='{"Content-Type":"application/json"}'
                    value={data.headersJson || ''}
                    onChange={e => onChange({ headersJson: e.target.value })}
                />
            </div>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Body (opcional)</label>
                <textarea
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white font-mono h-24"
                    placeholder='{"cpf":"{cpf}","nome":"{nome_cliente}"}'
                    value={data.body || ''}
                    onChange={e => onChange({ body: e.target.value })}
                />
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                    Dica: variáveis também funcionam no corpo.
                </p>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                <div className="flex justify-between items-center mb-3">
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mapear Resposta JSON</label>
                    <button
                        onClick={addMapping}
                        className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                        <Plus size={14} /> Add Campo
                    </button>
                </div>

                <div className="space-y-2">
                    {(data.mappings || []).map((m, i) => (
                        <div key={i} className="flex gap-2 items-center bg-slate-50 dark:bg-slate-700/50 p-2 rounded-[2px]">
                            <input
                                className="flex-1 p-1.5 border rounded-[2px] text-xs dark:bg-slate-800 dark:text-white"
                                placeholder="Caminho (ex: data.nome)"
                                value={m.jsonPath}
                                onChange={e => updateMapping(i, 'jsonPath', e.target.value)}
                            />
                            <span className="text-slate-400">-&gt;</span>
                            <select
                                className="flex-1 p-1.5 border rounded-[2px] text-xs dark:bg-slate-800 dark:text-white"
                                value={m.varName}
                                onChange={e => updateMapping(i, 'varName', e.target.value)}
                            >
                                <option value="">Salvar em...</option>
                                {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                            </select>
                            <button onClick={() => removeMapping(i)} className="text-red-500 hover:bg-red-50 p-1 rounded-[2px]">
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                    {(!data.mappings || data.mappings.length === 0) && (
                        <p className="text-center text-[11px] text-slate-400 py-2 italic">Nenhum mapeamento definido.</p>
                    )}
                </div>
            </div>
        </div>
    );
};

const GotoConfig = ({ data, onChange, anchors = [] }) => {
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);
    const boxRef = useRef(null);

    const selected = data.targetAnchor || '';
    const filtered = anchors.filter((name) => name.toLowerCase().includes(search.trim().toLowerCase()));
    const selectedExists = !selected || anchors.includes(selected);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const choose = (name) => {
        onChange({ targetAnchor: name });
        setSearch('');
        setOpen(false);
    };

    return (
        <div className="space-y-4">
            <div ref={boxRef} className="relative">
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Âncora de destino</label>

                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="mt-1 flex w-full items-center justify-between gap-2 rounded-[2px] border border-slate-400 bg-white p-2 text-left font-mono text-xs text-slate-900 dark:border-slate-500 dark:bg-slate-950 dark:text-slate-100"
                >
                    <span className={selected ? '' : 'text-slate-400'}>
                        {selected || 'Selecione uma âncora...'}
                    </span>
                    <ChevronDown size={16} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>

                {open && (
                    <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-[2px] border border-slate-500 bg-slate-100 shadow-[4px_5px_0_rgba(15,23,42,0.14)] dark:bg-slate-900">
                        <div className="p-2 border-b dark:border-slate-700">
                            <input
                                autoFocus
                                className="w-full p-2 border rounded-[2px] text-sm dark:bg-slate-900 dark:text-white outline-none"
                                placeholder="Buscar âncora..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                        <div className="max-h-56 overflow-y-auto custom-scrollbar">
                            {anchors.length === 0 ? (
                                <div className="px-3 py-3 text-xs text-slate-400">Nenhuma âncora no fluxo. Passe o mouse no node de destino e clique na âncora à esquerda dele.</div>
                            ) : filtered.length === 0 ? (
                                <div className="px-3 py-3 text-xs text-slate-400">Nenhuma âncora encontrada para "{search}".</div>
                            ) : (
                                filtered.map((name) => (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => choose(name)}
                                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-700 ${name === selected ? 'bg-slate-200 dark:bg-slate-800 text-slate-950 dark:text-white font-semibold' : 'dark:text-slate-200'}`}
                                    >
                                        <span className="inline-flex items-center gap-2 truncate"><Anchor size={13} className="shrink-0 text-slate-400" />{name}</span>
                                        {name === selected && <Check size={14} className="shrink-0" />}
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                )}

                {!selectedExists && (
                    <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                        ⚠ A âncora "{selected}" não existe mais no fluxo. O salto não vai funcionar — selecione uma âncora válida.
                    </p>
                )}
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">O fluxo saltará para o nó "Âncora" selecionado.</p>
            </div>
        </div>
    );
};

const FinalNodeConfig = ({ data, onChange }) => (
    <div className="space-y-4">
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem de Encerramento</label>
            <textarea
                className="w-full mt-1 p-3 border rounded-[2px] h-32 text-sm outline-none dark:bg-slate-700 dark:border-slate-600"
                value={data.text || ''}
                onChange={e => onChange({ text: e.target.value })}
                placeholder="Atendimento finalizado. Obrigado!"
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Mensagem exibida ao cliente quando o fluxo chegar neste nó.
            </p>
        </div>
    </div>
);



const MessageConfig = ({ data, onChange }) => (
    <div>
        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Texto da Mensagem</label>
        <textarea
            className="w-full mt-1 p-3 border rounded-[2px] h-32 text-sm outline-none dark:bg-slate-700 dark:border-slate-600"
            value={data.text || ''}
            onChange={e => onChange({ text: e.target.value })}
            placeholder="Olá! Como posso ajudar?"
        />
    </div>
);

const createSequentialStep = (type = 'message') => {
    const id = `seq_step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (type === 'input') {
        return {
            id,
            type: 'input',
            text: 'Digite uma informacao:',
            variableName: ''
        };
    }
    if (type === 'menu') {
        return {
            id,
            type: 'menu',
            text: 'Selecione uma opcao:',
            options: [
                { id: '1', label: 'Opcao 1', value: '1' },
                { id: '2', label: 'Opcao 2', value: '2' }
            ],
            setVarEnabled: false,
            variableName: '',
            invalidSelectionMessage: 'Selecione uma opcao valida.'
        };
    }
    return {
        id,
        type: 'message',
        text: '...'
    };
};

const STEP_TYPE_META = {
    message: { bg: 'bg-slate-800', border: 'border-l-slate-400', Icon: MessageSquare, label: 'Mensagem' },
    input:   { bg: 'bg-slate-800', border: 'border-l-slate-600', Icon: FormInput, label: 'Input' },
    menu:    { bg: 'bg-slate-800', border: 'border-l-slate-900', Icon: List, label: 'Menu' },
};

const SequentialConfig = ({ data, onChange, vars }) => {
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const [collapsedStepIds, setCollapsedStepIds] = useState({});
    const stepKeys = steps.map((step, index) => step.id || `step_${index}`).join('|');

    useEffect(() => {
        setCollapsedStepIds(prev => {
            const allowed = new Set(steps.map((step, index) => step.id || `step_${index}`));
            const next = {};
            Object.keys(prev).forEach(key => {
                if (allowed.has(key)) next[key] = prev[key];
            });
            return next;
        });
    }, [stepKeys]);

    const patchSteps = (nextSteps) => onChange({ steps: nextSteps });
    const getStepKey = (step, index) => step.id || `step_${index}`;
    const isStepCollapsed = (step, index) => collapsedStepIds[getStepKey(step, index)] === true;
    const toggleStep = (step, index) => {
        const key = getStepKey(step, index);
        setCollapsedStepIds(prev => ({ ...prev, [key]: !prev[key] }));
    };
    const setAllCollapsed = (collapsed) => {
        const next = {};
        steps.forEach((step, index) => {
            next[getStepKey(step, index)] = collapsed;
        });
        setCollapsedStepIds(next);
    };

    const addStep = (type) => {
        patchSteps([...steps, createSequentialStep(type)]);
    };

    const updateStep = (index, patch) => {
        const next = [...steps];
        next[index] = { ...(next[index] || {}), ...patch };
        patchSteps(next);
    };

    const updateStepType = (index, nextType) => {
        const current = steps[index] || {};
        const base = createSequentialStep(nextType);
        updateStep(index, {
            ...base,
            id: current.id || base.id,
            text: current.text || base.text
        });
    };

    const removeStep = (index) => {
        patchSteps(steps.filter((_, idx) => idx !== index));
    };

    const moveStep = (index, direction) => {
        const target = index + direction;
        if (target < 0 || target >= steps.length) return;
        const next = [...steps];
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        patchSteps(next);
    };

    const updateMenuOption = (stepIndex, optionIndex, patch) => {
        const step = steps[stepIndex] || {};
        const options = Array.isArray(step.options) ? [...step.options] : [];
        options[optionIndex] = { ...(options[optionIndex] || {}), ...patch };
        updateStep(stepIndex, { options });
    };

    const addMenuOption = (stepIndex) => {
        const step = steps[stepIndex] || {};
        const options = Array.isArray(step.options) ? [...step.options] : [];
        const nextId = String(options.length + 1);
        options.push({ id: nextId, label: `Opcao ${nextId}`, value: nextId });
        updateStep(stepIndex, { options });
    };

    const removeMenuOption = (stepIndex, optionIndex) => {
        const step = steps[stepIndex] || {};
        const options = Array.isArray(step.options) ? [...step.options] : [];
        options.splice(optionIndex, 1);
        updateStep(stepIndex, { options });
    };

    const counts = steps.reduce((acc, s) => {
        acc[s.type] = (acc[s.type] || 0) + 1;
        return acc;
    }, {});
    const allCollapsed = steps.length > 0 && steps.every((step, index) => isStepCollapsed(step, index));
    const getStepPreview = (step) => {
        const text = String(step.text || '').replace(/\s+/g, ' ').trim();
        if (text) return text.length > 86 ? `${text.slice(0, 86)}...` : text;
        if (step.type === 'input') return step.variableName ? `Salva resposta em ${step.variableName}` : 'Aguardando variavel de resposta.';
        if (step.type === 'menu') {
            const options = Array.isArray(step.options) ? step.options : [];
            return `${options.length} ${options.length === 1 ? 'opcao configurada' : 'opcoes configuradas'}`;
        }
        return 'Sem texto definido.';
    };

    return (
        <div className="space-y-5">
            <div className="rounded-[2px] border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/70">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-bold text-slate-800 dark:text-slate-100">{steps.length} {steps.length === 1 ? 'etapa' : 'etapas'}</span>
                            {counts.message > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-[2px] border border-slate-300 bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                    <MessageSquare size={12} /> {counts.message} {counts.message === 1 ? 'mensagem' : 'mensagens'}
                                </span>
                            )}
                            {counts.input > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-[2px] border border-slate-300 bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                    <FormInput size={12} /> {counts.input} input{counts.input > 1 ? 's' : ''}
                                </span>
                            )}
                            {counts.menu > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-[2px] border border-slate-300 bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                    <List size={12} /> {counts.menu} {counts.menu === 1 ? 'menu' : 'menus'}
                                </span>
                            )}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                            O bot executa as etapas em ordem. Mensagem segue automaticamente; Input e Menu aguardam resposta.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2 md:justify-end">
                        <button
                            type="button"
                            onClick={() => addStep('message')}
                            className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                            <MessageSquare size={13} /> Mensagem
                        </button>
                        <button
                            type="button"
                            onClick={() => addStep('input')}
                            className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                            <FormInput size={13} /> Input
                        </button>
                        <button
                            type="button"
                            onClick={() => addStep('menu')}
                            className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                            <List size={13} /> Menu
                        </button>
                    </div>
                </div>
            </div>

            {steps.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-[2px] border-2 border-dashed border-slate-200 p-8 text-slate-400 dark:border-slate-700">
                    <ListOrdered size={32} className="opacity-40" />
                    <p className="text-xs text-center">Nenhuma etapa adicionada ainda.<br/>Use os botões acima para começar.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Etapas do fluxo</span>
                        <button
                            type="button"
                            onClick={() => setAllCollapsed(!allCollapsed)}
                            className="rounded-[2px] px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                        >
                            {allCollapsed ? 'Expandir todas' : 'Colapsar todas'}
                        </button>
                    </div>
                    {steps.map((step, index) => {
                        const meta = STEP_TYPE_META[step.type] || STEP_TYPE_META.message;
                        const StepIcon = meta.Icon;
                        const badgeLabel = step.stepLabel ? step.stepLabel : `Etapa ${index + 1}`;
                        const collapsed = isStepCollapsed(step, index);
                        const optionsCount = Array.isArray(step.options) ? step.options.length : 0;
                        return (
                            <div key={step.id || index} className={`overflow-hidden rounded-[2px] border border-slate-200 bg-white shadow-sm transition-all duration-200 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/80 dark:hover:border-slate-600`}>
                                <div className={`border-l-4 ${meta.border}`}>
                                    <div className="flex items-start gap-3 p-3">
                                        <button
                                            type="button"
                                            onClick={() => toggleStep(step, index)}
                                            className="mt-0.5 rounded-[2px] p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                                            aria-label={collapsed ? 'Expandir etapa' : 'Colapsar etapa'}
                                        >
                                            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                                        </button>
                                        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] text-white ${meta.bg}`}>
                                            <StepIcon size={15} />
                                        </div>
                                        <button type="button" onClick={() => toggleStep(step, index)} className="min-w-0 flex-1 text-left">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{badgeLabel}</span>
                                                <span className="rounded-[2px] bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                                                    {meta.label}
                                                </span>
                                                {step.type === 'input' && step.variableName && (
                                                    <span className="inline-flex items-center gap-1 rounded-[2px] border border-slate-300 bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                                        {step.variableName}
                                                    </span>
                                                )}
                                                {step.type === 'menu' && (
                                                    <span className="inline-flex items-center gap-1 rounded-[2px] border border-slate-300 bg-slate-200/70 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                                        {optionsCount} opcoes
                                                    </span>
                                                )}
                                            </div>
                                            <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{getStepPreview(step)}</p>
                                        </button>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => moveStep(index, -1)}
                                                className="rounded-[2px] p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                                                disabled={index === 0}
                                                title="Mover para cima"
                                            >
                                                <ChevronUp size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => moveStep(index, 1)}
                                                className="rounded-[2px] p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
                                                disabled={index === steps.length - 1}
                                                title="Mover para baixo"
                                            >
                                                <ChevronDown size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => removeStep(index)}
                                                className="rounded-[2px] p-1.5 text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                                title="Remover etapa"
                                            >
                                                <Trash2 size={15} />
                                            </button>
                                        </div>
                                    </div>

                                    {!collapsed && (
                                        <div className="space-y-4 border-t border-slate-100 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/25">
                                            <div className="grid gap-3 md:grid-cols-[180px,1fr]">
                                                <div>
                                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Tipo</label>
                                                    <select
                                                        className="mt-1 w-full rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                        value={step.type || 'message'}
                                                        onChange={e => updateStepType(index, e.target.value)}
                                                    >
                                                        <option value="message">Mensagem</option>
                                                        <option value="input">Input</option>
                                                        <option value="menu">Menu</option>
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Nome opcional</label>
                                                    <input
                                                        className="mt-1 w-full rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                        placeholder={`Etapa ${index + 1}`}
                                                        value={step.stepLabel || ''}
                                                        onChange={e => updateStep(index, { stepLabel: e.target.value })}
                                                    />
                                                </div>
                                            </div>

                                            <div>
                                                <div className="flex items-center justify-between">
                                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Texto</label>
                                                    <span className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">{step.text?.length || 0} caracteres</span>
                                                </div>
                                                <textarea
                                                    className="mt-1 min-h-[88px] w-full rounded-[2px] border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                    value={step.text || ''}
                                                    onChange={e => updateStep(index, { text: e.target.value })}
                                                    placeholder="Mensagem ou pergunta"
                                                />
                                            </div>

                                            {step.type === 'input' && (
                                                <div>
                                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar em variavel</label>
                                                    <select
                                                        className="mt-1 w-full rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white "
                                                        value={step.variableName || ''}
                                                        onChange={e => updateStep(index, { variableName: e.target.value })}
                                                    >
                                                        <option value="">Selecione...</option>
                                                        {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                                                    </select>
                                                </div>
                                            )}

                                            {step.type === 'menu' && (
                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between">
                                                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Opcoes</label>
                                                        <button type="button" onClick={() => addMenuOption(index)} className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
                                                            <Plus size={12} /> Add opcao
                                                        </button>
                                                    </div>
                                                    <div className="space-y-2">
                                                        {(Array.isArray(step.options) ? step.options : []).map((option, optionIndex) => (
                                                            <div key={`${step.id || index}_${optionIndex}`} className="grid grid-cols-[64px,1fr,1fr,30px] gap-2 items-center">
                                                                <input
                                                                    className="rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                                    value={option.id || ''}
                                                                    onChange={e => updateMenuOption(index, optionIndex, { id: e.target.value })}
                                                                    placeholder="ID"
                                                                />
                                                                <input
                                                                    className="rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                                    value={option.label || ''}
                                                                    onChange={e => updateMenuOption(index, optionIndex, { label: e.target.value })}
                                                                    placeholder="Rotulo"
                                                                />
                                                                <input
                                                                    className="rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                                    value={option.value || ''}
                                                                    onChange={e => updateMenuOption(index, optionIndex, { value: e.target.value })}
                                                                    placeholder="Valor"
                                                                />
                                                                <button type="button" onClick={() => removeMenuOption(index, optionIndex)} className="rounded-[2px] p-1.5 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40">
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                                                        <input
                                                            type="checkbox"
                                                            checked={step.setVarEnabled === true}
                                                            onChange={e => updateStep(index, { setVarEnabled: e.target.checked })}
                                                        />
                                                        Salvar selecao em variavel
                                                    </label>
                                                    {step.setVarEnabled && (
                                                        <select
                                                            className="w-full rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                            value={step.variableName || ''}
                                                            onChange={e => updateStep(index, { variableName: e.target.value })}
                                                        >
                                                            <option value="">Selecione...</option>
                                                            {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                                                        </select>
                                                    )}
                                                    <input
                                                        className="w-full rounded-[2px] border border-slate-200 bg-white p-2 text-xs text-slate-700 outline-none transition focus:border-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                                                        value={step.invalidSelectionMessage || ''}
                                                        onChange={e => updateStep(index, { invalidSelectionMessage: e.target.value })}
                                                        placeholder="Mensagem para opcao invalida"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <InactivityConfig data={data} onChange={onChange} />
        </div>
    );
};

const CommandConfig = ({ data, onChange }) => (
    <div className="space-y-4">
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Comando do usuário</label>
            <input
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="Ex: menu, suporte, /status"
                value={data.command || ''}
                onChange={e => onChange({ command: e.target.value })}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Quando o cliente enviar exatamente este texto, o fluxo saltará para este nó.
            </p>
        </div>
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Descrição opcional</label>
            <input
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="Ex: Atalho para voltar ao menu principal"
                value={data.description || ''}
                onChange={e => onChange({ description: e.target.value })}
            />
        </div>
        <div className="border border-slate-300 bg-slate-200/60 p-3 dark:border-slate-700 dark:bg-slate-800/60">
            <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-300">
                Este nó não espera entrada sequencial. Ele é acionado globalmente quando o comando configurado for enviado.
            </p>
        </div>
    </div>
);

const InactivityConfig = ({ data, onChange }) => (
    <div className="space-y-2">
        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Inatividade (timeout)</label>
        <div className="grid grid-cols-2 gap-2">
            <input
                type="number"
                min="0"
                className="p-2 border rounded-[2px] text-xs dark:bg-slate-800 dark:text-white"
                placeholder="Minutos (0 = desativar)"
                value={data.timeoutMinutes || 0}
                onChange={e => onChange({ timeoutMinutes: Number(e.target.value) || 0 })}
            />
            <input
                type="text"
                className="p-2 border rounded-[2px] text-xs dark:bg-slate-800 dark:text-white"
                placeholder="Mensagem ao expirar (opcional)"
                value={data.timeoutMessage || ''}
                onChange={e => onChange({ timeoutMessage: e.target.value })}
            />
        </div>
        <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
            Se o cliente não responder em X minutos, o fluxo segue automaticamente.
        </p>
    </div>
);

const HolderConfig = ({ data, onChange, vars }) => {
    const variableOptions = (vars || []).map(v => <option key={v.id || v.name} value={v.name}>{v.name}</option>);
    const varInput = (label, field, placeholder) => (
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">{label}</label>
            <select
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                value={data[field] || ''}
                onChange={e => onChange({ [field]: e.target.value })}
            >
                <option value="">{placeholder}</option>
                {variableOptions}
            </select>
        </div>
    );

    return (
        <div className="space-y-4">
            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem inicial opcional</label>
                <textarea
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white h-24"
                    value={data.text || ''}
                    onChange={e => onChange({ text: e.target.value })}
                    placeholder="Ex: Recebido. Se quiser falar com um atendente, digite #humano."
                />
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                    Essa mensagem e enviada uma vez quando o fluxo chega no Holder.
                </p>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                    type="checkbox"
                    checked={data.saveMessages !== false}
                    onChange={e => onChange({ saveMessages: e.target.checked })}
                />
                Salvar mensagens recebidas enquanto estiver segurando
            </label>

            {data.saveMessages !== false && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {varInput('Ultima mensagem', 'lastMessageVar', 'Nao salvar ultima')}
                    {varInput('Lista de mensagens', 'listVar', 'Nao salvar lista')}
                    {varInput('Texto concatenado', 'textVar', 'Nao salvar texto')}
                    {varInput('Quantidade', 'countVar', 'Nao salvar contagem')}
                </div>
            )}

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Fallback para texto comum</label>
                <textarea
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white h-20"
                    value={data.fallbackText || ''}
                    onChange={e => onChange({ fallbackText: e.target.value })}
                    placeholder="Ex: Recebido. Se preferir, digite #humano."
                />
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <input
                        type="checkbox"
                        checked={data.fallbackOnce !== false}
                        onChange={e => onChange({ fallbackOnce: e.target.checked })}
                    />
                    Responder fallback apenas uma vez
                </label>
            </div>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Palavras-chave para sair</label>
                <input
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                    value={data.exitKeywords || ''}
                    onChange={e => onChange({ exitKeywords: e.target.value })}
                    placeholder="Ex: pronto, finalizar, ok"
                />
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                    Se vazio, o Holder nao avanca por texto comum. Comandos globais continuam funcionando.
                </p>
            </div>

            <InactivityConfig data={data} onChange={onChange} />
        </div>
    );
};

const MediaConfig = ({ data, onChange, mediaAssets, onUploadAsset, uploadState }) => (
    <div className="space-y-4">
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Tipo de mídia</label>
            <select
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                value={data.mediaType || 'image'}
                onChange={e => onChange({ mediaType: e.target.value })}
            >
                <option value="image">Imagem</option>
                <option value="video">Vídeo</option>
                <option value="document">Documento</option>
                <option value="audio">Áudio</option>
            </select>
        </div>
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Biblioteca de mídia</label>
            <select
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                value={data.mediaUrl || ''}
                onChange={e => onChange({ mediaUrl: e.target.value })}
            >
                <option value="">Selecionar da biblioteca...</option>
                {(Array.isArray(mediaAssets) ? mediaAssets : []).map((asset) => (
                    <option key={asset.id} value={asset.url}>{asset.originalName || asset.fileName}</option>
                ))}
            </select>
        </div>
        <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <Upload size={14} />
                {uploadState?.loading ? 'Enviando...' : 'Upload de arquivo'}
                <input
                    type="file"
                    className="hidden"
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                    disabled={uploadState?.loading}
                    onChange={(e) => onUploadAsset?.(e.target.files?.[0] || null)}
                />
            </label>
            {uploadState?.error ? <span className="text-[10px] text-red-500">{uploadState.error}</span> : null}
        </div>
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">URL pública do arquivo</label>
            <input
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="https://cdn.exemplo.com/arquivo.pdf"
                value={data.mediaUrl || ''}
                onChange={e => onChange({ mediaUrl: e.target.value })}
            />
        </div>
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Legenda (opcional)</label>
            <textarea
                className="w-full mt-1 p-2 border rounded-[2px] min-h-[88px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="Você pode usar variáveis: {nome_cliente}"
                value={data.caption || ''}
                onChange={e => onChange({ caption: e.target.value })}
            />
        </div>
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Nome do arquivo (opcional)</label>
            <input
                className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                placeholder="ex: proposta_comercial.pdf"
                value={data.fileName || ''}
                onChange={e => onChange({ fileName: e.target.value })}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Usado principalmente para documentos no WhatsApp.
            </p>
        </div>
    </div>
);

const CatalogConfig = ({ data, onChange, catalogItems }) => {
    const sourceType = data.sourceType || 'catalog';
    const manualItems = Array.isArray(data.items) ? data.items : [];
    const selectedIds = Array.isArray(data.itemIds) ? data.itemIds : [];

    const toggleCatalogItem = (id) => {
        const stringId = String(id);
        const next = selectedIds.includes(stringId)
            ? selectedIds.filter((itemId) => itemId !== stringId)
            : [...selectedIds, stringId];
        onChange({ itemIds: next });
    };

    const updateManualItem = (index, field, value) => {
        const next = [...manualItems];
        next[index] = { ...next[index], [field]: value };
        onChange({ items: next });
    };

    const addManualItem = () => {
        onChange({
            items: [...manualItems, { id: `manual_${Date.now()}`, name: '', price: '', description: '', category: '', sku: '', mediaUrl: '' }]
        });
    };

    const removeManualItem = (index) => {
        onChange({ items: manualItems.filter((_, idx) => idx !== index) });
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Fonte dos itens</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={sourceType}
                        onChange={e => onChange({ sourceType: e.target.value })}
                    >
                        <option value="catalog">Catálogo</option>
                        <option value="manual">Manual</option>
                    </select>
                </div>
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Limite</label>
                    <input
                        type="number"
                        min={1}
                        max={20}
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.limit || 5}
                        onChange={e => onChange({ limit: Number(e.target.value) || 5 })}
                    />
                </div>
            </div>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem inicial</label>
                <textarea
                    className="w-full mt-1 p-2 border rounded-[2px] min-h-[80px] text-sm dark:bg-slate-700 dark:text-white"
                    value={data.title || data.message || ''}
                    onChange={e => onChange({ title: e.target.value, message: e.target.value })}
                    placeholder="Selecione um item:"
                />
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Categoria (opcional)</label>
                    <input
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.category || ''}
                        onChange={e => onChange({ category: e.target.value })}
                        placeholder="Ex: eletrônicos"
                    />
                </div>
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Prefixo das variáveis</label>
                    <input
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.varPrefix || 'PRODUTO'}
                        onChange={e => onChange({ varPrefix: e.target.value })}
                        placeholder="PRODUTO"
                    />
                    <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Ex: PRODUTO_ID, PRODUTO_NOME, PRODUTO_PRECO.</p>
                </div>
            </div>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem para seleção inválida</label>
                <input
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                    value={data.invalidSelectionMessage || ''}
                    onChange={e => onChange({ invalidSelectionMessage: e.target.value })}
                    placeholder="Selecione um item válido da lista."
                />
            </div>

            <div>
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                        type="checkbox"
                        checked={data.showButtons !== false}
                        onChange={e => onChange({ showButtons: e.target.checked })}
                    />
                    Mostrar botoes para selecao
                </label>
            </div>

            <div>
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                        type="checkbox"
                        checked={data.includeInactive === true}
                        onChange={e => onChange({ includeInactive: e.target.checked })}
                    />
                    Incluir itens inativos do catálogo
                </label>
            </div>

            {sourceType === 'catalog' ? (
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Itens específicos (opcional)</label>
                        <span className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">{catalogItems.length} item(ns) disponíveis</span>
                    </div>
                    <div className="max-h-48 overflow-y-auto border rounded-[2px] p-2 space-y-1 dark:border-slate-600">
                        {catalogItems.length === 0 ? (
                            <p className="text-xs text-slate-400 p-2">Nenhum item cadastrado no catálogo.</p>
                        ) : (
                            catalogItems.map((item) => (
                                <label key={item.id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.includes(String(item.id))}
                                        onChange={() => toggleCatalogItem(item.id)}
                                    />
                                    <span className="truncate">{item.name}</span>
                                </label>
                            ))
                        )}
                    </div>
                    <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                        Se nada for marcado, o nó usa todos os itens conforme categoria/limite.
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Itens manuais</label>
                        <button onClick={addManualItem} className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
                            <Plus size={14} /> Add item
                        </button>
                    </div>
                    {manualItems.length === 0 ? (
                        <p className="text-xs text-slate-400 p-2 border rounded-[2px]">Nenhum item manual adicionado.</p>
                    ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                            {manualItems.map((item, index) => (
                                <div key={item.id || index} className="border rounded-[2px] p-2 space-y-2 dark:border-slate-600">
                                    <div className="grid grid-cols-2 gap-2">
                                        <input
                                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                            placeholder="Nome"
                                            value={item.name || ''}
                                            onChange={e => updateManualItem(index, 'name', e.target.value)}
                                        />
                                        <input
                                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                            placeholder="Preço"
                                            value={item.price || ''}
                                            onChange={e => updateManualItem(index, 'price', e.target.value)}
                                        />
                                    </div>
                                    <input
                                        className="w-full p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                        placeholder="Descrição"
                                        value={item.description || ''}
                                        onChange={e => updateManualItem(index, 'description', e.target.value)}
                                    />
                                    <div className="grid grid-cols-2 gap-2">
                                        <input
                                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                            placeholder="Categoria"
                                            value={item.category || ''}
                                            onChange={e => updateManualItem(index, 'category', e.target.value)}
                                        />
                                        <input
                                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                            placeholder="SKU"
                                            value={item.sku || ''}
                                            onChange={e => updateManualItem(index, 'sku', e.target.value)}
                                        />
                                    </div>
                                    <input
                                        className="w-full p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                                        placeholder="URL mídia (opcional)"
                                        value={item.mediaUrl || ''}
                                        onChange={e => updateManualItem(index, 'mediaUrl', e.target.value)}
                                    />
                                    <div className="flex justify-end">
                                        <button onClick={() => removeManualItem(index)} className="text-xs text-red-600 flex items-center gap-1">
                                            <Trash2 size={12} /> Remover
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const TEMPLATE_TOKEN_REGEX = /\{\{\s*[^{}]+\s*\}\}/g;
const countTemplateTokens = (value) => (String(value || '').match(TEMPLATE_TOKEN_REGEX) || []).length;

const describeWhatsAppTemplateInputs = (template) => {
    const components = Array.isArray(template?.components) ? template.components : [];
    const header = components.find((component) => String(component?.type || '').toUpperCase() === 'HEADER') || null;
    const body = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY') || null;
    const buttons = Array.isArray(template?.buttons) ? template.buttons : [];
    const headerFormat = String(header?.format || '').toUpperCase();
    return {
        header: {
            format: headerFormat || null,
            text: String(header?.text || ''),
            placeholderCount: countTemplateTokens(header?.text || ''),
            requiresMedia: ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat)
        },
        body: {
            text: String(body?.text || ''),
            placeholderCount: countTemplateTokens(body?.text || '')
        },
        buttons: buttons.map((button) => ({
            index: String(button.index),
            text: String(button.text || ''),
            type: String(button.type || 'UNKNOWN').toUpperCase(),
            placeholderCount: countTemplateTokens(button.url || button.text || '')
        })).filter((button) => button.placeholderCount > 0)
    };
};

const normalizeTemplateMapping = (mapping) => ({
    mode: mapping?.mode === 'variable' ? 'variable' : 'fixed',
    value: String(mapping?.value || '')
});

const buildTemplateMappingArray = (count) => Array.from({ length: count }, () => ({ mode: 'fixed', value: '' }));

const buildWhatsAppTemplateDefaults = (template) => {
    const inputDef = describeWhatsAppTemplateInputs(template);
    return {
        headerMappings: buildTemplateMappingArray(inputDef.header.placeholderCount),
        bodyMappings: buildTemplateMappingArray(inputDef.body.placeholderCount),
        buttonMappings: inputDef.buttons.reduce((acc, button) => ({
            ...acc,
            [button.index]: buildTemplateMappingArray(button.placeholderCount)
        }), {}),
        headerMediaMapping: { mode: 'fixed', value: '' }
    };
};

const replacePreviewTokens = (text, mappings = []) => {
    let cursor = 0;
    return String(text || '').replace(TEMPLATE_TOKEN_REGEX, () => {
        const mapping = normalizeTemplateMapping(mappings[cursor]);
        cursor += 1;
        if (!mapping.value) return '{{...}}';
        return mapping.mode === 'variable' ? `{${mapping.value}}` : mapping.value;
    });
};

const normalizeInteractiveTemplate = (template) => {
    if (!template) return null;
    return {
        id: template.id || '',
        name: template.name || '',
        kind: template.kind === 'button' ? 'button' : template.kind === 'product' ? 'product' : template.kind === 'product_list' ? 'product_list' : 'list',
        headerText: template.headerText || '',
        bodyText: template.bodyText || '',
        footerText: template.footerText || '',
        actionTitle: template.actionTitle || 'Ver opcoes',
        sections: Array.isArray(template.sections) ? template.sections : [],
        buttons: Array.isArray(template.buttons) ? template.buttons : [],
        catalogId: template.catalogId || '',
        productRetailerId: template.productRetailerId || '',
        productSections: Array.isArray(template.productSections) ? template.productSections : []
    };
};

const getInteractiveKindLabel = (kind) => {
    if (kind === 'button') return 'Reply buttons';
    if (kind === 'product') return 'Single product';
    if (kind === 'product_list') return 'Multi product';
    return 'Interactive list';
};

const parseInternalPrice = (row = {}) => {
    const hasExplicitPrice = row.unitPrice !== '' && row.unitPrice !== null && row.unitPrice !== undefined;
    const explicit = Number(row.unitPrice);
    if (hasExplicitPrice && Number.isFinite(explicit) && explicit >= 0) return explicit;
    const source = `${row.description || ''} ${row.title || ''}`;
    const match = source.match(/R\$\s*([0-9.]+(?:,[0-9]{1,2})?)/i);
    if (!match) return '';
    const parsed = Number(match[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : '';
};

const CartNodeConfig = ({ data, onChange, vars, whatsappInteractiveTemplates }) => {
    const priceMap = Array.isArray(data.priceMap) ? data.priceMap : [];
    const [sourceTemplateId, setSourceTemplateId] = useState(data.priceMapTemplateId || '');
    const variableNames = Array.from(new Set([
        ...(Array.isArray(vars) ? vars.map((item) => item?.name).filter(Boolean) : []),
        'PEDIDO_ID', 'PEDIDO', 'QUANTIDADE', 'PRODUTO_PRECO',
        'CARRINHO_ITENS', 'CARRINHO_TOTAL', 'CARRINHO_QUANTIDADE',
        'CARRINHO_RESUMO', 'CARRINHO_OK', 'CARRINHO_ERRO'
    ])).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const updatePrice = (index, patch) => {
        const next = priceMap.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry);
        onChange({ priceMap: next });
    };

    const removePrice = (index) => onChange({ priceMap: priceMap.filter((_, entryIndex) => entryIndex !== index) });
    const addPrice = () => onChange({
        priceMap: [...priceMap, { id: '', name: '', sku: '', unitPrice: '' }]
    });

    const importTemplate = () => {
        const template = (Array.isArray(whatsappInteractiveTemplates) ? whatsappInteractiveTemplates : [])
            .find((item) => String(item?.id) === String(sourceTemplateId));
        if (!template) return;
        const imported = (Array.isArray(template.sections) ? template.sections : [])
            .flatMap((section) => Array.isArray(section?.rows) ? section.rows : [])
            .map((row) => ({
                id: String(row?.id || '').trim(),
                name: String(row?.title || '').trim(),
                sku: String(row?.sku || '').trim(),
                unitPrice: parseInternalPrice(row)
            }))
            .filter((entry) => entry.id || entry.name);
        onChange({ priceMap: imported, priceMapTemplateId: sourceTemplateId });
    };

    const VariableField = ({ label, field, fallback }) => (
        <div>
            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">{label}</label>
            <input
                list="cart-node-vars"
                className="mt-1 w-full border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                value={data[field] || fallback}
                onChange={(event) => onChange({ [field]: event.target.value })}
            />
        </div>
    );

    return (
        <div className="space-y-5">
            <datalist id="cart-node-vars">
                {variableNames.map((name) => <option key={name} value={name} />)}
            </datalist>

            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Operacao</label>
                <select
                    className="mt-1 w-full border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                    value={data.operation || 'add'}
                    onChange={(event) => onChange({ operation: event.target.value })}
                >
                    <option value="add">Adicionar item ao carrinho</option>
                    <option value="clear">Limpar carrinho</option>
                </select>
            </div>

            {(data.operation || 'add') === 'add' && (
                <>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <VariableField label="ID / payload do produto" field="productIdVar" fallback="PEDIDO_ID" />
                        <VariableField label="Nome do produto" field="productNameVar" fallback="PEDIDO" />
                        <VariableField label="Quantidade" field="quantityVar" fallback="QUANTIDADE" />
                    </div>

                    <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Origem do preco</label>
                        <select
                            className="mt-1 w-full border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                            value={data.priceSource || 'map'}
                            onChange={(event) => onChange({ priceSource: event.target.value })}
                        >
                            <option value="map">Mapa de precos deste node</option>
                            <option value="variable">Variavel do fluxo</option>
                        </select>
                    </div>

                    {(data.priceSource || 'map') === 'variable' ? (
                        <VariableField label="Variavel com preco unitario" field="unitPriceVar" fallback="PRODUTO_PRECO" />
                    ) : (
                        <div className="space-y-3 border border-slate-200 p-3 dark:border-slate-700">
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <select
                                    className="min-w-0 flex-1 border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                                    value={sourceTemplateId}
                                    onChange={(event) => setSourceTemplateId(event.target.value)}
                                >
                                    <option value="">Importar itens de um WTN interactive...</option>
                                    {(Array.isArray(whatsappInteractiveTemplates) ? whatsappInteractiveTemplates : [])
                                        .filter((item) => item?.kind === 'list')
                                        .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                </select>
                                <button
                                    type="button"
                                    onClick={importTemplate}
                                    disabled={!sourceTemplateId}
                                    className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800 justify-center disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <Download size={14} /> Importar
                                </button>
                            </div>
                            <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">O ID da linha vira a chave do produto. O preco interno e usado primeiro; se estiver vazio, o sistema tenta ler um valor como R$ 10 na descricao.</p>

                            <div className="space-y-2">
                                {priceMap.map((entry, index) => (
                                    <div key={`${entry.id || 'price'}_${index}`} className="grid gap-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0 dark:border-slate-700 sm:grid-cols-[1.1fr_1.2fr_0.8fr_0.7fr_auto]">
                                        <input className="border border-slate-200 px-2 py-2 text-xs dark:border-slate-600 dark:bg-slate-800" placeholder="Payload ID" value={entry.id || ''} onChange={(event) => updatePrice(index, { id: event.target.value })} />
                                        <input className="border border-slate-200 px-2 py-2 text-xs dark:border-slate-600 dark:bg-slate-800" placeholder="Nome" value={entry.name || ''} onChange={(event) => updatePrice(index, { name: event.target.value })} />
                                        <input className="border border-slate-200 px-2 py-2 text-xs dark:border-slate-600 dark:bg-slate-800" placeholder="SKU" value={entry.sku || ''} onChange={(event) => updatePrice(index, { sku: event.target.value })} />
                                        <input type="number" min="0" step="0.01" className="border border-slate-200 px-2 py-2 text-xs dark:border-slate-600 dark:bg-slate-800" placeholder="Preco" value={entry.unitPrice ?? ''} onChange={(event) => updatePrice(index, { unitPrice: event.target.value })} />
                                        <button type="button" onClick={() => removePrice(index)} className="p-2 text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                                    </div>
                                ))}
                                <button type="button" onClick={addPrice} className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"><Plus size={14} /> Adicionar preco</button>
                            </div>
                        </div>
                    )}

                    <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                        <input type="checkbox" checked={data.mergeDuplicates !== false} onChange={(event) => onChange({ mergeDuplicates: event.target.checked })} />
                        Somar quantidade quando o produto ja estiver no carrinho
                    </label>
                </>
            )}

            <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Variaveis de saida</div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <VariableField label="Itens" field="itemsVar" fallback="CARRINHO_ITENS" />
                    <VariableField label="Total" field="totalVar" fallback="CARRINHO_TOTAL" />
                    <VariableField label="Quantidade total" field="itemCountVar" fallback="CARRINHO_QUANTIDADE" />
                    <VariableField label="Resumo formatado" field="summaryVar" fallback="CARRINHO_RESUMO" />
                    <VariableField label="Operacao valida" field="okVar" fallback="CARRINHO_OK" />
                    <VariableField label="Mensagem de erro" field="errorVar" fallback="CARRINHO_ERRO" />
                </div>
            </div>
        </div>
    );
};

const WhatsAppTemplateNodeConfig = ({
    data,
    onChange,
    vars,
    whatsappTemplates,
    whatsappInteractiveTemplates,
    whatsappSenderOptions,
    whatsappChannelReady,
    whatsappDataLoading,
    whatsappDataError
}) => {
    const approvedTemplates = (Array.isArray(whatsappTemplates) ? whatsappTemplates : []).filter((template) => {
        const status = String(template?.status || '').toUpperCase();
        return status === 'APPROVED' || status === 'ACTIVE';
    });
    const interactiveTemplates = Array.isArray(whatsappInteractiveTemplates) ? whatsappInteractiveTemplates : [];
    const contentKind = data.contentKind === 'interactive' ? 'interactive' : 'template';
    const selectedTemplate = contentKind === 'template'
        ? approvedTemplates.find((template) => String(template.id) === String(data.whatsappTemplateId || '')) || null
        : null;
    const selectedInteractive = contentKind === 'interactive'
        ? normalizeInteractiveTemplate(interactiveTemplates.find((template) => String(template.id) === String(data.interactiveTemplateId || '')) || null)
        : null;
    const inputDef = describeWhatsAppTemplateInputs(selectedTemplate);
    const senderOptions = Array.isArray(whatsappSenderOptions) ? whatsappSenderOptions : [];
    const selectedTemplateStructureKey = selectedTemplate
        ? JSON.stringify({
            id: selectedTemplate.id,
            headerFormat: inputDef.header.format,
            headerInputs: inputDef.header.placeholderCount,
            bodyInputs: inputDef.body.placeholderCount,
            buttons: inputDef.buttons.map((button) => ({
                index: button.index,
                inputs: button.placeholderCount
            }))
        })
        : '';

    const ensureTemplateStructure = () => {
        if (!selectedTemplate || contentKind !== 'template') return;
        const defaults = buildWhatsAppTemplateDefaults(selectedTemplate);
        const nextHeader = Array.from({ length: defaults.headerMappings.length }, (_, index) => normalizeTemplateMapping((data.headerMappings || [])[index]));
        const nextBody = Array.from({ length: defaults.bodyMappings.length }, (_, index) => normalizeTemplateMapping((data.bodyMappings || [])[index]));
        const nextButtons = Object.fromEntries(Object.entries(defaults.buttonMappings).map(([buttonIndex, arr]) => [
            buttonIndex,
            Array.from({ length: arr.length }, (_, index) => normalizeTemplateMapping(data.buttonMappings?.[buttonIndex]?.[index]))
        ]));
        const nextStructure = {
            headerMappings: nextHeader,
            bodyMappings: nextBody,
            buttonMappings: nextButtons,
            headerMediaMapping: normalizeTemplateMapping(data.headerMediaMapping)
        };
        const currentStructure = {
            headerMappings: Array.isArray(data.headerMappings) ? data.headerMappings.map(normalizeTemplateMapping) : [],
            bodyMappings: Array.isArray(data.bodyMappings) ? data.bodyMappings.map(normalizeTemplateMapping) : [],
            buttonMappings: Object.fromEntries(Object.entries(data.buttonMappings || {}).map(([buttonIndex, mappings]) => [
                buttonIndex,
                Array.isArray(mappings) ? mappings.map(normalizeTemplateMapping) : []
            ])),
            headerMediaMapping: normalizeTemplateMapping(data.headerMediaMapping)
        };

        // O catálogo pode chegar depois que o inspetor já foi aberto. Só atualiza
        // a estrutura quando ela realmente mudou, preservando o que foi digitado.
        if (JSON.stringify(currentStructure) !== JSON.stringify(nextStructure)) {
            onChange(nextStructure);
        }
    };

    useEffect(() => {
        ensureTemplateStructure();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data.whatsappTemplateId, data.contentKind, selectedTemplateStructureKey]);

    const handleTemplateChange = (templateId) => {
        const nextTemplate = approvedTemplates.find((template) => String(template.id) === String(templateId)) || null;
        const defaults = nextTemplate ? buildWhatsAppTemplateDefaults(nextTemplate) : {
            headerMappings: [],
            bodyMappings: [],
            buttonMappings: {},
            headerMediaMapping: { mode: 'fixed', value: '' }
        };
        onChange({
            whatsappTemplateId: templateId,
            subLabel: nextTemplate ? `Meta: ${nextTemplate.name}` : 'WTN',
            ...defaults
        });
    };

    const handleContentKindChange = (nextKind) => {
        onChange({
            contentKind: nextKind,
            subLabel: nextKind === 'interactive'
                ? (selectedInteractive?.name ? `Interactive: ${selectedInteractive.name}` : 'WTN Interactive')
                : (selectedTemplate?.name ? `Meta: ${selectedTemplate.name}` : 'WTN')
        });
    };

    const handleInteractiveChange = (interactiveTemplateId) => {
        const nextInteractive = normalizeInteractiveTemplate(
            interactiveTemplates.find((template) => String(template.id) === String(interactiveTemplateId)) || null
        );
        onChange({
            interactiveTemplateId,
            subLabel: nextInteractive?.name ? `Interactive: ${nextInteractive.name}` : 'WTN Interactive'
        });
    };

    const updateArrayMapping = (field, index, patch) => {
        const source = Array.isArray(data?.[field]) ? [...data[field]] : [];
        source[index] = { ...normalizeTemplateMapping(source[index]), ...patch };
        onChange({ [field]: source });
    };

    const updateButtonMapping = (buttonIndex, valueIndex, patch) => {
        const buttonMappings = { ...(data.buttonMappings || {}) };
        const source = Array.isArray(buttonMappings[buttonIndex]) ? [...buttonMappings[buttonIndex]] : [];
        source[valueIndex] = { ...normalizeTemplateMapping(source[valueIndex]), ...patch };
        buttonMappings[buttonIndex] = source;
        onChange({ buttonMappings });
    };

    const renderMappingField = (label, mapping, onUpdate) => {
        const normalized = normalizeTemplateMapping(mapping);
        return (
            <div className="grid grid-cols-1 md:grid-cols-[120px,1fr] gap-2 items-start">
                <label className="text-xs font-bold text-slate-500 uppercase pt-2">{label}</label>
                <div className="grid grid-cols-1 sm:grid-cols-[120px,1fr] gap-2">
                    <select
                        className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={normalized.mode}
                        onChange={e => onUpdate({ mode: e.target.value, value: '' })}
                    >
                        <option value="fixed">Fixo</option>
                        <option value="variable">Variavel</option>
                    </select>
                    {normalized.mode === 'variable' ? (
                        <select
                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                            value={normalized.value}
                            onChange={e => onUpdate({ value: e.target.value })}
                        >
                            <option value="">Selecione a variavel...</option>
                            {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                        </select>
                    ) : (
                        <input
                            className="p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                            value={normalized.value}
                            onChange={e => onUpdate({ value: e.target.value })}
                            placeholder="Valor fixo"
                        />
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-5">
            {whatsappDataLoading && (
                <div className="border border-slate-400 bg-slate-200 p-3 font-mono text-[10px] font-bold uppercase tracking-wide text-slate-700">
                    Carregando catálogo e configuração do WhatsApp...
                </div>
            )}

            {whatsappDataError && (
                <div className="border border-red-500 bg-red-50 p-3 font-mono text-[10px] text-red-800 dark:bg-red-950/30 dark:text-red-200">
                    {whatsappDataError}
                </div>
            )}

            {!whatsappChannelReady && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-[2px] text-xs text-amber-700 dark:text-amber-300">
                    Configure o canal WhatsApp com token, WABA e numero antes de usar o WTN.
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Modo do WTN</label>
                    <div className="mt-1 grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => handleContentKindChange('template')}
                            className={`h-9 rounded-[2px] border px-3 font-mono text-[10px] font-bold uppercase transition-colors ${contentKind === 'template' ? 'bg-slate-950 text-white border-slate-950 dark:bg-slate-100 dark:text-slate-950 dark:border-slate-100' : 'border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                        >
                            Templates
                        </button>
                        <button
                            type="button"
                            onClick={() => handleContentKindChange('interactive')}
                            className={`h-9 rounded-[2px] border px-3 font-mono text-[10px] font-bold uppercase transition-colors ${contentKind === 'interactive' ? 'bg-slate-950 text-white border-slate-950 dark:bg-slate-100 dark:text-slate-950 dark:border-slate-100' : 'border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                        >
                            Interativo
                        </button>
                    </div>
                </div>
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Numero remetente</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.senderPhoneNumberId || ''}
                        onChange={e => onChange({ senderPhoneNumberId: e.target.value })}
                    >
                        <option value="">Padrao do canal</option>
                        {senderOptions.map((sender) => (
                            <option key={sender.id || sender.phoneNumberId} value={sender.phoneNumberId}>
                                {[sender.label, sender.displayNumber, sender.phoneNumberId].filter(Boolean).join(' - ')}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {contentKind === 'template' ? (
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Template Meta aprovado</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.whatsappTemplateId || ''}
                        onChange={e => handleTemplateChange(e.target.value)}
                    >
                        <option value="">Selecione um template...</option>
                        {approvedTemplates.map((template) => (
                            <option key={template.id} value={template.id}>
                                {template.name} - {template.language}
                            </option>
                        ))}
                    </select>
                </div>
            ) : (
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Interactive WhatsApp</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.interactiveTemplateId || ''}
                        onChange={e => handleInteractiveChange(e.target.value)}
                    >
                        <option value="">Selecione uma interactive...</option>
                        {interactiveTemplates.map((template) => (
                            <option key={template.id} value={template.id}>
                                {template.name} - {getInteractiveKindLabel(template.kind)}
                            </option>
                        ))}
                    </select>
                    <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                        Use o catalogo da tela de Templates para montar as interactive messages reutilizaveis.
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                        type="checkbox"
                        checked={data.waitForReply !== false}
                        onChange={e => onChange({ waitForReply: e.target.checked })}
                    />
                    Esperar resposta do cliente antes de seguir
                </label>
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Se o canal nao for WhatsApp</label>
                    <select
                        className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.nonWhatsappAction || 'skip'}
                        onChange={e => onChange({ nonWhatsappAction: e.target.value })}
                    >
                        <option value="skip">Pular para o proximo no</option>
                        <option value="sendFallback">Enviar texto alternativo</option>
                    </select>
                </div>
            </div>

            {data.nonWhatsappAction === 'sendFallback' && (
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Texto alternativo</label>
                    <textarea
                        className="w-full mt-1 p-2 border rounded-[2px] min-h-[80px] text-sm dark:bg-slate-700 dark:text-white"
                        value={data.fallbackText || ''}
                        onChange={e => onChange({ fallbackText: e.target.value })}
                        placeholder="Mensagem para canais que nao sao WhatsApp"
                    />
                </div>
            )}

            {contentKind === 'template' && selectedTemplate && (
                <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-white">Parametros do template</div>
                    {inputDef.header.requiresMedia && renderMappingField('Header midia', data.headerMediaMapping, (patch) => onChange({ headerMediaMapping: { ...normalizeTemplateMapping(data.headerMediaMapping), ...patch } }))}
                    {Array.from({ length: inputDef.header.placeholderCount }).map((_, index) => renderMappingField(`Header ${index + 1}`, data.headerMappings?.[index], (patch) => updateArrayMapping('headerMappings', index, patch)))}
                    {Array.from({ length: inputDef.body.placeholderCount }).map((_, index) => renderMappingField(`Body ${index + 1}`, data.bodyMappings?.[index], (patch) => updateArrayMapping('bodyMappings', index, patch)))}
                    {inputDef.buttons.map((button) => (
                        <div key={`btn_map_${button.index}`} className="rounded-[2px] border border-slate-100 dark:border-slate-700 p-3 space-y-2">
                            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Botao {Number(button.index) + 1}: {button.text || button.type}</div>
                            {Array.from({ length: button.placeholderCount }).map((_, valueIndex) => (
                                <div key={`btn_map_${button.index}_${valueIndex}`}>
                                    {renderMappingField(
                                        `Parametro ${valueIndex + 1}`,
                                        data.buttonMappings?.[button.index]?.[valueIndex],
                                        (patch) => updateButtonMapping(button.index, valueIndex, patch)
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            )}

            {((contentKind === 'template' && selectedTemplate) || (contentKind === 'interactive' && selectedInteractive)) && (
                <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-white">Captura da resposta</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar texto da resposta</label>
                            <select className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white" value={data.saveResponseTextVar || ''} onChange={e => onChange({ saveResponseTextVar: e.target.value })}>
                                <option value="">Nao salvar</option>
                                {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar payload</label>
                            <select className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white" value={data.saveResponsePayloadVar || ''} onChange={e => onChange({ saveResponsePayloadVar: e.target.value })}>
                                <option value="">Nao salvar</option>
                                {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar texto do botao</label>
                            <select className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white" value={data.saveButtonTextVar || ''} onChange={e => onChange({ saveButtonTextVar: e.target.value })}>
                                <option value="">Nao salvar</option>
                                {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                        Globais preenchidas pelo WTN: <code>ULTIMA_RESPOSTA_CLIENTE</code>, <code>WTN_BOTAO_TEXTO</code> e <code>WTN_BOTAO_PAYLOAD</code>.
                    </p>
                    {contentKind === 'interactive' && (selectedInteractive?.kind === 'product' || selectedInteractive?.kind === 'product_list') && (
                        <p className="text-[10px] text-amber-600 dark:text-amber-300">
                            Dica: em <code>{selectedInteractive?.kind === 'product_list' ? 'Multi product' : 'Single product'}</code>, normalmente faz mais sentido desativar "Esperar resposta do cliente" se o objetivo for apenas vitrine.
                        </p>
                    )}
                </div>
            )}

            {contentKind === 'interactive' && selectedInteractive && (
                <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-white">Como usar variaveis</div>
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                        Nas interactive messages, use variaveis direto no texto com o formato <code>{'{NOME_VARIAVEL}'}</code>.
                        Isso vale para header, body, footer, titulo do botao, secoes, linhas, ids estaveis, <code>catalogId</code>, <code>productRetailerId</code> e produtos do multi product.
                    </p>
                    <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                        Para ramificar depois da resposta, prefira comparar <code>WTN_BOTAO_PAYLOAD</code> com o ID do botao ou da linha.
                    </p>
                </div>
            )}

            {contentKind === 'template' && selectedTemplate && (
                <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 p-4 space-y-3 bg-slate-50 dark:bg-slate-900/30">
                    <div className="text-sm font-semibold text-slate-800 dark:text-white">Preview</div>
                    {inputDef.header.text && (
                        <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-3 text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
                            {replacePreviewTokens(inputDef.header.text, data.headerMappings || [])}
                        </div>
                    )}
                    {inputDef.header.requiresMedia && (data.headerMediaMapping?.value || '') && (
                        <div className="rounded-[2px] border border-dashed border-slate-300 dark:border-slate-600 px-3 py-3 text-xs text-slate-500 dark:text-slate-400 break-all">
                            Midia do header: {normalizeTemplateMapping(data.headerMediaMapping).mode === 'variable' ? `{${normalizeTemplateMapping(data.headerMediaMapping).value}}` : normalizeTemplateMapping(data.headerMediaMapping).value}
                        </div>
                    )}
                    <div className="rounded-[2px] rounded-tl-sm bg-emerald-600 text-white px-4 py-3 text-sm whitespace-pre-wrap break-words shadow-sm">
                        {replacePreviewTokens(inputDef.body.text || 'Corpo do template', data.bodyMappings || [])}
                    </div>
                    {Array.isArray(selectedTemplate.buttons) && selectedTemplate.buttons.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {selectedTemplate.buttons.map((button) => (
                                <span key={`preview_btn_${button.index}`} className="px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
                                    {button.text || button.type}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {contentKind === 'interactive' && selectedInteractive && (
                <div className="rounded-[2px] border border-slate-200 dark:border-slate-700 p-4 space-y-3 bg-slate-50 dark:bg-slate-900/30">
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-800 dark:text-white">Preview</div>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-[2px] border border-slate-300 bg-slate-200/70 font-mono text-[10px] font-bold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200`}>
                            {getInteractiveKindLabel(selectedInteractive.kind)}
                        </span>
                    </div>

                    <div className="max-w-md rounded-3xl rounded-tl-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
                        {selectedInteractive.headerText && selectedInteractive.kind !== 'product' && (
                            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-100 whitespace-pre-wrap break-words">
                                {selectedInteractive.headerText}
                            </div>
                        )}
                        <div className="px-4 py-4 space-y-3">
                            <p className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">
                                {selectedInteractive.bodyText || 'Corpo da mensagem interativa'}
                            </p>
                            {selectedInteractive.footerText && (
                                <p className="text-xs text-slate-400 dark:text-slate-500 whitespace-pre-wrap break-words">
                                    {selectedInteractive.footerText}
                                </p>
                            )}
                        </div>

                        <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                            {selectedInteractive.kind === 'list' ? (
                                <>
                                    <div className="px-4 py-3 text-center text-sm font-semibold text-blue-600 dark:text-blue-400 border-b border-slate-200 dark:border-slate-700">
                                        {selectedInteractive.actionTitle || 'Ver opcoes'}
                                    </div>
                                    <div className="p-4 space-y-3">
                                        {selectedInteractive.sections.map((section, sectionIndex) => (
                                            <div key={`wtn_int_section_${sectionIndex}`} className="rounded-[2px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-2">
                                                {section.title && (
                                                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                                                        {section.title}
                                                    </div>
                                                )}
                                                {(Array.isArray(section.rows) ? section.rows : []).map((row, rowIndex) => (
                                                    <div key={`wtn_int_row_${sectionIndex}_${row.id || rowIndex}`} className="rounded-[2px] bg-slate-50 dark:bg-slate-800 px-3 py-2">
                                                        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                                                            {row.title || 'Linha sem titulo'}
                                                        </div>
                                                        {row.description && (
                                                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                                                {row.description}
                                                            </div>
                                                        )}
                                                        <div className="text-[10px] text-slate-400 mt-2 font-mono break-all">
                                                            payload: {row.id || 'sem_id'}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : selectedInteractive.kind === 'product' ? (
                                <div className="p-4">
                                    <div className="rounded-[2px] border border-amber-200 dark:border-amber-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                                        <div className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                            Single product
                                        </div>
                                        <div className="grid grid-cols-1 gap-2 text-xs">
                                            <div className="rounded-[2px] bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                                                <div className="font-semibold text-amber-700 dark:text-amber-300">catalogId</div>
                                                <div className="mt-1 font-mono break-all text-amber-900 dark:text-amber-100">{selectedInteractive.catalogId || 'nao definido'}</div>
                                            </div>
                                            <div className="rounded-[2px] bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                                                <div className="font-semibold text-amber-700 dark:text-amber-300">productRetailerId</div>
                                                <div className="mt-1 font-mono break-all text-amber-900 dark:text-amber-100">{selectedInteractive.productRetailerId || 'nao definido'}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : selectedInteractive.kind === 'product_list' ? (
                                <div className="p-4 space-y-3">
                                    <div className="rounded-[2px] border border-amber-200 dark:border-amber-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                                        <div className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                            Multi product
                                        </div>
                                        <div className="rounded-[2px] bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                                            <div className="font-semibold text-amber-700 dark:text-amber-300">catalogId</div>
                                            <div className="mt-1 font-mono break-all text-amber-900 dark:text-amber-100">{selectedInteractive.catalogId || 'nao definido'}</div>
                                        </div>
                                        {(Array.isArray(selectedInteractive.productSections) ? selectedInteractive.productSections : []).map((section, sectionIndex) => (
                                            <div key={`wtn_int_product_section_${sectionIndex}`} className="rounded-[2px] border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10 p-3 space-y-2">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                                    {section.title || `Secao ${sectionIndex + 1}`}
                                                </div>
                                                {(Array.isArray(section.productItems) ? section.productItems : []).map((item, itemIndex) => (
                                                    <div key={`wtn_int_product_item_${sectionIndex}_${itemIndex}`} className="rounded-[2px] bg-white dark:bg-slate-900 px-3 py-2 text-xs">
                                                        <div className="font-mono break-all text-amber-900 dark:text-amber-100">
                                                            {item.productRetailerId || 'produto_sem_id'}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="p-3 flex flex-wrap gap-2">
                                    {selectedInteractive.buttons.map((button, index) => (
                                        <span key={`wtn_int_btn_${button.id || index}`} className="inline-flex flex-col items-start gap-1 px-3 py-2 rounded-[2px] bg-white dark:bg-slate-900 border border-fuchsia-200 dark:border-fuchsia-800 text-fuchsia-700 dark:text-fuchsia-300 text-xs font-medium">
                                            <span>{button.title || 'Botao'}</span>
                                            <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                                                payload: {button.id || 'sem_id'}
                                            </span>
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const NodeConfigModal = ({
    node,
    isOpen,
    onClose,
    onSave,
    nodes = [],
    vars = [],
    templates = [],
    schedules = [],
    whatsappTemplates = [],
    whatsappInteractiveTemplates = [],
    whatsappSenderOptions = [],
    whatsappChannelReady = false,
    whatsappDataLoading = false,
    whatsappDataError = '',
    queues = [],
    catalogItems = [],
    mediaAssets = [],
    subflows = []
}) => {
    const [localData, setLocalData] = useState({});
    const [mediaLibrary, setMediaLibrary] = useState([]);
    const [uploadState, setUploadState] = useState({ loading: false, error: '' });
    const initializedNodeRef = useRef(null);

    useEffect(() => {
        if (!isOpen || !node) {
            initializedNodeRef.current = null;
            return;
        }

        // Reidratações do canvas recriam o objeto do node. Não podemos usar essa
        // identidade para reinicializar o formulário, pois isso apaga edições em curso.
        if (initializedNodeRef.current !== node.id) {
            initializedNodeRef.current = node.id;
            setLocalData({ ...node.data });
        }
    }, [isOpen, node?.id]);

    useEffect(() => {
        setMediaLibrary(Array.isArray(mediaAssets) ? mediaAssets : []);
    }, [mediaAssets]);

    const handleLocalChange = (newData) => setLocalData(prev => ({ ...prev, ...newData }));
    const getMenuOptions = () => (Array.isArray(localData.options) ? localData.options : []);

    // Lista de âncoras existentes no fluxo (para o seletor de busca do GoTo).
    const availableAnchors = (Array.isArray(nodes) ? nodes : [])
        .filter((n) => n?.type === 'anchorNode')
        .map((n) => String(n?.data?.anchorName || '').trim())
        .filter(Boolean)
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const addMenuOption = () => {
        setLocalData(prev => {
            const options = Array.isArray(prev.options) ? [...prev.options] : [];
            const nextId = String(options.length + 1);
            options.push({ id: nextId, label: `Opção ${nextId}`, value: nextId });
            return { ...prev, options };
        });
    };
    const updateMenuOption = (index, key, value) => {
        setLocalData(prev => {
            const options = Array.isArray(prev.options) ? [...prev.options] : [];
            options[index] = { ...(options[index] || {}), [key]: value };
            return { ...prev, options };
        });
    };
    const removeMenuOption = (index) => {
        setLocalData(prev => {
            const options = Array.isArray(prev.options) ? [...prev.options] : [];
            options.splice(index, 1);
            return { ...prev, options };
        });
    };
    const handleUploadAsset = async (file) => {
        if (!file) return;
        setUploadState({ loading: true, error: '' });
        try {
            const asset = await uploadMediaAsset(file);
            setMediaLibrary((prev) => [asset, ...prev.filter((item) => item.id !== asset.id)]);
            handleLocalChange({ mediaUrl: asset.url });
            setUploadState({ loading: false, error: '' });
        } catch (error) {
            setUploadState({ loading: false, error: error.message || 'Falha no upload' });
        }
    };

    const handleSave = () => {
        onSave(node.id, localData);
        onClose();
    };

    if (!isOpen || !node) return null;

    let Content = null;
    let Title = 'Configurar Nó';
    let Icon = FileText;
    let modalSizeClass = 'max-w-lg';

    switch (node.type) {
        case 'setValueNode':
            Title = 'Definir Valor de Variável';
            Icon = Database;
            Content = (
                <div className="space-y-4">
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Variável Alvo</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white outline-none"
                            value={localData.variableName || ''}
                            onChange={e => handleLocalChange({ variableName: e.target.value })}
                        >
                            <option value="">Selecione a variável...</option>
                            {vars.map(v => (
                                <option key={v.id} value={v.name}>{v.name}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Escolha qual variável terá o valor alterado.</p>
                    </div>

                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Valor a ser Atribuído</label>
                        <input
                            type="text"
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white outline-none"
                            placeholder="Ex: true, 100, Ativo..."
                            value={localData.value || ''}
                            onChange={e => handleLocalChange({ value: e.target.value })}
                        />
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Dica: Você pode usar outras variáveis aqui usando {'{var_nome}'}.</p>
                    </div>
                </div>
            );
            break;
        case 'cartNode':
            Title = 'Configurar Carrinho';
            Icon = ShoppingCart;
            modalSizeClass = 'max-w-5xl';
            Content = (
                <CartNodeConfig
                    data={localData}
                    onChange={handleLocalChange}
                    vars={vars}
                    whatsappInteractiveTemplates={whatsappInteractiveTemplates}
                />
            );
            break;
        case 'secretNode':
            Title = 'Definir Secret';
            Icon = Key;
            Content = (
                <div className="space-y-4">
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Variável Alvo</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white outline-none"
                            value={localData.variableName || ''}
                            onChange={e => handleLocalChange({ variableName: e.target.value })}
                        >
                            <option value="">Selecione a variável...</option>
                            {vars.map(v => (
                                <option key={v.id} value={v.name}>{v.name}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Escolha a variável que receberá o segredo.</p>
                    </div>

                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Valor Secreto</label>
                        <input
                            type="password"
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm dark:bg-slate-700 dark:text-white outline-none"
                            placeholder="Ex: token, chave, segredo..."
                            value={localData.value || ''}
                            onChange={e => handleLocalChange({ value: e.target.value })}
                        />
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">O valor pode ser usado como {'{SECRET}'} em outros nós.</p>
                    </div>
                </div>
            );
            break;
        case 'messageNode':
            Title = 'Configurar Mensagem';
            Content = <MessageConfig data={localData} onChange={handleLocalChange} />;
            break;
        case 'commandNode':
            Title = 'Configurar Comando';
            Icon = Command;
            Content = <CommandConfig data={localData} onChange={handleLocalChange} />;
            break;
        case 'mediaNode':
            Title = 'Configurar Mídia';
            Icon = Image;
            Content = <MediaConfig data={localData} onChange={handleLocalChange} mediaAssets={mediaLibrary} onUploadAsset={handleUploadAsset} uploadState={uploadState} />;
            break;
        case 'catalogNode':
            Title = 'Configurar Catálogo';
            Icon = FileText;
            Content = <CatalogConfig data={localData} onChange={handleLocalChange} catalogItems={catalogItems} />;
            break;
        case 'menuNode': {
            Title = 'Configurar Menu';
            Icon = FileText;
            const menuDinamico = localData.optionsSource === 'variable';
            // Sem escolha gravada = menu de antes desta versao: so o texto vai.
            const exibicao = menuDinamico
                ? (localData.optionsDisplay === 'numbered' ? 'numbered' : 'auto')
                : (['auto', 'numbered'].includes(localData.optionsDisplay) ? localData.optionsDisplay : 'text');
            Content = (
                <div className="space-y-4">
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem do Menu</label>
                        <textarea
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm h-24"
                            placeholder={exibicao === 'text' ? '1 - Falar com atendente\n2 - Acompanhar OS' : 'Como posso te ajudar?'}
                            value={localData.text || ''}
                            onChange={e => handleLocalChange({ text: e.target.value })}
                        />
                        {exibicao !== 'text' && <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">As opções vão junto automaticamente; não precisa escrevê-las aqui.</p>}
                    </div>

                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">De onde vêm as opções</label>
                        <div className="mt-1 grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => handleLocalChange({ optionsSource: 'fixed' })}
                                className={`h-9 rounded-[2px] border px-3 font-mono text-[10px] font-bold uppercase transition-colors ${!menuDinamico ? 'border-slate-950 bg-slate-950 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950' : 'border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}>
                                Fixas
                            </button>
                            <button type="button" onClick={() => handleLocalChange({ optionsSource: 'variable', optionsDisplay: localData.optionsDisplay === 'numbered' ? 'numbered' : 'auto', createBranches: true })}
                                className={`h-9 rounded-[2px] border px-3 font-mono text-[10px] font-bold uppercase transition-colors ${menuDinamico ? 'border-slate-950 bg-slate-950 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950' : 'border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}>
                                De uma variável
                            </button>
                        </div>
                    </div>

                    {menuDinamico ? (
                        <div className="space-y-3 border border-slate-300 bg-slate-200/60 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                            <div>
                                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Lista na variável</label>
                                <input list="menu-vars" className="w-full mt-1 p-2 border rounded-[2px] text-sm" placeholder="horarios ou resposta.data.itens"
                                    value={localData.optionsVariable || ''} onChange={e => handleLocalChange({ optionsVariable: e.target.value.trim() })} />
                                <datalist id="menu-vars">{vars.map(v => <option key={v.id} value={v.name} />)}</datalist>
                                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Uma lista (por exemplo, a resposta de uma API guardada pelo node HTTP). Até 10 itens viram opções.</p>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Nome de cada item</label>
                                    <input className="w-full mt-1 p-2 border rounded-[2px] text-sm" placeholder="nome"
                                        value={localData.optionLabelPath || ''} onChange={e => handleLocalChange({ optionLabelPath: e.target.value.trim() })} />
                                </div>
                                <div>
                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Valor a guardar</label>
                                    <input className="w-full mt-1 p-2 border rounded-[2px] text-sm" placeholder="id"
                                        value={localData.optionValuePath || ''} onChange={e => handleLocalChange({ optionValuePath: e.target.value.trim() })} />
                                </div>
                            </div>
                            <div>
                                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Descrição na lista (opcional)</label>
                                <input className="w-full mt-1 p-2 border rounded-[2px] text-sm" placeholder="preco"
                                    value={localData.optionDescriptionPath || ''} onChange={e => handleLocalChange({ optionDescriptionPath: e.target.value.trim() })} />
                                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Campos do item. Se a lista for só de textos, deixe em branco.</p>
                            </div>
                            <div>
                                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Guardar a escolha em</label>
                                <select className="w-full mt-1 p-2 border rounded-[2px] text-sm" value={localData.variableName || ''} onChange={e => handleLocalChange({ variableName: e.target.value })}>
                                    <option value="">Selecione a variável...</option>
                                    {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                                </select>
                            </div>
                            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Saídas: <b>Escolheu</b>, <b>Lista vazia</b> (a variável veio sem itens) e <b>Else</b> (resposta que não é uma opção).</p>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center justify-between">
                                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Opções</label>
                                <button
                                    onClick={addMenuOption}
                                    className="flex items-center gap-1 rounded-[2px] border border-slate-400 px-2 py-1 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                    <Plus size={14} /> Add Opção
                                </button>
                            </div>

                            <div className="space-y-2">
                                {getMenuOptions().map((opt, index) => (
                                    <div key={`${opt.id || index}`} className="border border-slate-300 rounded-[2px] p-3 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 space-y-2">
                                        <div className="flex gap-2">
                                            <input
                                                className="w-20 p-2 border rounded-[2px] text-xs"
                                                placeholder="ID"
                                                value={opt.id || ''}
                                                onChange={e => updateMenuOption(index, 'id', e.target.value)}
                                            />
                                            <input
                                                className="flex-1 p-2 border rounded-[2px] text-xs"
                                                placeholder="Rótulo"
                                                maxLength={exibicao === 'auto' ? 24 : undefined}
                                                value={opt.label || ''}
                                                onChange={e => updateMenuOption(index, 'label', e.target.value)}
                                            />
                                            <button
                                                onClick={() => removeMenuOption(index)}
                                                className="text-red-500 hover:text-red-600"
                                                title="Remover"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                        {localData.setVarEnabled && (
                                            <input
                                                className="w-full p-2 border rounded-[2px] text-xs"
                                                placeholder="Valor a salvar nesta opção"
                                                value={opt.value || ''}
                                                onChange={e => updateMenuOption(index, 'value', e.target.value)}
                                            />
                                        )}
                                    </div>
                                ))}
                                {getMenuOptions().length === 0 && (
                                    <div className="text-[11px] text-slate-400">Nenhuma opção cadastrada.</div>
                                )}
                            </div>
                        </>
                    )}

                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Como as opções aparecem</label>
                        <select className="w-full mt-1 p-2 border rounded-[2px] text-sm" value={exibicao} onChange={e => handleLocalChange({ optionsDisplay: e.target.value })}>
                            <option value="auto">Botões ou lista (automático)</option>
                            <option value="numbered">Texto numerado</option>
                            {!menuDinamico && <option value="text">Só o texto da mensagem</option>}
                        </select>
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                            {exibicao === 'auto' && 'No WhatsApp: até 3 opções viram botões, até 10 viram lista, mais que isso vai numerado. Títulos longos são cortados (20 caracteres no botão, 24 na lista).'}
                            {exibicao === 'numbered' && 'As opções vão numeradas embaixo da mensagem; o cliente responde com o número ou o nome.'}
                            {exibicao === 'text' && 'Só a mensagem acima é enviada. Escreva as opções nela, senão o cliente não sabe o que escolher.'}
                        </p>
                    </div>

                    {exibicao === 'auto' && (
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Botão da lista</label>
                            <input className="w-full mt-1 p-2 border rounded-[2px] text-sm" maxLength={20} placeholder="Ver opções"
                                value={localData.listButtonText || ''} onChange={e => handleLocalChange({ listButtonText: e.target.value })} />
                        </div>
                    )}

                    {!menuDinamico && (
                        <>
                            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                                <input type="checkbox" checked={localData.setVarEnabled === true} onChange={e => handleLocalChange({ setVarEnabled: e.target.checked })} />
                                Salvar seleção em variável
                            </label>
                            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                                <input type="checkbox" checked={localData.createBranches !== false} onChange={e => handleLocalChange({ createBranches: e.target.checked })} />
                                Criar ramificações
                            </label>
                        </>
                    )}

                    <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                        <input type="checkbox" checked={localData.hasElse !== false} onChange={e => handleLocalChange({ hasElse: e.target.checked })} />
                        Criar saída Else
                    </label>

                    {!menuDinamico && localData.setVarEnabled && (
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Variável Alvo</label>
                            <select
                                className="w-full mt-1 p-2 border rounded-[2px] text-sm"
                                value={localData.variableName || ''}
                                onChange={e => handleLocalChange({ variableName: e.target.value })}
                            >
                                <option value="">Selecione a variável...</option>
                                {vars.map(v => (
                                    <option key={v.id} value={v.name}>{v.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Mensagem de erro</label>
                        <input
                            className="w-full mt-1 p-2 border rounded-[2px] text-sm"
                            placeholder="Selecione uma opção válida."
                            value={localData.invalidSelectionMessage || ''}
                            onChange={e => handleLocalChange({ invalidSelectionMessage: e.target.value })}
                        />
                    </div>
                    <InactivityConfig data={localData} onChange={handleLocalChange} />
                </div>
            );
            break;
        }
        case 'sequentialNode':
            Title = 'Configurar Sequencial';
            Icon = Settings;
            modalSizeClass = 'max-w-3xl';
            Content = <SequentialConfig data={localData} onChange={handleLocalChange} vars={vars} />;
            break;
        case 'scriptNode':
            Title = 'Configurar Script JS';
            Icon = Code;
            Content = <ScriptConfig data={localData} onChange={handleLocalChange} />;
            break;
        case 'conditionNode':
            Title = 'Configurar Condicional';
            Icon = Split;
            Content = <ConditionConfig data={localData} onChange={handleLocalChange} vars={vars} />;
            break;
        case 'templateNode':
            Title = 'Configurar Template HSM';
            Icon = FileText;
            Content = <TemplateConfig data={localData} onChange={handleLocalChange} templates={templates} />;
            break;
        case 'whatsappTemplateNode':
            Title = 'Configurar WTN';
            Icon = Smartphone;
            modalSizeClass = 'max-w-5xl';
            Content = (
                <WhatsAppTemplateNodeConfig
                    data={localData}
                    onChange={handleLocalChange}
                    vars={vars}
                    whatsappTemplates={whatsappTemplates}
                    whatsappInteractiveTemplates={whatsappInteractiveTemplates}
                    whatsappSenderOptions={whatsappSenderOptions}
                    whatsappChannelReady={whatsappChannelReady}
                    whatsappDataLoading={whatsappDataLoading}
                    whatsappDataError={whatsappDataError}
                />
            );
            break;
        case 'gotoNode':
            Title = 'Salto de Fluxo (GoTo)';
            Icon = Send;
            Content = <GotoConfig data={localData} onChange={handleLocalChange} anchors={availableAnchors} />;
            break;
        case 'anchorNode':
            Title = 'Configurar Âncora';
            Icon = Anchor;
            Content = <AnchorConfig data={localData} onChange={handleLocalChange} />;
            break;

        case 'delayNode':
            Title = 'Configurar Delay';
            Content = (
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Tempo de Espera (segundos)</label>
                    <input type="number" className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                        value={localData.delay || 1} onChange={e => handleLocalChange({ delay: e.target.value })} />
                </div>
            );
            break;
        case 'subflowNode': {
            const escolhido = subflows.find((item) => item.id === localData.subflowId) || null;
            Title = 'Executar Subfluxo';
            Content = (
                <div className="space-y-4">
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Subfluxo</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700 dark:text-white"
                            value={localData.subflowId || ''}
                            onChange={e => handleLocalChange({ subflowId: e.target.value })}
                        >
                            <option value="">Selecione um subfluxo...</option>
                            {subflows.map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.name}{item.status === 'published' ? '' : ' (sem versao publicada)'}
                                </option>
                            ))}
                        </select>
                        {subflows.length === 0 && (
                            <p className="text-[11px] text-amber-600 mt-1">
                                Nenhum subfluxo criado ainda. Crie um na Biblioteca de subfluxos.
                            </p>
                        )}
                        {escolhido && escolhido.status !== 'published' && (
                            <p className="text-[11px] text-amber-600 mt-1">
                                Este subfluxo ainda nao foi publicado. Em producao ele cai na rota de excecao.
                            </p>
                        )}
                    </div>

                    <div className="border border-slate-200 p-3 text-[11px] leading-relaxed text-slate-600 dark:border-slate-700 dark:text-slate-300">
                        <strong className="block text-xs text-slate-800 dark:text-slate-100 mb-1">As tres rotas de saida</strong>
                        <p className="m-0"><strong>Prosseguir:</strong> o subfluxo chegou na saida e devolveu o controle.</p>
                        <p className="m-0"><strong>Retomou do atendimento:</strong> passou por uma fila e o atendente encerrou.</p>
                        <p className="m-0"><strong>Excecao:</strong> erro nao tratado. O motivo fica na variavel SUBFLUXO_ERRO.</p>
                    </div>
                </div>
            );
            break;
        }
        case 'queueNode':
            Title = 'Transferir para Fila';
            Content = (
        <div className="space-y-4">
            <div>
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Escolha a Fila de Destino</label>
                <select
                    className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700 dark:text-white"
                    value={localData.queueName || ''}
                    onChange={e => handleLocalChange({ queueName: e.target.value })}
                >
                    <option value="">Selecione uma fila...</option>
                    {queues.map(q => (
                        <option key={q.id} value={q.name}>{q.name}</option>
                    ))}
                </select>
            </div>
            <div>
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                        type="checkbox"
                        checked={localData.sendQueueMessage ?? true}
                        className="h-4 w-4 accent-slate-900"
                        onChange={e => handleLocalChange({ sendQueueMessage: e.target.checked })}
                    />
                    Enviar mensagem de espera ao cliente
                </label>
                <textarea
                    className="w-full mt-2 p-2 border rounded-[2px] dark:bg-slate-700 dark:text-white min-h-[90px] disabled:opacity-50 disabled:cursor-not-allowed"
                    value={localData.queueMessage || ''}
                    onChange={e => handleLocalChange({ queueMessage: e.target.value })}
                    placeholder="Aguarde, em alguns instantes um especialista deve te atender."
                    disabled={(localData.sendQueueMessage ?? true) === false}
                />
                <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                    Desmarque para encaminhar em silêncio, sem avisar o cliente. Deixar em branco com a opção marcada usa a mensagem padrão.
                </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                    type="checkbox"
                    checked={localData.continueFlowAfterQueue ?? true}
                    className="h-4 w-4 accent-slate-900"
                    onChange={e => handleLocalChange({ continueFlowAfterQueue: e.target.checked })}
                />
                Continuar fluxo após o agente finalizar
            </label>
            <div className="border border-slate-300 bg-slate-200/60 p-3 dark:border-slate-700 dark:bg-slate-800/60 text-[11px] leading-snug text-slate-600 dark:text-slate-300">
                Ao atingir este nó, o bot será pausado e o cliente entrará na fila selecionada aguardando um agente humano.
            </div>
        </div>
            );
            break;
        case 'scheduleNode':
            Title = 'Validar Horário';
            Content = (
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Grupo de Horário</label>
                    <select className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700" value={localData.scheduleId || ''} onChange={e => handleLocalChange({ scheduleId: e.target.value })}>
                        <option value="">Selecione...</option>
                        {schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
            );
            break;
        case 'inputNode':
            Title = 'Entrada de Dados';
            Content = (
                <div className="space-y-4">
                <div>
                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Pergunta do Bot</label>
                    <textarea
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700 h-20"
                            value={localData.text || ''}
                            onChange={e => handleLocalChange({ text: e.target.value })}
                            placeholder="Ex: Qual o seu e-mail?"
                        />
                    </div>
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar resposta na variável:</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                            value={localData.variableName || ''}
                            onChange={e => handleLocalChange({ variableName: e.target.value })}
                        >
                            <option value="">Selecione uma variável...</option>
                            {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                        </select>
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                            A resposta do cliente será guardada nesta variável para uso posterior.
                        </p>
                    </div>
                    <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Validacao da resposta</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                            value={localData.validationType || 'none'}
                            onChange={e => handleLocalChange({ validationType: e.target.value })}
                        >
                            <option value="none">Livre (sem validacao)</option>
                            <option value="email">E-mail</option>
                            <option value="phone">Telefone</option>
                            <option value="cpf">CPF</option>
                            <option value="cnpj">CNPJ</option>
                            <option value="number">Numero</option>
                            <option value="date">Data</option>
                            <option value="regex">Expressao regular</option>
                        </select>
                    </div>
                    {(localData.validationType || 'none') === 'regex' && (
                        <div>
                            <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Expressao regular</label>
                            <input
                                type="text"
                                maxLength={200}
                                className="w-full mt-1 p-2 border rounded-[2px] font-mono text-sm dark:bg-slate-700"
                                value={localData.validationPattern || ''}
                                onChange={e => handleLocalChange({ validationPattern: e.target.value })}
                                placeholder="Ex: ^[A-Z]{3}-\\d{3}$"
                            />
                            <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Limite de 200 caracteres. A verificacao possui timeout de seguranca.</p>
                        </div>
                    )}
                    {(localData.validationType || 'none') !== 'none' && (
                        <>
                            <div>
                                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Resposta invalida</label>
                                <textarea
                                    className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700 h-20"
                                    value={localData.errorText || ''}
                                    onChange={e => handleLocalChange({ errorText: e.target.value })}
                                    placeholder="Ex: Nao consegui validar. Tente novamente."
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Maximo de tentativas</label>
                                    <input
                                        type="number"
                                        min="0"
                                        max="100"
                                        className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                                        value={Number(localData.maxAttempts) || 0}
                                        onChange={e => handleLocalChange({ maxAttempts: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                                    />
                                    <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">Use 0 para tentativas ilimitadas.</p>
                                </div>
                                <div>
                                    <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Ao atingir o limite</label>
                                    <select
                                        className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                                        value={localData.onFailBehavior || 'repeat'}
                                        onChange={e => handleLocalChange({
                                            onFailBehavior: e.target.value,
                                            ...(e.target.value === 'branch' && !(Number(localData.maxAttempts) > 0)
                                                ? { maxAttempts: 3 }
                                                : {})
                                        })}
                                    >
                                        <option value="repeat">Continuar perguntando</option>
                                        <option value="branch">Seguir pela saida invalida</option>
                                    </select>
                                </div>
                            </div>
                            <div className="border border-slate-300 bg-slate-200/60 p-3 dark:border-slate-700 dark:bg-slate-800/60 text-[11px] text-slate-700 dark:text-slate-200">
                                Telefone, CPF e CNPJ sao salvos apenas com digitos. Numero e salvo como valor numerico. Data aceita DD/MM/AAAA ou AAAA-MM-DD e e salva como AAAA-MM-DD.
                            </div>
                        </>
                    )}
                    <InactivityConfig data={localData} onChange={handleLocalChange} />
                </div>
            );
            break;
        case 'holderNode':
            Title = 'Configurar Holder';
            Icon = Hand;
            Content = <HolderConfig data={localData} onChange={handleLocalChange} vars={vars} />;
            break;
        case 'ratingNode':
            Title = 'Solicitar Nota (1-5)';
            Content = (
                <div className="space-y-4">
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Pergunta do Bot</label>
                        <textarea
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700 h-20"
                            value={localData.text || ''}
                            onChange={e => handleLocalChange({ text: e.target.value })}
                            placeholder="Avalie este atendimento de 1 a 5."
                        />
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                            O cliente deve digitar um número entre 1 e 5; respostas inválidas retornam erro.
                        </p>
                    </div>
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Resposta inválida</label>
                        <input
                            type="text"
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                            value={localData.errorText || ''}
                            onChange={e => handleLocalChange({ errorText: e.target.value })}
                            placeholder="Ex: Digite um número entre 1 e 5."
                        />
                        <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                            Texto exibido quando o cliente responde com algo diferente de 1 a 5.
                        </p>
                    </div>
                    <div>
                        <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Salvar resposta na variável:</label>
                        <select
                            className="w-full mt-1 p-2 border rounded-[2px] dark:bg-slate-700"
                            value={localData.variableName || ''}
                            onChange={e => handleLocalChange({ variableName: e.target.value })}
                        >
                            <option value="">Selecione uma variável...</option>
                            {vars.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                        </select>
                    </div>
                    <InactivityConfig data={localData} onChange={handleLocalChange} />
                </div>
            );
            break;
        case 'httpRequestNode':
            Title = 'Requisição HTTP (API)';
            Icon = Globe;
            Content = (
                <HttpRequestConfig
                    data={localData}
                    onChange={handleLocalChange}
                    vars={vars}
                />
            );
            break;
        case 'finalNode':
            Title = 'Mensagem de Encerramento';
            Icon = Flag;
            Content = <FinalNodeConfig data={localData} onChange={handleLocalChange} />;
            break;
        default:
            Content = <div className="border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">Configuração não mapeada para o tipo: <b>{node.type}</b></div>;
    }

    return (
        <ConfigWrapper title={Title} onClose={onClose} onSave={onSave ? handleSave : null} sizeClass={modalSizeClass}>
            <WhatsAppPreview preview={buildWhatsAppPreview(node.type, localData, { templates, catalogItems })} />
            <div className="mb-5 border-b border-slate-300 pb-4 dark:border-slate-700">
                <label className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Identificador visual</label>
                <input
                    className="w-full mt-1 p-2 border rounded-[2px] text-sm"
                    placeholder={node.type}
                    value={localData.customName || ''}
                    onChange={e => handleLocalChange({ customName: e.target.value })}
                />
                <div className="mt-4">
                    <label className="block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">
                        Observações editoriais
                        <textarea
                            value={localData.observations || ''}
                            onChange={e => handleLocalChange({ observations: e.target.value })}
                            placeholder="Contexto para quem mantem este fluxo..."
                            className="mt-1 block min-h-20 w-full resize-y border p-2 text-sm font-normal normal-case tracking-normal"
                        />
                    </label>
                </div>
            </div>
            {Content}
        </ConfigWrapper>
    );
};

export default NodeConfigModal;
