import React from 'react';
import { Handle, Position } from 'reactflow';
import {
    Play, Square, MessageSquare, TextCursorInput,
    Database, Split, Anchor, ArrowRight, Code,
    Globe, Hourglass, Hand, Users, Clock, FileText,
    X, Flag, GitBranch, Star, Command, Image, Package, ShoppingCart, Key, Menu as MenuIcon, Smartphone, Settings, Circle, Boxes
} from 'lucide-react';
import { integrationIcon } from '../utils/integrationIcons';


const NODE_WIDTH = 248;
const NODE_HEADER_HEIGHT = 30;
const NODE_ROW_HEIGHT = 28;
// Offset fixo (do topo) da linha dos handles = padding externo (4) + meio do
// cabecalho (~16). Mesmo valor em todos os nodes -> handles no mesmo Y.
const HANDLE_TOP = 20;
const NODE_HEIGHT = 58;
const NODE_EXPANDED_HEIGHT = 96;
const NODE_DETAIL_ROW_HEIGHT = 16;
const NODE_DETAIL_VERTICAL_SPACE = 28;


const Tooltip = ({ text }) => (
    <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50 shadow-lg">
        {text || "Sem descrição"}
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800"></div>
    </div>
);

const compactText = (value, fallback = '') => String(value ?? fallback)
    .replace(/\s+/g, ' ')
    .trim();

const clipText = (value, max = 42) => {
    const text = compactText(value);
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
};

const fullPreviewText = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }
    return String(value).replace(/\r\n/g, '\n').trim();
};

const countItems = (value) => Array.isArray(value) ? value.length : 0;

const booleanLabel = (value, truthy = 'sim', falsy = 'nao') => value ? truthy : falsy;
const cleanBadge = (value, max = 14) => clipText(value, max).toUpperCase();

const getToneClass = (tone = 'slate') => {
    if (tone === 'blue') return 'border-blue-200/80 bg-blue-50/95 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200';
    if (tone === 'green') return 'border-emerald-200/80 bg-emerald-50/95 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200';
    if (tone === 'amber') return 'border-amber-200/90 bg-amber-50/95 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200';
    if (tone === 'red') return 'border-red-200/90 bg-red-50/95 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200';
    if (tone === 'violet') return 'border-violet-200/80 bg-violet-50/95 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-200';
    if (tone === 'cyan') return 'border-cyan-200/80 bg-cyan-50/95 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/15 dark:text-cyan-200';
    return 'border-slate-200/90 bg-white/95 text-slate-600 dark:border-slate-600/50 dark:bg-slate-900/90 dark:text-slate-200';
};

const buildNodeBadges = (data = {}, nodeType = '', label = '', outputs = []) => {
    const nodeKind = compactText(nodeType || label).toLowerCase();
    const badges = [];
    const addBadge = (text, tone = 'slate') => {
        const labelText = cleanBadge(text);
        if (labelText) badges.push({ text: labelText, tone });
    };

    if (nodeKind === 'messagenode' || nodeKind === 'textnode') addBadge('msg', 'blue');
    else if (nodeKind === 'inputnode') {
        addBadge('input', 'amber');
        addBadge(data.variableName, 'slate');
    } else if (nodeKind === 'holdernode') addBadge('hold', 'amber');
    else if (nodeKind === 'setvaluenode') {
        addBadge('set', 'green');
        addBadge(data.variableName, 'slate');
    } else if (nodeKind === 'cartnode') {
        addBadge(data.operation === 'clear' ? 'limpar' : 'adicionar', data.operation === 'clear' ? 'slate' : 'green');
        addBadge(`${countItems(data.priceMap)} precos`, 'blue');
    } else if (nodeKind === 'secretnode') addBadge('secret', 'slate');
    else if (nodeKind === 'scriptnode') addBadge('js', 'slate');
    else if (nodeKind === 'delaynode') addBadge(data.delay || data.duration ? `${data.delay || data.duration}${data.unit || 's'}` : 'delay', 'amber');
    else if (nodeKind === 'queuenode') addBadge(data.queueName || data.queue || 'fila', 'amber');
    else if (nodeKind === 'medianode') addBadge(data.mediaType || 'media', 'cyan');
    else if (nodeKind === 'catalognode') addBadge(`${countItems(data.itemIds || data.items)} itens`, 'violet');
    else if (nodeKind === 'httprequestnode') {
        addBadge(data.method || 'GET', 'cyan');
        if ((outputs || []).some((item) => item.id === 'error')) addBadge('erro', 'red');
    } else if (nodeKind === 'conditionnode') addBadge(`${countItems(data.conditions)} if`, 'violet');
    else if (nodeKind === 'whatsapptemplatenode') {
        addBadge('wtn', 'green');
        if (data.waitForReply) addBadge('reply', 'amber');
    } else if (nodeKind === 'menunode') {
        addBadge(`${countItems(data.options)} op`, 'slate');
        addBadge(data.createBranches ? 'ramos' : 'unico', data.createBranches ? 'violet' : 'green');
    } else if (nodeKind === 'sequentialnode') addBadge(`${countItems(data.steps || data.items || data.actions)} etapas`, 'red');
    else if (nodeKind === 'startnode') addBadge('start', 'green');
    else if (nodeKind === 'endnode' || nodeKind === 'finalnode') addBadge('end', 'red');

    return badges.slice(0, 3);
};

const buildHoverDetails = (data = {}, nodeType = '', label = '') => {
    const nodeKind = compactText(nodeType || label).toLowerCase();
    const lines = [];
    const addLine = (title, value) => {
        const fullValue = fullPreviewText(value);
        const text = clipText(value, 52);
        if (text) lines.push({ title, value: text, fullValue });
    };

    if (nodeKind === 'messagenode' || nodeKind === 'textnode' || nodeKind.includes('mensagem') || nodeKind.includes('texto')) {
        addLine('Texto', data.text || data.message);
    } else if (nodeKind === 'inputnode' || nodeKind.includes('entrada')) {
        addLine('Pergunta', data.text || data.prompt);
        addLine('Var', data.variableName);
        addLine('Validacao', data.validationType && data.validationType !== 'none' ? data.validationType : 'Livre');
    } else if (nodeKind === 'holdernode' || nodeKind.includes('holder')) {
        addLine('Mensagem', data.text);
        addLine('Salvar', booleanLabel(data.saveMessages !== false));
        addLine('Fallback', data.fallbackText);
    } else if (nodeKind === 'setvaluenode' || nodeKind.includes('definir')) {
        addLine('Var', data.variableName);
        addLine('Valor', data.value);
    } else if (nodeKind === 'cartnode' || nodeKind.includes('carrinho')) {
        addLine('Operacao', data.operation === 'clear' ? 'Limpar carrinho' : 'Adicionar item');
        if (data.operation !== 'clear') {
            addLine('Produto', data.productIdVar || data.productNameVar);
            addLine('Precos', data.priceSource === 'variable' ? data.unitPriceVar : `${countItems(data.priceMap)} mapeado(s)`);
        }
    } else if (nodeKind === 'secretnode' || nodeKind.includes('secret')) {
        addLine('Var', data.variableName || data.name);
        addLine('Valor', data.variableName || data.name ? '***' : '');
    } else if (nodeKind === 'scriptnode' || nodeKind.includes('script')) {
        addLine('Script', data.script || data.code);
    } else if (nodeKind === 'delaynode' || nodeKind.includes('delay')) {
        addLine('Tempo', `${data.delay || data.duration || 1} ${data.unit || 's'}`);
    } else if (nodeKind === 'anchornode' || nodeKind.includes('ancora')) {
        addLine('Ancora', data.anchorName || data.name || data.label);
    } else if (nodeKind === 'gotonode' || nodeKind.includes('ir para')) {
        addLine('Destino', data.targetNodeId || data.targetId || data.gotoNodeId);
    } else if (nodeKind === 'queuenode' || nodeKind.includes('fila')) {
        addLine('Fila', data.queueName || data.queue);
        addLine('Continua', booleanLabel(data.continueFlowAfterQueue));
    } else if (nodeKind === 'ratingnode' || nodeKind.includes('nota')) {
        addLine('Texto', data.text);
        addLine('Var', data.variableName);
    } else if (nodeKind === 'commandnode' || nodeKind.includes('comando')) {
        addLine('Comando', data.command || data.commandText || data.text);
    } else if (nodeKind === 'medianode' || nodeKind.includes('midia')) {
        addLine('Tipo', data.mediaType || data.type);
        addLine('Legenda', data.caption || data.text);
    } else if (nodeKind === 'catalognode' || nodeKind.includes('catalogo')) {
        const total = countItems(data.itemIds || data.items);
        addLine('Itens', total ? `${total} selecionado(s)` : '');
        addLine('Botoes', booleanLabel(data.showButtons ?? data.withButtons ?? data.waitForReply));
    } else if (nodeKind === 'httprequestnode' || nodeKind.includes('api http')) {
        addLine('Metodo', data.method || 'GET');
        if (data.integrationId) {
            addLine('API', data.integrationName);
            addLine('Caminho', data.path || '/');
        } else {
            addLine('URL', data.url);
        }
        addLine('Erro', data.errorVar || data.errorVariable || data.errorMessageVar);
    } else if (nodeKind === 'conditionnode' || nodeKind.includes('condicional')) {
        const total = countItems(data.conditions);
        addLine('Casos', total ? `${total} condicao(oes)` : '');
        addLine('Else', booleanLabel(data.hasElse !== false));
    } else if (nodeKind === 'schedulenode' || nodeKind.includes('horario')) {
        addLine('Agenda', data.scheduleName || data.scheduleId);
    } else if (nodeKind === 'templatenode' || nodeKind.includes('template')) {
        addLine('Template', data.templateName || data.templateId);
    } else if (nodeKind === 'whatsapptemplatenode' || nodeKind === 'wtn') {
        addLine('Tipo', data.contentKind || 'template');
        addLine('Modelo', data.subLabel || data.whatsappTemplateId || data.interactiveTemplateId);
        addLine('Aguardar', booleanLabel(data.waitForReply));
    } else if (nodeKind === 'menunode' || nodeKind.includes('menu')) {
        const total = countItems(data.options);
        const dinamico = data.optionsSource === 'variable';
        addLine('Opcoes', dinamico ? `de ${data.optionsVariable || '?'}` : (total ? `${total} opcao(oes)` : ''));
        addLine('Envio', dinamico || ['auto', 'numbered'].includes(data.optionsDisplay)
            ? (data.optionsDisplay === 'numbered' ? 'numerado' : 'botoes/lista')
            : 'so texto');
        addLine('Var', data.variableName);
    } else if (nodeKind === 'sequentialnode' || nodeKind.includes('sequencial')) {
        const steps = countItems(data.steps || data.items || data.actions);
        addLine('Etapas', steps ? `${steps} configurada(s)` : '');
    } else if (nodeKind === 'endnode' || nodeKind === 'finalnode' || nodeKind.includes('fim') || nodeKind.includes('finalizar')) {
        addLine('Mensagem', data.text || data.message);
    }

    if (!lines.length) {
        addLine('Config', data.subLabel || data.customName || 'Sem detalhes');
    }

    return lines.slice(0, 3);
};

const getNodeFamily = (nodeType = '', label = '') => {
    const kind = compactText(nodeType || label).toLowerCase();
    if (['messagenode', 'inputnode', 'holdernode', 'ratingnode', 'medianode', 'catalognode', 'templatenode', 'whatsapptemplatenode', 'menunode'].includes(kind)) return 'Conversa';
    if (['setvaluenode', 'cartnode', 'secretnode', 'scriptnode', 'httprequestnode', 'commandnode'].includes(kind)) return 'Sistema';
    if (['conditionnode', 'delaynode', 'schedulenode', 'sequentialnode'].includes(kind)) return 'Controle';
    if (['queuenode', 'anchornode', 'gotonode'].includes(kind)) return 'Operação';
    return 'Fluxo';
};

const getNodeContext = (data = {}, nodeType = '', label = '') => {
    const explicitLabel = compactText(data.subLabel);
    if (explicitLabel && explicitLabel.toLowerCase() !== compactText(label).toLowerCase()) return clipText(explicitLabel, 36);
    const [firstDetail] = buildHoverDetails(data, nodeType, label);
    return firstDetail?.value ? clipText(`${firstDetail.title}: ${firstDetail.value}`, 38) : '';
};

const getOperationalDetails = (data = {}, nodeType = '', label = '') => {
    const customName = compactText(data.customName);
    const rows = buildHoverDetails(data, nodeType, label)
        .filter((detail) => !(detail.title === 'Config' && detail.value === customName));

    if (customName && customName.toLowerCase() !== compactText(label).toLowerCase()) {
        rows.unshift({ title: 'Nome', value: clipText(customName, 40), fullValue: customName });
    }

    return rows.length
        ? rows.slice(0, 3)
        : [{ title: 'Status', value: 'Não configurado', fullValue: 'Não configurado' }];
};

const CompactNode = ({ id, type, data, icon: Icon, color, label, outputs = null, onDelete, disableConfig = false, selected = false, hideLabels = false }) => {

    const handles = outputs === null ? [{ id: 'default', label: '' }] : outputs;
    const details = getOperationalDetails(data, type, label);

    // Bolinha de conexao (circulo com anel branco). Ancoradas num offset FIXO a
    // partir do topo (linha do cabecalho): como o React Flow posiciona o node
    // pelo topo, todos os handles ficam no mesmo Y independente da altura do
    // corpo -> edges alinhados sem depender do tamanho do node.
    const dotClass = '!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-slate-500 !shadow-[0_1px_2px_rgba(15,23,42,0.35)] transition-transform hover:!scale-125 hover:!bg-slate-950 dark:!border-slate-800 dark:!bg-slate-400 dark:hover:!bg-slate-50';

    return (
        <div
            className={`compact-node flow-node-card group relative cursor-pointer overflow-visible rounded-[6px] border bg-white p-[4px] transition-[border-color,box-shadow,opacity] duration-100 dark:bg-slate-800 ${data?.disabled ? 'border-dashed opacity-45 grayscale' : ''} ${
                selected
                    ? 'is-selected border-slate-950 shadow-[0_0_0_2px_rgba(15,23,42,0.28)] dark:border-slate-50 dark:shadow-[0_0_0_2px_rgba(248,250,252,0.4)]'
                    : 'border-slate-400 hover:border-slate-950 dark:border-slate-600 dark:hover:border-slate-300'
            }`}
            style={{
                width: NODE_WIDTH
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                if (!disableConfig && data.onConfig) data.onConfig(id);
            }}
        >
            {/* Retangulo interno, um pouco mais escuro, com margem de 4px do externo.
                Altura automatica: o node cresce com o conteudo, evitando o
                descasamento de ~6px que empurrava a base/handles para fora. */}
            <div className="flex w-full flex-col overflow-hidden rounded-[3px] border border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-950">
                <div className="flex h-[30px] shrink-0 items-center justify-between gap-3 border-b border-slate-300 bg-slate-200 px-3 dark:border-slate-700 dark:bg-slate-900">
                    {/* Icone na cor do texto: ajuda a reconhecer o tipo sem colorir o canvas. */}
                    <span className="flex min-w-0 items-center gap-1.5">
                        {Icon ? <Icon size={12} strokeWidth={2.25} className="shrink-0 text-slate-600 dark:text-slate-300" aria-hidden="true" /> : null}
                        <span className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-900 dark:text-slate-100">
                            {label}
                        </span>
                    </span>
                    <span className="flex max-w-[100px] items-center gap-1 truncate font-mono text-[8px] text-slate-500 dark:text-slate-400" title={id}>
                        {data?.observations ? <span title="Possui observacoes">●</span> : null}
                        {data?.disabled ? 'DESATIVADO' : (type || id)}
                    </span>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {details.map((detail, index) => (
                        <div key={`${detail.title}_${index}`} className="grid h-7 grid-cols-[64px_minmax(0,1fr)] items-center">
                            <span className="h-full truncate border-r border-slate-200 bg-slate-200/60 px-2.5 font-mono text-[8px] font-bold uppercase leading-7 tracking-[0.06em] text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400" title={detail.title}>
                                {detail.title}
                            </span>
                            <span className="truncate bg-white px-3 font-mono text-[10px] leading-7 text-slate-900 dark:bg-slate-950 dark:text-slate-100" title={detail.fullValue || detail.value}>
                                {detail.value}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Entrada — esquerda, na linha do cabecalho (offset fixo do topo) */}
            <Handle
                type="target"
                position={Position.Left}
                style={{ top: HANDLE_TOP, bottom: 'auto', left: -5, transform: 'translateY(-50%)' }}
                className={dotClass}
            />

            {/* Saida(s) — direita, mesmo offset do topo (multiplas empilham para baixo) */}
            {handles.map((output, index) => {
                const topPos = HANDLE_TOP + index * 16;
                return (
                    <React.Fragment key={output.id}>
                        <Handle
                            type="source"
                            position={Position.Right}
                            id={output.id}
                            style={{ top: topPos, bottom: 'auto', right: -5, transform: 'translateY(-50%)' }}
                            className={dotClass}
                        />
                        {output.label && output.id !== 'default' && (
                            <span
                                className="absolute right-3 whitespace-nowrap rounded bg-slate-100 px-1 font-mono text-[8px] font-bold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                style={{ top: topPos, transform: 'translate(0, -50%)' }}
                            >
                                {output.label}
                            </span>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
};

export const CaseNode = ({ id, data, selected }) => (
    <div
        className={`case-node-card group relative grid h-[46px] grid-cols-[46px_minmax(0,1fr)] items-stretch overflow-visible rounded-[3px] border bg-slate-100 transition-[border-color,box-shadow] dark:bg-slate-900 ${
            selected
                ? 'border-slate-950 shadow-[0_0_0_2px_rgba(15,23,42,0.28)] dark:border-slate-50 dark:shadow-[0_0_0_2px_rgba(248,250,252,0.4)]'
                : data?.tone === 'error' ? 'border-red-700 dark:border-red-500' : 'border-slate-500 hover:border-slate-950 dark:border-slate-600 dark:hover:border-slate-300'
        }`}
        style={{
            width: 184,
            boxSizing: 'border-box',
            lineHeight: 1
        }}
    >
        <Handle
            type="target"
            position={Position.Left}
            style={{ top: HANDLE_TOP, transform: 'translateY(-50%)' }}
            className="!-left-[5px] !h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-slate-500 !shadow-[0_1px_2px_rgba(15,23,42,0.35)] transition-transform hover:!scale-125 hover:!bg-slate-950 dark:!border-slate-800 dark:!bg-slate-400 dark:hover:!bg-slate-50"
        />
        <span className={`flex items-center justify-center border-r font-mono text-[8px] font-bold uppercase tracking-[0.08em] ${data?.tone === 'error' ? 'border-red-300 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200' : 'border-slate-300 bg-slate-300 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
            Rota
        </span>
        <span className={`flex min-w-0 items-center truncate px-2.5 font-mono text-[10px] ${data?.tone === 'error' ? 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200' : 'text-slate-950 dark:text-slate-100'}`}>
            {data.label}
        </span>
        {data?.label && String(data.label).length > 18 && (
            <div className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-[1200] hidden w-64 -translate-x-1/2 whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white/98 p-2 text-[11px] leading-snug text-slate-700 shadow-2xl ring-1 ring-black/5 backdrop-blur group-hover:block dark:border-slate-700 dark:bg-slate-900/98 dark:text-slate-100">
                {data.label}
            </div>
        )}
        <Handle
            type="source"
            position={Position.Right}
            style={{ top: HANDLE_TOP, transform: 'translateY(-50%)' }}
            className="!-right-[5px] !h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-slate-500 !shadow-[0_1px_2px_rgba(15,23,42,0.35)] transition-transform hover:!scale-125 hover:!bg-slate-950 dark:!border-slate-800 dark:!bg-slate-400 dark:hover:!bg-slate-50"
        />
    </div>
);




export const StartNode = ({ id, selected }) => (
    <div
        className={`relative grid h-[58px] w-[156px] grid-cols-[42px_minmax(0,1fr)] overflow-visible rounded-[2px] border-2 border-slate-950 bg-slate-200 transition-shadow dark:border-slate-400 dark:bg-slate-800 ${
            selected ? 'shadow-[0_0_0_2px_rgba(15,23,42,0.3)] dark:border-slate-50 dark:shadow-[0_0_0_2px_rgba(248,250,252,0.4)]' : ''
        }`}
    >
        <div className="grid place-items-center bg-slate-950 font-mono text-[11px] font-black text-white dark:bg-slate-100 dark:text-slate-950">
            {'>'}
        </div>
        <div className="flex min-w-0 flex-col justify-center px-3 font-mono">
            <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-950 dark:text-slate-100">Início</span>
            <span className="text-[8px] uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Ponto de entrada</span>
        </div>
        <Handle
            type="source"
            position={Position.Right}
            id="default"
            style={{ top: HANDLE_TOP - 1, transform: 'translateY(-50%)' }}
            className="!-right-[5px] !h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-slate-500 !shadow-[0_1px_2px_rgba(15,23,42,0.35)] transition-transform hover:!scale-125 hover:!bg-slate-950 dark:!border-slate-800 dark:!bg-slate-400 dark:hover:!bg-slate-50"
        />
    </div>
);
export const EndNode = (props) => <CompactNode {...props} icon={Square} color="#ef4444" label="Fim" outputs={[]} />;
export const FinalNode = (props) => <CompactNode {...props} icon={Flag} color="#000" label="Finalizar" outputs={[]} />;

// As tres saidas sao fixas do sistema, nunca definidas pelo autor do subfluxo.
// E isso que impede que editar um subfluxo quebre o contrato dos fluxos pais.
export const SubflowNode = (props) => (
    // Saida unica no desenho: as tres rotas viram case nodes gerados na
    // configuracao, entao sai uma linha so que se divide.
    <CompactNode {...props} icon={Boxes} color="#155dfc" label="Subfluxo" />
);

/* Trilhos do editor de subfluxo. Barras verticais altas nas pontas, para o
 * desenho comunicar a regra sozinho: uma entrada, uma saida, e os nodes no meio.
 * Sao nodes do canvas (o ReactFlow nao permite fixar na borda de verdade), mas
 * o editor impede apagar, copiar e mover para fora. */
const RAIL_HEIGHT = 300;

const railDot = '!h-3 !w-3 !rounded-full !border-2 !border-white !bg-blue-600 !shadow-[0_1px_3px_rgba(15,23,42,0.45)] transition-transform hover:!scale-125 dark:!border-slate-900';

const SubflowRail = ({ label, hint, side, selected }) => (
    <div
        className={`relative grid w-[64px] place-items-center rounded-[3px] border-2 bg-blue-50 transition-shadow dark:bg-blue-950/40 ${
            selected ? 'border-blue-700 shadow-[0_0_0_2px_rgba(21,93,252,0.35)] dark:border-blue-300 dark:shadow-[0_0_0_2px_rgba(147,197,253,0.45)]' : 'border-blue-600 dark:border-blue-500'
        }`}
        style={{ height: RAIL_HEIGHT }}
        title={hint}
    >
        <span
            className="pointer-events-none font-mono text-[11px] font-black uppercase tracking-[0.28em] text-blue-800 dark:text-blue-300"
            style={{ writingMode: 'vertical-rl', transform: side === 'in' ? 'rotate(180deg)' : 'none' }}
        >
            {label}
        </span>

        {/* A entrada so tem saida; a saida so tem entrada. E a regra virando desenho. */}
        {side === 'in' ? (
            <Handle
                type="source"
                position={Position.Right}
                id="default"
                style={{ top: '50%', transform: 'translateY(-50%)' }}
                className={`!-right-[6px] ${railDot}`}
            />
        ) : (
            <Handle
                type="target"
                position={Position.Left}
                style={{ top: '50%', transform: 'translateY(-50%)' }}
                className={`!-left-[6px] ${railDot}`}
            />
        )}
    </div>
);

export const SubflowEntryNode = ({ selected }) => (
    <SubflowRail label="Entrada" hint="Onde o subfluxo comeca" side="in" selected={selected} />
);

export const SubflowReturnNode = ({ selected }) => (
    <SubflowRail label="Saída" hint="Devolve o controle ao fluxo pai" side="out" selected={selected} />
);

export const MessageNode = (props) => <CompactNode {...props} icon={MessageSquare} color="#3b82f6" label="Mensagem" />;
export const InputNode = (props) => {
    const hasInvalidBranch = props.data?.onFailBehavior === 'branch';
    const outputs = hasInvalidBranch
        ? [
            { id: 'default', label: 'Valido' },
            { id: 'invalid', label: 'Invalido' }
        ]
        : null;
    return <CompactNode {...props} icon={TextCursorInput} color="#f59e0b" label="Entrada" outputs={outputs} />;
};
export const HolderNode = (props) => <CompactNode {...props} icon={Hand} color="#b45309" label="Holder" />;
export const SetValueNode = (props) => <CompactNode {...props} icon={Database} color="#059669" label="Definir Var" />;
export const SecretNode = (props) => <CompactNode {...props} icon={Key} color="#c0c0c0" label="Secret" />;
export const ScriptNode = (props) => <CompactNode {...props} icon={Code} color="#475569" label="Script JS" />;
export const DelayNode = (props) => <CompactNode {...props} icon={Hourglass} color="#d97706" label="Delay" />;
// Ancora presa (sem entrada, ligada a um node so): etiqueta em cima do node,
// sem linha. A ligacao continua existindo para o motor; so nao e desenhada.
const DockedAnchor = ({ id, data, selected }) => (
    <div
        className={`flow-node-card flex h-[22px] max-w-[248px] cursor-pointer items-center gap-1.5 rounded-[3px] border bg-white px-2 dark:bg-slate-800 ${data?.disabled ? 'border-dashed opacity-45' : ''} ${
            selected
                ? 'border-slate-950 shadow-[0_0_0_2px_rgba(15,23,42,0.28)] dark:border-slate-50'
                : 'border-slate-400 hover:border-slate-950 dark:border-slate-600 dark:hover:border-slate-300'
        }`}
        title="Âncora: o &quot;Ir para&quot; salta para o node abaixo. Duplo clique para renomear."
        onDoubleClick={(e) => {
            e.stopPropagation();
            if (data.onConfig) data.onConfig(id);
        }}
    >
        <Anchor size={11} strokeWidth={2.25} className="shrink-0 text-slate-600 dark:text-slate-300" aria-hidden="true" />
        <span className="truncate font-mono text-[10px] font-bold text-slate-900 dark:text-slate-100">{data?.anchorName || 'sem nome'}</span>
        <Handle type="source" position={Position.Bottom} id="default" isConnectable={false} className="!pointer-events-none !opacity-0" />
    </div>
);

export const AnchorNode = (props) => (props.data?.__docked
    ? <DockedAnchor {...props} />
    : <CompactNode {...props} icon={Anchor} color="#db2777" label="Âncora" />);
export const GotoNode = (props) => <CompactNode {...props} icon={ArrowRight} color="#db2777" label="Ir Para" outputs={[]} />;
export const QueueNode = (props) => <CompactNode {...props} icon={Users} color="#ea580c" label="Fila" />;
export const RatingNode = (props) => (
    <CompactNode {...props} icon={Star} color="#fbbf24" label="Nota" />
);
export const CommandNode = (props) => (
    <CompactNode {...props} icon={Command} color="#0f766e" label="Comando" />
);
export const MediaNode = (props) => (
    <CompactNode {...props} icon={Image} color="#0ea5e9" label="Mídia" />
);
export const CatalogNode = (props) => (
    <CompactNode {...props} icon={Package} color="#8b5cf6" label="Catálogo" />
);
export const CartNode = (props) => (
    <CompactNode {...props} icon={ShoppingCart} color="#2563eb" label="Carrinho" />
);

export const HttpRequestNode = (props) => (
    // Saida unica: assim como o condicional, o HTTP gera dois case nodes
    // (Sucesso / Erro) no config, e a conexao unica se divide entre eles.
    // O runtime roteia por sourceHandle ('success'/'error') das arestas,
    // independente de o node desenhar handles nomeados.
    <CompactNode
        {...props}
        icon={props.data?.integrationId ? integrationIcon(props.data.integrationIcon) : Globe}
        color="#0891b2"
        label="API HTTP"
    />
);

export const ConditionNode = (props) => {



    return (
        <CompactNode
            {...props}
            icon={Split}
            color="#7c3aed"
            label="Condicional"
        />
    );
};

export const ScheduleNode = (props) => (
    <CompactNode
        {...props}
        icon={Clock}
        color="#16a34a"
        label="Horário"
        outputs={[{ id: 'source', label: '' }]}
    />
);

export const TemplateNode = (props) => {


    return (
        <CompactNode
            {...props}
            icon={FileText}
            color="#be185d"
            label="Template HSM"
            outputs={[{ id: 'source', label: '' }]}
        />
    );
};
export const WhatsAppTemplateNode = (props) => (
    <CompactNode
        {...props}
        icon={Smartphone}
        color="#22c55e"
        label="WTN"
        outputs={[{ id: 'default', label: '' }]}
    />
);
export const MenuNode = (props) => (
    <CompactNode {...props} icon={MenuIcon} color="#94a3b8" label="Menu" />
);
export const SequentialNode = (props) => (
    <CompactNode {...props} icon={Settings} color="#dc2626" label="Sequencial" />
);
