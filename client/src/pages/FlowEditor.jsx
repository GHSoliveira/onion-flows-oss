import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useMemo } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  MiniMap,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  reconnectEdge,
  ReactFlowProvider,
  useReactFlow,
  useViewport
} from 'reactflow';
import 'reactflow/dist/style.css';


import {
  MessageSquare, TextCursorInput, Split, FileText,
  Clock, Users, Code, Globe, Hourglass, Hand,
  Database, Anchor, Send, Save, Rocket, Circle,
  Flag, Play, RotateCcw, Star, Command, Image as ImageIcon, Package, Key, Menu as MenuIcon, Smartphone, Settings,
  Copy, Clipboard, Layers3, Trash2, Pencil, Eye, EyeOff, Minimize2, Maximize2, Map as MapIcon, Menu, MonitorPlay,
  Search, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Undo2, Redo2, AlertTriangle, Braces, X, Plug, Plus, Sparkles
} from 'lucide-react';

import { deleteJSON, getJSON, postJSON, putJSON } from '../services/api';
import toast from 'react-hot-toast';
import NodeConfigModal from '../components/NodeConfigModal';
import IntegrationsDrawer, { OPEN_INTEGRATIONS_EVENT } from '../components/IntegrationsDrawer';
import FlowSettingsPanel from '../components/FlowSettingsPanel';
import FlowAssistantPanel from '../components/FlowAssistantPanel';
import { applyAssistantOperations, describeOperations } from '../utils/flowAssistantApply';
import FlowProblemsPanel from '../components/FlowProblemsPanel';
import FlowVariablesPanel from '../components/FlowVariablesPanel';
import PublishDiffModal from '../components/PublishDiffModal';
import FlowTestPanel from '../components/FlowTestPanel';
import * as CustomNodes from '../nodes/CustomNodes';
import FlowEdge, { FlowConnectionLine } from '../edges/FlowEdge';
import { applyFlowLayout, computeFlowLayout, layoutWidth } from '../utils/flowLayout';
import { ANCHOR_DOCK_OFFSET, canDockAnchor, dockedAnchors, nextAnchorName } from '../utils/flowAnchors';
import { animate, motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { hasManagerPermission } from '../utils/managerPermissions';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import { useFlowHistory } from '../hooks/useFlowHistory';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { collectVariableUsage, lintFlow } from '../utils/flowLint';
import { diffFlowSnapshots } from '../utils/flowDiff';
import { instantiateFlowSnippet } from '../utils/flowSnippet';

function VisualBlockNode({ data, selected }) {
  const block = data?.block || {};
  const nodeCount = Array.isArray(block.nodeIds) ? block.nodeIds.length : 0;
  const height = block.collapsed ? Math.min(Number(block.bounds?.height || 90), 72) : Number(block.bounds?.height || 90);

  return (
    <div
      className={`relative rounded-[4px] border border-dashed transition-all duration-200 ${
        block.hidden
          ? 'bg-transparent'
          : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
      } ${
        selected ? 'ring-2 ring-slate-900/70 ring-offset-2 ring-offset-transparent dark:ring-slate-200/70' : ''
      }`}
      style={{
        width: Number(block.bounds?.width || 120),
        height,
        borderColor: block.color,
        background: block.hidden ? 'transparent' : block.color,
        opacity: block.hidden ? 1 : (selected ? Math.min(Number(block.opacity || 0.09) + 0.06, 0.28) : Number(block.opacity || 0.09))
      }}
    >
      <button
        type="button"
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!data?.readOnly) data?.onRename?.(block.id);
        }}
        className={`nodrag nopan absolute left-4 top-3 select-none rounded-[2px] px-2 py-1 text-left text-lg font-black uppercase tracking-[0.18em] transition-colors ${
          selected
            ? 'bg-slate-100/90 text-slate-800 dark:bg-slate-900/90 dark:text-slate-200'
            : 'text-slate-400/80 hover:bg-white/70 hover:text-slate-600 dark:text-slate-500/80 dark:hover:bg-slate-900/60 dark:hover:text-slate-300'
        }`}
        title="Duplo clique para renomear"
      >
        {block.title}
      </button>
      {block.note && !block.hidden && !block.collapsed && (
        <p className="pointer-events-none absolute left-6 right-6 top-14 whitespace-pre-wrap text-xs leading-relaxed text-slate-600/75 dark:text-slate-300/70">
          {block.note}
        </p>
      )}

      {selected && !data?.readOnly && (
        <div className="nodrag nopan absolute left-4 top-14 z-20 min-w-[220px] overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[5px_6px_0_rgba(15,23,42,0.16)] dark:bg-slate-900 animate-[nodeConfigPop_180ms_ease-out]">
          <div className="border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
            <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Bloco</p>
            <p className="truncate text-xs font-semibold text-slate-950 dark:text-slate-100">
              {nodeCount} nodes vinculados
            </p>
          </div>
          <div className="p-1">
            <SelectionActionButton icon={Copy} label="Copiar nodes internos" onClick={() => data?.onCopy?.(block.id)} />
            <SelectionActionButton icon={Clipboard} label="Duplicar bloco" onClick={() => data?.onDuplicate?.(block.id)} />
            <SelectionActionButton
              icon={block.hidden ? Eye : EyeOff}
              label={block.hidden ? 'Mostrar fundo' : 'Ocultar fundo'}
              onClick={() => data?.onToggleHidden?.(block.id)}
            />
            <SelectionActionButton
              icon={block.collapsed ? Maximize2 : Minimize2}
              label={block.collapsed ? 'Expandir bloco' : 'Colapsar bloco'}
              onClick={() => data?.onToggleCollapsed?.(block.id)}
            />
            <SelectionActionButton icon={Pencil} label="Renomear" onClick={() => data?.onRename?.(block.id)} />
            <SelectionActionButton icon={Trash2} label="Remover bloco sem nodes" onClick={() => data?.onRemove?.(block.id)} />
            <SelectionActionButton icon={Trash2} label="Apagar bloco e nodes" onClick={() => data?.onDeleteNodes?.(block.id)} danger />
          </div>
        </div>
      )}
    </div>
  );
}

const NODE_PALETTE_GROUPS = [
  {
    id: 'flow',
    label: 'Fluxo',
    nodes: [
      { type: 'finalNode', code: 'END', label: 'Finalizar', description: 'Encerra a execução do fluxo.' }
    ]
  },
  {
    id: 'chat',
    label: 'Conversa',
    nodes: [
      { type: 'messageNode', code: 'MSG', label: 'Mensagem', description: 'Envia uma mensagem ao cliente.' },
      { type: 'inputNode', code: 'IN', label: 'Entrada', description: 'Pergunta e salva a resposta.' },
      { type: 'holderNode', code: 'HLD', label: 'Holder', description: 'Mantém e agrupa mensagens.' },
      { type: 'menuNode', code: 'MNU', label: 'Menu', description: 'Apresenta opções de escolha.' },
      { type: 'mediaNode', code: 'MED', label: 'Mídia', description: 'Envia imagem, vídeo ou arquivo.' },
      { type: 'catalogNode', code: 'CAT', label: 'Catálogo', description: 'Apresenta itens do catálogo.' },
      { type: 'ratingNode', code: 'NPS', label: 'Nota', description: 'Solicita uma avaliação de 1 a 5.' },
      { type: 'templateNode', code: 'HSM', label: 'Template HSM', description: 'Envia um template configurado.' },
      { type: 'whatsappTemplateNode', code: 'WTN', label: 'WhatsApp Template', description: 'Envia conteúdo oficial do WhatsApp.' }
    ]
  },
  {
    id: 'control',
    label: 'Controle',
    nodes: [
      { type: 'conditionNode', code: 'IF', label: 'Condicional', description: 'Divide o fluxo por regras.' },
      { type: 'delayNode', code: 'DLY', label: 'Delay', description: 'Pausa a execução por um período.' },
      { type: 'scheduleNode', code: 'SCH', label: 'Horário', description: 'Valida uma janela de atendimento.' }
    ]
  },
  {
    id: 'data',
    label: 'Dados e integrações',
    nodes: [
      { type: 'setValueNode', code: 'SET', label: 'Definir variável', description: 'Grava um valor no contexto.' },
      { type: 'cartNode', code: 'CART', label: 'Carrinho', description: 'Acumula itens, quantidades e total.' },
      { type: 'secretNode', code: 'SEC', label: 'Secret', description: 'Lê uma credencial protegida.', adminOnly: true },
      { type: 'scriptNode', code: 'JS', label: 'Script JS', description: 'Executa lógica no sandbox.' },
      { type: 'commandNode', code: 'CMD', label: 'Comando', description: 'Dispara um comando interno.' },
      { type: 'httpRequestNode', code: 'HTTP', label: 'API HTTP', description: 'Faz uma requisição externa.' }
    ]
  },
  {
    id: 'routing',
    label: 'Roteamento',
    nodes: [
      { type: 'queueNode', code: 'ACD', label: 'Fila', description: 'Transfere para atendimento humano.' },
      { type: 'gotoNode', code: 'GOTO', label: 'Ir para', description: 'Salta para uma âncora.' },
      { type: 'subflowNode', code: 'SUB', label: 'Subfluxo', description: 'Executa um subfluxo reutilizavel.' }
    ]
  }
];

const NODE_TYPE_LABELS = {
  startNode: 'Início',
  caseNode: 'Saída',
  ...Object.fromEntries(NODE_PALETTE_GROUPS.flatMap((group) => group.nodes).map((node) => [node.type, node.label]))
};

const DISABLE_BLOCKED_NODE_TYPES = new Set([
  'startNode', 'conditionNode', 'menuNode', 'httpRequestNode',
  'scheduleNode', 'templateNode'
]);

const nodeTypes = {
  visualBlockNode: VisualBlockNode,
  startNode: CustomNodes.StartNode,
  endNode: CustomNodes.EndNode,
  messageNode: CustomNodes.MessageNode,
  inputNode: CustomNodes.InputNode,
  holderNode: CustomNodes.HolderNode,
  setValueNode: CustomNodes.SetValueNode,
  cartNode: CustomNodes.CartNode,
  secretNode: CustomNodes.SecretNode,
  conditionNode: CustomNodes.ConditionNode,
  anchorNode: CustomNodes.AnchorNode,
  gotoNode: CustomNodes.GotoNode,
  scriptNode: CustomNodes.ScriptNode,
  finalNode: CustomNodes.FinalNode,
  httpRequestNode: CustomNodes.HttpRequestNode,
  templateNode: CustomNodes.TemplateNode,
  whatsappTemplateNode: CustomNodes.WhatsAppTemplateNode,
  delayNode: CustomNodes.DelayNode,
  queueNode: CustomNodes.QueueNode,
  scheduleNode: CustomNodes.ScheduleNode,
  ratingNode: CustomNodes.RatingNode,
  commandNode: CustomNodes.CommandNode,
  mediaNode: CustomNodes.MediaNode,
  catalogNode: CustomNodes.CatalogNode,
  menuNode: CustomNodes.MenuNode,
  sequentialNode: CustomNodes.SequentialNode,
  caseNode: CustomNodes.CaseNode,
  subflowNode: CustomNodes.SubflowNode,
  subflowReturnNode: CustomNodes.SubflowReturnNode
};

// No editor de subfluxo o startNode vira o trilho de entrada. Mapa proprio para
// nao afetar o editor de fluxo normal.
const subflowNodeTypes = {
  ...nodeTypes,
  startNode: CustomNodes.SubflowEntryNode
};

const edgeTypes = {
  flowEdge: FlowEdge,
  // Arestas de ramificacao (menu/condicao/template) sao gravadas com type
  // 'default'/'smoothstep'. Mapeamos para o FlowEdge para que TODAS as conexoes
  // — inclusive as divisoes em case — usem o mesmo traçado reto em angulo.
  default: FlowEdge,
  smoothstep: FlowEdge
};

const cloneDeep = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

// Espelha SUBFLOW_FORBIDDEN_NODE_TYPES do backend: ancora e escopo do fluxo e
// subfluxo nao aninha.
const SUBFLOW_BLOCKED_TYPES = ['gotoNode', 'anchorNode', 'subflowNode'];

const START_NODE_ID = 'start';
// O trilho de saida do subfluxo e fixo como o de entrada: sem ele o subfluxo
// nunca devolve o controle ao fluxo pai.
const isProtectedNode = (node) => node?.id === START_NODE_ID
  || node?.type === 'startNode'
  || node?.type === 'subflowReturnNode';
const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 50;
const VISUAL_BLOCK_PADDING = 44;
const VISUAL_BLOCK_COLORS = ['#38bdf8', '#f97316', '#22c55e', '#eab308', '#ec4899', '#8b5cf6'];
const createStartNode = () => ({
  id: START_NODE_ID,
  type: 'startNode',
  position: { x: 100, y: 100 },
  data: { text: 'Início' }
});

const dedupeById = (items = []) => {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const id = String(item?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const formatConditionCaseLabel = (condition = {}) => {
  const value = String(condition?.value || '').trim() || 'Vazio';
  const operator = String(condition?.operator || '==').trim() || '==';

  if (operator === '==') {
    return value;
  }

  const operatorLabel = operator === 'contains' ? 'contém' : operator;
  return `${operatorLabel} ${value}`.trim();
};

const EDGE_HANDLE_LABELS = {
  success: 'OK',
  error: 'Erro',
  else: 'Else'
};

const compactEdgeLabel = (value) => {
  const label = String(value || '').trim();
  if (!label) return '';
  return label.length > 34 ? `${label.slice(0, 31)}...` : label;
};

const getEdgeLabel = (edge = {}, nodeById = new Map()) => {
  const sourceNode = nodeById.get(edge.source);
  const targetNode = nodeById.get(edge.target);
  const sourceHandle = String(edge.sourceHandle || '').trim();
  const targetLabel = String(targetNode?.data?.label || '').trim();

  if (targetNode?.type === 'caseNode' && targetLabel) {
    return compactEdgeLabel(targetLabel);
  }

  if (sourceNode?.type === 'conditionNode') {
    if (sourceHandle === 'else') return 'Else';
    const condition = (Array.isArray(sourceNode?.data?.conditions) ? sourceNode.data.conditions : [])
      .find((item) => String(item?.id) === sourceHandle);
    return compactEdgeLabel(formatConditionCaseLabel(condition));
  }

  if (sourceNode?.type === 'menuNode') {
    const option = (Array.isArray(sourceNode?.data?.options) ? sourceNode.data.options : [])
      .find((item) => String(item?.id) === sourceHandle);
    return compactEdgeLabel(option?.label || option?.value || EDGE_HANDLE_LABELS[sourceHandle]);
  }

  const button = (Array.isArray(sourceNode?.data?.buttons) ? sourceNode.data.buttons : [])
    .find((item) => String(item?.id || item?.payload || item?.value) === sourceHandle);
  if (button) return compactEdgeLabel(button.label || button.text || button.title || button.value);

  return compactEdgeLabel(EDGE_HANDLE_LABELS[sourceHandle]);
};

const getFlowEdgeTone = (edge = {}) => {
  const sourceHandle = String(edge.sourceHandle || '').trim().toLowerCase();
  if (sourceHandle === 'error') return 'error';
  if (sourceHandle === 'else') return 'muted';
  return 'default';
};

const buildActiveEdgeState = (selectedNodeId, graphEdges = []) => {
  if (!selectedNodeId) {
    return {
      selectedNodeId: null,
      edgeIds: new Set()
    };
  }

  const incomingByTarget = new Map();
  graphEdges.forEach((edge) => {
    if (!incomingByTarget.has(edge.target)) incomingByTarget.set(edge.target, []);
    incomingByTarget.get(edge.target).push(edge);
  });

  const edgeIds = new Set();
  const visitedNodes = new Set();
  const stack = [selectedNodeId];

  while (stack.length) {
    const nodeId = stack.pop();
    if (visitedNodes.has(nodeId)) continue;
    visitedNodes.add(nodeId);
    (incomingByTarget.get(nodeId) || []).forEach((edge) => {
      edgeIds.add(edge.id);
      if (edge.source) stack.push(edge.source);
    });
  }

  graphEdges
    .filter((edge) => edge.source === selectedNodeId)
    .forEach((edge) => edgeIds.add(edge.id));

  return {
    selectedNodeId,
    edgeIds
  };
};

const syncConditionCaseNodeLabels = (graphNodes = []) => {
  const labelsByNodeId = new Map();

  (Array.isArray(graphNodes) ? graphNodes : []).forEach((node) => {
    if (node?.type !== 'conditionNode') return;

    const conditions = Array.isArray(node?.data?.conditions) ? node.data.conditions : [];
    conditions.forEach((condition) => {
      labelsByNodeId.set(`child_${node.id}_${String(condition.id)}`, formatConditionCaseLabel(condition));
    });

    if (node?.data?.hasElse !== false) {
      labelsByNodeId.set(`child_${node.id}_else`, 'Else');
    }
  });

  return (Array.isArray(graphNodes) ? graphNodes : []).map((node) => {
    if (node?.type !== 'caseNode') return node;
    const nextLabel = labelsByNodeId.get(node.id);
    if (!nextLabel || node?.data?.label === nextLabel) return node;
    return {
      ...node,
      data: {
        ...node.data,
        label: nextLabel
      }
    };
  });
};

const getNodeBox = (node = {}) => {
  const width = Number(node.width || node.measured?.width || node.style?.width || DEFAULT_NODE_WIDTH);
  const height = Number(node.height || node.measured?.height || node.style?.height || DEFAULT_NODE_HEIGHT);
  return {
    x: Number(node.position?.x || 0),
    y: Number(node.position?.y || 0),
    width: Number.isFinite(width) ? width : DEFAULT_NODE_WIDTH,
    height: Number.isFinite(height) ? height : DEFAULT_NODE_HEIGHT
  };
};

const getNodesBounds = (items = []) => {
  const boxes = (Array.isArray(items) ? items : []).map(getNodeBox);
  if (!boxes.length) return null;

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    right,
    bottom,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2
  };
};

const normalizeVisualBlocks = (items = []) => (
  (Array.isArray(items) ? items : [])
    .map((block, index) => {
      const bounds = block?.bounds || {};
      const width = Number(bounds.width || 0);
      const height = Number(bounds.height || 0);
      const x = Number(bounds.x || 0);
      const y = Number(bounds.y || 0);
      return {
        id: String(block?.id || `block_${Date.now()}_${index}`),
        title: String(block?.title || '## Novo bloco').trim() || '## Novo bloco',
        note: String(block?.note || ''),
        color: String(block?.color || VISUAL_BLOCK_COLORS[index % VISUAL_BLOCK_COLORS.length]),
        opacity: Math.max(0.04, Math.min(0.22, Number(block?.opacity ?? 0.09))),
        bounds: {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          width: Math.max(120, Number.isFinite(width) ? width : 120),
          height: Math.max(90, Number.isFinite(height) ? height : 90)
        },
        nodeIds: Array.isArray(block?.nodeIds) ? block.nodeIds.map(String).filter(Boolean) : [],
        hidden: false,
        collapsed: false
      };
    })
);

// ignorePositions: no layout rigido a posicao e calculada pela estrutura, entao
// nao entra no historico nem no "alteracoes nao salvas" (a animacao do layout
// geraria passos de desfazer so de movimento).
const buildFlowHistorySnapshot = (nodes = [], edges = [], visualBlocks = [], sanitizeNodeData, { ignorePositions = false } = {}) => ({
  nodes: (Array.isArray(nodes) ? nodes : []).map((node) => {
    const persistentNode = { ...(node || {}) };
    const data = node?.data || {};
    if (ignorePositions) {
      delete persistentNode.position;
      delete persistentNode.width;
      delete persistentNode.height;
    }
    delete persistentNode.selected;
    delete persistentNode.dragging;
    delete persistentNode.resizing;
    delete persistentNode.measured;
    delete persistentNode.positionAbsolute;
    delete persistentNode.data;
    return {
      ...cloneDeep(persistentNode),
      data: sanitizeNodeData(data || {})
    };
  }),
  edges: (Array.isArray(edges) ? edges : []).map((edge) => {
    const persistentEdge = cloneDeep(edge || {});
    delete persistentEdge.selected;
    return persistentEdge;
  }),
  visualBlocks: normalizeVisualBlocks(visualBlocks).map((block) => {
    const copia = cloneDeep(block);
    if (ignorePositions) delete copia.bounds;
    return copia;
  })
});

const flowSnapshotKey = (snapshot) => JSON.stringify(snapshot);

// Tipos que nao tem "proximo" pelo +: terminam o fluxo, saltam, ou criam as
// proprias saidas (ramos) pela configuracao.
const NO_NEXT_NODE_TYPES = new Set([
  'gotoNode', 'endNode', 'finalNode', 'conditionNode', 'httpRequestNode',
  'subflowNode', 'templateNode', 'scheduleNode'
]);

const canAddNextNode = (node, edges) => {
  if (!node || String(node.id || '').startsWith('visual_block_')) return false;
  if (NO_NEXT_NODE_TYPES.has(node.type)) return false;
  if (node.type === 'menuNode' && node.data?.createBranches !== false) return false;
  if (node.type === 'inputNode' && node.data?.onFailBehavior === 'branch') return false;
  return !edges.some((edge) => edge.source === node.id);
};

// Layout rigido vale para fluxos; subfluxo (trilhos nas pontas) continua com
// arrasto livre.
const usesRigidLayout = (isSubflow) => !isSubflow;

// Blocos visuais acompanham os nodes que agrupam.
const fitVisualBlocksToNodes = (blocks, nodes) => {
  let mudou = false;
  const proximos = blocks.map((block) => {
    const ids = new Set(Array.isArray(block.nodeIds) ? block.nodeIds : []);
    const membros = nodes.filter((node) => ids.has(node.id));
    if (!membros.length) return block;
    const caixa = getNodesBounds(membros);
    if (!caixa) return block;
    const bounds = {
      x: caixa.x - VISUAL_BLOCK_PADDING,
      y: caixa.y - VISUAL_BLOCK_PADDING,
      width: caixa.width + VISUAL_BLOCK_PADDING * 2,
      height: caixa.height + VISUAL_BLOCK_PADDING * 2
    };
    const atual = block.bounds || {};
    if (['x', 'y', 'width', 'height'].every((chave) => Math.round(Number(atual[chave])) === Math.round(bounds[chave]))) return block;
    mudou = true;
    return { ...block, bounds };
  });
  return mudou ? proximos : blocks;
};

// Dados iniciais de cada tipo de node (paleta, botao + e assistente de IA).
const defaultNodeData = (type) => ({
    text: '...',
    conditions: [],
    mappings: [],
    customName: '',
    ...(type === 'catalogNode'
      ? { sourceType: 'catalog', limit: 5, title: 'Selecione um item:', varPrefix: 'PRODUTO', showButtons: true, itemIds: [], items: [] }
      : {}),
    ...(type === 'mediaNode'
      ? { mediaType: 'image', mediaUrl: '', caption: '', fileName: '' }
      : {})
    ,
    ...(type === 'cartNode'
      ? {
        operation: 'add',
        productIdVar: 'PEDIDO_ID',
        productNameVar: 'PEDIDO',
        quantityVar: 'QUANTIDADE',
        priceSource: 'map',
        unitPriceVar: 'PRODUTO_PRECO',
        priceMap: [],
        mergeDuplicates: true,
        currency: 'BRL',
        itemsVar: 'CARRINHO_ITENS',
        totalVar: 'CARRINHO_TOTAL',
        itemCountVar: 'CARRINHO_QUANTIDADE',
        summaryVar: 'CARRINHO_RESUMO',
        okVar: 'CARRINHO_OK',
        errorVar: 'CARRINHO_ERRO'
      }
      : {}),
    ...(type === 'menuNode'
      ? {
        text: 'Escolha uma opção:',
        optionsDisplay: 'auto',
        options: [
          { id: '1', label: 'Opção 1', value: '1' },
          { id: '2', label: 'Opção 2', value: '2' }
        ],
        setVarEnabled: false,
        variableName: '',
        invalidSelectionMessage: 'Selecione uma opção válida.',
        hasElse: true,
        timeoutMinutes: 0,
        timeoutMessage: ''
      }
      : {}),
    ...(type === 'sequentialNode'
      ? {
        steps: [
          { id: 'step_1', type: 'message', text: 'Vamos iniciar o formulario.' },
          { id: 'step_2', type: 'input', text: 'Qual o seu nome?', variableName: '' }
        ],
        timeoutMinutes: 0,
        timeoutMessage: ''
      }
      : {}),
    ...(type === 'inputNode'
      ? {
        timeoutMinutes: 0,
        timeoutMessage: '',
        validationType: 'none',
        validationPattern: '',
        errorText: '',
        maxAttempts: 0,
        onFailBehavior: 'repeat'
      }
      : {}),
    ...(type === 'holderNode'
      ? {
        text: '',
        saveMessages: true,
        lastMessageVar: 'HOLDER_LAST',
        listVar: 'HOLDER_MESSAGES',
        textVar: 'HOLDER_TEXT',
        countVar: 'HOLDER_COUNT',
        fallbackText: '',
        fallbackOnce: true,
        exitKeywords: '',
        timeoutMinutes: 0,
        timeoutMessage: ''
      }
      : {}),
    ...(type === 'ratingNode'
      ? { timeoutMinutes: 0, timeoutMessage: '' }
      : {}),
    ...(type === 'whatsappTemplateNode'
      ? {
        contentKind: 'template',
        whatsappTemplateId: '',
        interactiveTemplateId: '',
        senderPhoneNumberId: '',
        waitForReply: true,
        nonWhatsappAction: 'skip',
        fallbackText: '',
        saveResponseTextVar: '',
        saveResponsePayloadVar: '',
        saveButtonTextVar: '',
        headerMappings: [],
        bodyMappings: [],
        buttonMappings: {},
        headerMediaMapping: { mode: 'fixed', value: '' }
      }
      : {}),
});

const toScreenPoint = (point, viewport) => ({
  x: viewport.x + point.x * viewport.zoom,
  y: viewport.y + point.y * viewport.zoom
});

const FlowEditor = ({ mode = 'flow', embedded = false, subflowId = null, onDirtyChange = null }) => {
  // Embutido na biblioteca nao ha parametro de rota: o id vem por prop.
  const { id: routeId } = useParams();
  const id = subflowId || routeId;
  // Modo subfluxo reaproveita todo o editor: muda a rota da API, a paleta e os
  // trilhos fixos de entrada e saida. O canvas, undo e validacao vem de graca.
  const isSubflow = mode === 'subflow';
  const apiBase = isSubflow ? '/subflows' : '/flows';
  const { getNodes, getViewport, fitView, setCenter, screenToFlowPosition } = useReactFlow();
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { confirm } = useDialog();
  const isManager = user?.role === 'MANAGER';
  // Gestor sem a permissao "fluxos" abre o fluxo so para ver: sem salvar,
  // publicar, testar, arrastar ou adicionar nodes.
  const readOnly = !hasManagerPermission(user, 'fluxos');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const toolbarScrollRef = useRef(null);
  const toolbarTrackRef = useRef(null);
  const toolbarDragRef = useRef({
    active: false,
    startClientX: 0,
    startOffset: 0
  });
  const copiedSelectionRef = useRef(null);
  const pasteCountRef = useRef(0);
  const visualBlockDragRef = useRef(null);
  const supportDataPromisesRef = useRef({
    catalog: null,
    media: null,
    whatsapp: null
  });
  const supportDataCacheRef = useRef({
    catalog: null,
    media: null,
    whatsapp: null
  });
  const loadedFlowIdRef = useRef(null);
  const autosaveFailureNotifiedRef = useRef(false);
  const saveInFlightRef = useRef(false);


  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {

    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const [nodes, setNodes] = useState([]);
  const [visualBlocks, setVisualBlocks] = useState([]);
  const [visualBlockModal, setVisualBlockModal] = useState({
    open: false,
    mode: 'create',
    title: '',
    blockId: null,
    blockDraft: null
  });
  const [selectedVisualBlockId, setSelectedVisualBlockId] = useState(null);
  const [selectionActionsOpen, setSelectionActionsOpen] = useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(true);
  // Dica de navegacao do canvas: botao direito arrasta, que nao e obvio de
  // primeira. Some de vez quando a pessoa fecha.
  const [showCanvasHint, setShowCanvasHint] = useState(() => {
    try { return localStorage.getItem('flowCanvasHintDismissed') !== '1'; } catch { return true; }
  });
  const dismissCanvasHint = () => {
    setShowCanvasHint(false);
    try { localStorage.setItem('flowCanvasHintDismissed', '1'); } catch { /* sem storage, so esconde */ }
  };
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantIntegrationsRef = useRef([]);

  // O node HTTP pede para abrir as integracoes (link "Gerenciar").
  useEffect(() => {
    const abrir = () => { setFlowSettingsOpen(false); setIntegrationsOpen(true); };
    window.addEventListener(OPEN_INTEGRATIONS_EVENT, abrir);
    return () => window.removeEventListener(OPEN_INTEGRATIONS_EVENT, abrir);
  }, []);
  const [quickCreate, setQuickCreate] = useState(null);
  const [canvasSearch, setCanvasSearch] = useState({ open: false, query: '', index: 0 });
  const [serverProblems, setServerProblems] = useState([]);
  const [publishedSnapshot, setPublishedSnapshot] = useState(null);
  const [publishDiffOpen, setPublishDiffOpen] = useState(false);
  const [flowSnippets, setFlowSnippets] = useState([]);
  const [subflows, setSubflows] = useState([]);
  const [snippetModal, setSnippetModal] = useState({ open: false, name: '' });
  const [flowTest, setFlowTest] = useState({ open: false, busy: false, session: null });
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const hoverTimerRef = useRef(null);
  // Ancoras presas (ancoraId -> node), para apagar junto com o node delas.
  const presasRef = useRef(new Map());
  const [queues, setQueues] = useState([]);
  const [catalogItems, setCatalogItems] = useState([]);
  const [mediaAssets, setMediaAssets] = useState([]);
  const [edges, setEdges] = useState([]);
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [persistedSnapshotKey, setPersistedSnapshotKey] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [vars, setVars] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [whatsappTemplates, setWhatsappTemplates] = useState([]);
  const [whatsappInteractiveTemplates, setWhatsappInteractiveTemplates] = useState([]);
  const [whatsappSenderOptions, setWhatsappSenderOptions] = useState([]);
  const [whatsappChannelReady, setWhatsappChannelReady] = useState(false);
  const [whatsappDataLoading, setWhatsappDataLoading] = useState(false);
  const [whatsappDataError, setWhatsappDataError] = useState('');
  const [whatsappDataLoaded, setWhatsappDataLoaded] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [flowName, setFlowName] = useState('');
  const [configModal, setConfigModal] = useState({ open: false, nodeId: null });
  const [flowSettingsOpen, setFlowSettingsOpen] = useState(false);
  const [flowMeta, setFlowMeta] = useState({});
  const [inactivityModalOpen, setInactivityModalOpen] = useState(false);
  const [inactivityConfig, setInactivityConfig] = useState({
    inactivityMaxHours: 8,
    inactivityMessage: 'Atendimento encerrado por inatividade.'
  });
  const [inactivitySaving, setInactivitySaving] = useState(false);
  const [toolbarScrollbar, setToolbarScrollbar] = useState({
    visible: false,
    thumbWidth: 0,
    thumbOffset: 0
  });

  useEffect(() => {
    const currentFlowName = String(flowName || '').trim() || 'Editor de Fluxo';
    const currentTenantName = String(tenant?.name || '').trim() || 'Onion Flows';
    document.title = `${currentFlowName} - ${currentTenantName}`;
  }, [flowName, tenant?.name]);

  const ensureCatalogItems = useCallback(async () => {
    if (supportDataCacheRef.current.catalog) {
      return supportDataCacheRef.current.catalog;
    }
    if (supportDataPromisesRef.current.catalog) {
      return supportDataPromisesRef.current.catalog;
    }

    supportDataPromisesRef.current.catalog = getJSON('/catalog/items?active=all&limit=500')
      .then((data) => {
        const nextItems = Array.isArray(data) ? data : (data?.items || []);
        supportDataCacheRef.current.catalog = nextItems;
        setCatalogItems(nextItems);
        return nextItems;
      })
      .catch((error) => {
        console.error(error);
        return [];
      })
      .finally(() => {
        supportDataPromisesRef.current.catalog = null;
      });

    return supportDataPromisesRef.current.catalog;
  }, []);

  const ensureMediaAssets = useCallback(async () => {
    if (supportDataCacheRef.current.media) {
      return supportDataCacheRef.current.media;
    }
    if (supportDataPromisesRef.current.media) {
      return supportDataPromisesRef.current.media;
    }

    supportDataPromisesRef.current.media = getJSON('/media/assets?limit=500')
      .then((data) => {
        const nextAssets = Array.isArray(data) ? data : (data?.items || []);
        supportDataCacheRef.current.media = nextAssets;
        setMediaAssets(nextAssets);
        return nextAssets;
      })
      .catch((error) => {
        console.error(error);
        return [];
      })
      .finally(() => {
        supportDataPromisesRef.current.media = null;
      });

    return supportDataPromisesRef.current.media;
  }, []);

  const ensureWhatsAppEditorData = useCallback(async () => {
    if (supportDataCacheRef.current.whatsapp) {
      return supportDataCacheRef.current.whatsapp;
    }
    if (supportDataPromisesRef.current.whatsapp) {
      return supportDataPromisesRef.current.whatsapp;
    }

    setWhatsappDataLoading(true);
    setWhatsappDataError('');

    supportDataPromisesRef.current.whatsapp = Promise.allSettled([
      getJSON('/templates/whatsapp'),
      getJSON('/templates/whatsapp/interactive')
    ])
      .then(([templateResult, interactiveResult]) => {
        const templateData = templateResult.status === 'fulfilled' ? templateResult.value : { items: [], channelConfig: {} };
        const interactiveData = interactiveResult.status === 'fulfilled' ? interactiveResult.value : { items: [] };
        const approvedTemplates = Array.isArray(templateData?.items) ? templateData.items : [];
        const interactiveTemplates = Array.isArray(interactiveData?.items) ? interactiveData.items : [];
        const failures = [templateResult, interactiveResult]
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason?.message || 'Falha desconhecida');

        setWhatsappTemplates(approvedTemplates);
        setWhatsappInteractiveTemplates(interactiveTemplates);
        setWhatsappSenderOptions(Array.isArray(templateData?.channelConfig?.senderNumbers) ? templateData.channelConfig.senderNumbers : []);
        setWhatsappChannelReady(Boolean(templateData?.channelConfig?.ready));
        setWhatsappDataLoaded(failures.length === 0);
        setWhatsappDataError(failures.length > 0
          ? `Não foi possível carregar todos os dados do WhatsApp: ${failures.join(' | ')}`
          : '');
        const nextWhatsAppData = {
          templates: approvedTemplates,
          interactive: interactiveTemplates
        };
        if (failures.length === 0) {
          supportDataCacheRef.current.whatsapp = nextWhatsAppData;
        }
        return nextWhatsAppData;
      })
      .catch((error) => {
        console.error(error);
        setWhatsappDataLoaded(false);
        setWhatsappDataError(error?.message || 'Falha ao carregar os dados do WhatsApp.');
        return { templates: [], interactive: [] };
      })
      .finally(() => {
        setWhatsappDataLoading(false);
        supportDataPromisesRef.current.whatsapp = null;
      });

    return supportDataPromisesRef.current.whatsapp;
  }, []);

  const updateToolbarScrollbar = useCallback(() => {
    const element = toolbarScrollRef.current;
    if (!element) return;

    const { clientWidth, scrollWidth, scrollLeft } = element;
    const hasOverflow = scrollWidth - clientWidth > 1;

    if (!hasOverflow) {
      setToolbarScrollbar((current) => (
        current.visible || current.thumbWidth || current.thumbOffset
          ? { visible: false, thumbWidth: 0, thumbOffset: 0 }
          : current
      ));
      return;
    }

    const rawThumbWidth = (clientWidth / scrollWidth) * clientWidth;
    const thumbWidth = Math.max(40, Math.min(clientWidth, rawThumbWidth));
    const maxScroll = Math.max(scrollWidth - clientWidth, 1);
    const maxOffset = Math.max(clientWidth - thumbWidth, 0);
    const thumbOffset = (scrollLeft / maxScroll) * maxOffset;

    setToolbarScrollbar((current) => {
      const sameWidth = Math.abs(current.thumbWidth - thumbWidth) < 0.5;
      const sameOffset = Math.abs(current.thumbOffset - thumbOffset) < 0.5;
      if (current.visible && sameWidth && sameOffset) {
        return current;
      }
      return { visible: true, thumbWidth, thumbOffset };
    });
  }, []);

  const scrollToolbarToThumbOffset = useCallback((nextThumbOffset) => {
    const element = toolbarScrollRef.current;
    const track = toolbarTrackRef.current;
    if (!element || !track) return;

    const trackWidth = track.clientWidth;
    const maxScroll = Math.max(element.scrollWidth - element.clientWidth, 0);
    const maxOffset = Math.max(trackWidth - toolbarScrollbar.thumbWidth, 0);

    if (maxScroll <= 0 || maxOffset <= 0) {
      element.scrollLeft = 0;
      return;
    }

    const clampedOffset = Math.min(Math.max(nextThumbOffset, 0), maxOffset);
    element.scrollLeft = (clampedOffset / maxOffset) * maxScroll;
  }, [toolbarScrollbar.thumbWidth]);

  const handleToolbarWheel = useCallback((event) => {
    const element = toolbarScrollRef.current;
    if (!element) return;

    const hasOverflow = element.scrollWidth - element.clientWidth > 1;
    if (!hasOverflow) return;

    const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (primaryDelta === 0) return;

    event.preventDefault();
    element.scrollLeft += primaryDelta;
  }, []);

  const stopToolbarDrag = useCallback(() => {
    if (!toolbarDragRef.current.active) return;
    toolbarDragRef.current.active = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  const handleToolbarThumbPointerDown = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();

    toolbarDragRef.current = {
      active: true,
      startClientX: event.clientX,
      startOffset: toolbarScrollbar.thumbOffset
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }, [toolbarScrollbar.thumbOffset]);

  const handleToolbarTrackPointerDown = useCallback((event) => {
    if (event.target !== event.currentTarget) return;

    const track = toolbarTrackRef.current;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const targetOffset = event.clientX - rect.left - (toolbarScrollbar.thumbWidth / 2);
    scrollToolbarToThumbOffset(targetOffset);

    toolbarDragRef.current = {
      active: true,
      startClientX: event.clientX,
      startOffset: Math.min(
        Math.max(targetOffset, 0),
        Math.max(track.clientWidth - toolbarScrollbar.thumbWidth, 0)
      )
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }, [scrollToolbarToThumbOffset, toolbarScrollbar.thumbWidth]);

  useEffect(() => {
    const element = toolbarScrollRef.current;
    if (!element) return undefined;

    const scheduleUpdate = () => {
      window.requestAnimationFrame(updateToolbarScrollbar);
    };

    scheduleUpdate();
    element.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleUpdate)
      : null;

    resizeObserver?.observe(element);

    return () => {
      element.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [isManager, updateToolbarScrollbar]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!toolbarDragRef.current.active) return;
      const deltaX = event.clientX - toolbarDragRef.current.startClientX;
      scrollToolbarToThumbOffset(toolbarDragRef.current.startOffset + deltaX);
    };

    const handlePointerUp = () => {
      stopToolbarDrag();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      stopToolbarDrag();
    };
  }, [scrollToolbarToThumbOffset, stopToolbarDrag]);

  const openConfig = useCallback((nodeId) => {

    const currentNode = getNodes().find(n => n.id === nodeId);
    if (currentNode) {
      if (user?.role === 'MANAGER' && currentNode.type === 'secretNode') {
        toast.error("Você não tem permissão para acessar Secrets.");
        return;
      }
      if (currentNode.type === 'catalogNode') {
        ensureCatalogItems();
      }
      if (currentNode.type === 'mediaNode') {
        ensureMediaAssets();
      }
      if (currentNode.type === 'whatsappTemplateNode') {
        ensureWhatsAppEditorData();
      }
      setFlowSettingsOpen(false);
      setConfigModal({ open: true, nodeId });
    }
  }, [ensureCatalogItems, ensureMediaAssets, ensureWhatsAppEditorData, getNodes, isSuperAdmin, user?.role]);

  const updateNodeData = useCallback((nodeId, newData) => {
    setNodes((nds) => nds.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, ...newData } } : n));
  }, []);

  const deleteNode = useCallback((nodeId) => {
    const alvo = nodes.find((item) => item.id === nodeId);
    if (isProtectedNode(alvo)) return toast.error("Este node e fixo e nao pode ser removido.");
    // A ancora presa no node sai junto: sozinha ela viraria um node solto.
    const ancoras = [...presasRef.current].filter(([, alvo]) => alvo === nodeId).map(([ancora]) => ancora);
    setNodes((nds) => nds.filter((n) => n.id !== nodeId && !n.id.startsWith(`child_${nodeId}`) && !ancoras.includes(n.id)));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId && !ancoras.includes(e.source)));
  }, []);

  const hydrateNode = useCallback((node, vData, tData, sData) => {
    const baseData = node?.data || {};

    return {
      ...node,
      data: {
        ...baseData,
        availableVars: vData,
        availableTemplates: tData,
        availableSchedules: sData,
        onDelete: readOnly ? null : deleteNode,
        onConfig: (id) => openConfig(id),
        onChange: readOnly ? undefined : (v) => updateNodeData(node.id, { text: v })
      }
    };
  }, [deleteNode, openConfig, readOnly, updateNodeData]);

  const sanitizeNodeData = useCallback((data = {}) => {
    const {
      availableVars,
      availableTemplates,
      availableSchedules,
      onDelete,
      onConfig,
      onChange,
      __docked,
      ...cleanData
    } = data;

    return cloneDeep(cleanData);
  }, []);

  const normalizeGraphStructure = useCallback((graphNodes = [], graphEdges = []) => {
    const dedupedNodes = dedupeById(graphNodes);
    const nodesWithStart = dedupedNodes.some((node) => node.id === START_NODE_ID)
      ? dedupedNodes
      : [createStartNode(), ...dedupedNodes];
    const normalizedNodes = syncConditionCaseNodeLabels(nodesWithStart);
    const validNodeIds = new Set(normalizedNodes.map((node) => node.id));
    const normalizedEdges = dedupeById(graphEdges)
      .filter((edge) => validNodeIds.has(edge.source) && validNodeIds.has(edge.target));

    return {
      nodes: normalizedNodes,
      edges: normalizedEdges
    };
  }, []);

  const historySnapshot = useMemo(
    () => buildFlowHistorySnapshot(nodes, edges, visualBlocks, sanitizeNodeData, { ignorePositions: usesRigidLayout(isSubflow) }),
    [edges, isSubflow, nodes, sanitizeNodeData, visualBlocks]
  );

  const restoreFlowHistory = useCallback((snapshot) => {
    const snapshotNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const snapshotStart = snapshotNodes.find(
      (node) => node?.id === START_NODE_ID && node?.type === 'startNode'
    );
    const safeNodes = [
      snapshotStart || createStartNode(),
      ...snapshotNodes.filter(
        (node) => node?.id !== START_NODE_ID && node?.type !== 'startNode'
      )
    ];
    const normalizedGraph = normalizeGraphStructure(safeNodes, snapshot?.edges || []);

    let restoredNodes = normalizedGraph.nodes.map((node) => hydrateNode(node, vars, templates, schedules));
    let restoredBlocks = normalizeVisualBlocks(snapshot?.visualBlocks || []);
    if (usesRigidLayout(isSubflow)) {
      // O historico guarda so a estrutura: parte do lugar atual de cada node
      // (mantem a ordem dos ramos) e recalcula o layout.
      const lugarAtual = new Map(getNodes().map((node) => [node.id, node.position]));
      restoredNodes = applyFlowLayout(
        restoredNodes.map((node) => ({ ...node, position: lugarAtual.get(node.id) || node.position || { x: 0, y: 0 } })),
        normalizedGraph.edges,
        { startId: START_NODE_ID }
      );
      restoredBlocks = fitVisualBlocksToNodes(restoredBlocks, restoredNodes);
    }
    setNodes(restoredNodes);
    setEdges(normalizedGraph.edges);
    setVisualBlocks(restoredBlocks);
    setSelectedVisualBlockId(null);
    setSelectionActionsOpen(false);
  }, [getNodes, hydrateNode, isSubflow, normalizeGraphStructure, schedules, templates, vars]);

  const flowHistory = useFlowHistory({
    snapshot: historySnapshot,
    enabled: historyEnabled,
    limit: 50,
    debounceMs: 400,
    onRestore: restoreFlowHistory
  });

  const currentSnapshotKey = useMemo(() => flowSnapshotKey(historySnapshot), [historySnapshot]);
  const isDirty = persistedSnapshotKey !== null && currentSnapshotKey !== persistedSnapshotKey;
  const lintProblems = useMemo(
    () => lintFlow({ nodes, edges, variables: vars }),
    [edges, nodes, vars]
  );
  const flowProblems = useMemo(
    () => [...lintProblems, ...serverProblems],
    [lintProblems, serverProblems]
  );
  const variableUsage = useMemo(
    () => collectVariableUsage({ nodes, variables: vars }),
    [nodes, vars]
  );

  const flowProblemCounts = useMemo(() => flowProblems.reduce((summary, problem) => {
    if (problem.severity === 'error') summary.errors += 1;
    if (problem.severity === 'warning') summary.warnings += 1;
    return summary;
  }, { errors: 0, warnings: 0 }), [flowProblems]);

  useEffect(() => {
    if (flowProblems.length === 0) setProblemsOpen(false);
  }, [flowProblems.length]);

  useEffect(() => {
    setServerProblems([]);
  }, [currentSnapshotKey]);

  useUnsavedChangesGuard({ when: isDirty, confirm });

  // Embutido, quem controla o fechamento e a janela: avisa o pai sobre alteracao
  // pendente para ele poder confirmar antes de fechar.
  useEffect(() => {
    if (typeof onDirtyChange === 'function') onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const focusProblemNode = useCallback((problem) => {
    if (!problem?.nodeId) return;
    const node = nodes.find((item) => item.id === problem.nodeId);
    if (!node) return;

    setNodes((currentNodes) => currentNodes.map((item) => ({
      ...item,
      selected: item.id === problem.nodeId
    })));
    setSelectedVisualBlockId(null);
    setSelectionActionsOpen(false);

    const width = Number(node.measured?.width || node.width || 220);
    const height = Number(node.measured?.height || node.height || 50);
    setCenter(
      Number(node.position?.x || 0) + width / 2,
      Number(node.position?.y || 0) + height / 2,
      { zoom: 1.18, duration: 480 }
    );
  }, [nodes, setCenter]);

  const getSelectedNodes = useCallback(() => nodes.filter((node) => node.selected), [nodes]);

  const copyNodesToClipboard = useCallback((selectedNodes = [], options = {}) => {
    const nodesToCopy = (Array.isArray(selectedNodes) ? selectedNodes : [])
      .filter((node) => node && !isProtectedNode(node));

    if (!nodesToCopy.length) {
      if (options.showStartError) {
        toast.error('O no de inicio nao pode ser copiado.');
      }
      return false;
    }

    const selectedIds = new Set(nodesToCopy.map((node) => node.id));
    const originX = Math.min(...nodesToCopy.map((node) => node.position.x));
    const originY = Math.min(...nodesToCopy.map((node) => node.position.y));

    const copiedNodes = nodesToCopy.map((node) => {
      const {
        data,
        selected,
        dragging,
        positionAbsolute,
        measured,
        hidden,
        ...rest
      } = node;

      return {
        ...cloneDeep(rest),
        id: node.id,
        position: {
          x: node.position.x - originX,
          y: node.position.y - originY
        },
        data: sanitizeNodeData(data)
      };
    });

    const copiedEdges = edges
      .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      .map(({ selected, hidden, ...edge }) => cloneDeep(edge));

    copiedSelectionRef.current = {
      origin: { x: originX, y: originY },
      nodes: copiedNodes,
      edges: copiedEdges
    };
    pasteCountRef.current = 0;

    if (options.toast !== false) {
      toast.success(
        nodesToCopy.length > 1
          ? `${nodesToCopy.length} nos copiados`
          : 'No copiado'
      );
    }

    return {
      nodeIds: nodesToCopy.map((node) => node.id),
      origin: { x: originX, y: originY }
    };
  }, [edges, sanitizeNodeData]);

  const createVisualBlockFromSelection = useCallback(() => {
    const selectedNodes = getSelectedNodes().filter((node) => node.id !== START_NODE_ID);
    if (!selectedNodes.length) {
      toast.error('Selecione ao menos um no alem do inicio.');
      return false;
    }

    const bounds = getNodesBounds(selectedNodes);
    if (!bounds) return false;

    const blockIndex = visualBlocks.length;
    const blockDraft = {
      id: `block_${Date.now()}`,
      title: '## Comandos',
      color: VISUAL_BLOCK_COLORS[blockIndex % VISUAL_BLOCK_COLORS.length],
      opacity: 0.09,
      bounds: {
        x: bounds.x - VISUAL_BLOCK_PADDING,
        y: bounds.y - VISUAL_BLOCK_PADDING,
        width: bounds.width + VISUAL_BLOCK_PADDING * 2,
        height: bounds.height + VISUAL_BLOCK_PADDING * 2
      },
      nodeIds: selectedNodes.map((node) => node.id)
    };

    setVisualBlockModal({
      open: true,
      mode: 'create',
      title: 'Comandos',
      note: '',
      blockId: null,
      blockDraft
    });
    setSelectionActionsOpen(false);
    return true;
  }, [getSelectedNodes, visualBlocks.length]);

  const deleteSelectedNodes = useCallback(() => {
    const selectedNodes = getSelectedNodes();
    const removableIds = new Set(selectedNodes.filter((node) => !isProtectedNode(node)).map((node) => node.id));
    if (!removableIds.size) {
      if (selectedNodes.some((node) => node.id === START_NODE_ID)) {
        toast.error('O no de inicio e protegido.');
      }
      return false;
    }

    const shouldRemoveNode = (node) => (
      removableIds.has(node.id)
      || [...removableIds].some((id) => node.id.startsWith(`child_${id}`))
    );

    setNodes((current) => current.filter((node) => !shouldRemoveNode(node)));
    setEdges((current) => current.filter((edge) => !removableIds.has(edge.source) && !removableIds.has(edge.target)));
    setVisualBlocks((current) => current.map((block) => ({
      ...block,
      nodeIds: block.nodeIds.filter((nodeId) => !removableIds.has(nodeId))
    })));
    setSelectionActionsOpen(false);
    toast.success(removableIds.size > 1 ? `${removableIds.size} nos removidos` : 'No removido');
    return true;
  }, [getSelectedNodes]);

  const copySelectedNodes = useCallback(() => {
    const selectedNodes = nodes.filter((node) => node.selected && node.id !== START_NODE_ID);

    if (!selectedNodes.length) {
      if (nodes.some((node) => node.selected && node.id === START_NODE_ID)) {
        toast.error('O no de inicio nao pode ser copiado.');
      }
      return false;
    }

    return Boolean(copyNodesToClipboard(selectedNodes));
  }, [copyNodesToClipboard, nodes]);

  const pasteCopiedNodes = useCallback(() => {
    const clipboard = copiedSelectionRef.current;
    if (!clipboard?.nodes?.length) {
      return false;
    }

    const pasteIndex = pasteCountRef.current + 1;
    const offset = 40 * pasteIndex;
    const timestamp = Date.now();
    const idMap = new Map();

    const newNodes = clipboard.nodes.map((node, index) => {
      const newId = `${node.type}_${timestamp}_${index}`;
      idMap.set(node.id, newId);

      return hydrateNode({
        ...cloneDeep(node),
        id: newId,
        selected: true,
        dragging: false,
        position: {
          x: clipboard.origin.x + node.position.x + offset,
          y: clipboard.origin.y + node.position.y + offset
        },
        data: sanitizeNodeData(node.data)
      }, vars, templates, schedules);
    });

    const newEdges = clipboard.edges
      .map((edge, index) => {
        const source = idMap.get(edge.source);
        const target = idMap.get(edge.target);
        if (!source || !target) return null;

        return {
          ...cloneDeep(edge),
          id: `edge_copy_${timestamp}_${index}`,
          source,
          target,
          selected: false
        };
      })
      .filter(Boolean);

    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...newNodes
    ]);
    setEdges((current) => [
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...newEdges
    ]);

    pasteCountRef.current = pasteIndex;

    toast.success(
      newNodes.length > 1
        ? `${newNodes.length} nos colados`
        : 'No colado'
    );

    return {
      nodeIds: newNodes.map((node) => node.id),
      idMap
    };
  }, [edges, hydrateNode, sanitizeNodeData, schedules, templates, vars]);

  const duplicateSelectedNodes = useCallback(() => {
    const copied = copySelectedNodes();
    if (!copied) return false;
    pasteCopiedNodes();
    setSelectionActionsOpen(false);
    return true;
  }, [copySelectedNodes, pasteCopiedNodes]);

  const loadInactivityConfig = useCallback(async () => {
    if (!tenant?.id) return;
    try {
      const data = await getJSON(`/tenants/${tenant.id}/settings`);
      setInactivityConfig({
        inactivityMaxHours: Number(data?.inactivityMaxHours ?? 8),
        inactivityMessage: data?.inactivityMessage || 'Atendimento encerrado por inatividade.'
      });
    } catch (e) {
      toast.error('Erro ao carregar inatividade');
    }
  }, [tenant?.id]);

  const handleSaveConfig = (nodeId, newData) => {
    const parentNode = getNodes().find(n => n.id === nodeId);
    if (!parentNode) return;

    updateNodeData(nodeId, newData);

    if (parentNode.type === 'inputNode' && newData.onFailBehavior !== 'branch') {
      setEdges((current) => current.filter(
        (edge) => !(edge.source === nodeId && String(edge.sourceHandle) === 'invalid')
      ));
    }

    const newNodes = [];
    const newEdges = [];
    const baseX = parentNode.position.x + 300;
    const baseY = parentNode.position.y;


    if (parentNode.type === 'conditionNode' && newData.conditions) {

      setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
      setEdges(eds => eds.filter(e =>
        !(e.source === nodeId && (
          e.id.startsWith(`edge_${nodeId}_`) ||
          e.id.startsWith(`edge_${nodeId}_else`)
        ))
      ));


      newData.conditions.forEach((cond, index) => {
        const condId = String(cond.id);
        const childId = `child_${nodeId}_${condId}`;

        newNodes.push({
          id: childId, type: 'caseNode',
          position: { x: baseX, y: baseY + (index * 80) },
          data: { label: formatConditionCaseLabel(cond) }
        });

        newEdges.push({
          id: `edge_${nodeId}_${condId}`,
          source: nodeId,
          target: childId,
          sourceHandle: condId,
          type: 'smoothstep'
        });
      });


      if (newData.hasElse !== false) {
        const elseId = `child_${nodeId}_else`;

        newNodes.push({
          id: elseId,
          type: 'caseNode',
          position: { x: baseX, y: baseY + (newData.conditions.length * 80) },
          data: { label: "Else" }
        });

        newEdges.push({
          id: `edge_${nodeId}_else`,
          source: nodeId,
          target: elseId,
          sourceHandle: 'else',
          style: { strokeDasharray: 5, stroke: '#94a3b8' }
        });
      }


    }


    if (parentNode.type === 'templateNode' && newData.templateId) {
      const template = templates.find(t => t.id === newData.templateId);
      if (template && template.buttons) {

        setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
        setEdges(eds => eds.filter(e =>
          !(e.source === nodeId && (
            e.id.startsWith(`e_${nodeId}_`)
          ))
        ));

        template.buttons.forEach((btn, index) => {
          const childId = `child_${nodeId}_${btn.id}`;
          newNodes.push({
            id: childId,
            type: 'caseNode',
            position: { x: baseX, y: baseY + (index * 80) },
            data: { label: btn.label }
          });


          newEdges.push({
            id: `e_${nodeId}_${childId}`,
            source: nodeId,
            target: childId,
            sourceHandle: btn.id,
            type: 'default',
            style: { stroke: '#be185d', strokeWidth: 2 }
          });
        });
      }
    }

    if (parentNode.type === 'menuNode' && Array.isArray(newData.options)) {
      setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
      setEdges(eds => eds.filter(e =>
        !(e.source === nodeId && (
          e.id.startsWith(`m_${nodeId}_`) ||
          e.id.startsWith(`m_${nodeId}_else`)
        ))
      ));

      // Menu dinamico: as opcoes so existem na conversa, entao as saidas sao
      // fixas (escolheu / lista vazia / else).
      if (newData.optionsSource === 'variable') {
        [['selected', 'Escolheu'], ['empty', 'Lista vazia']].forEach(([handle, label], index) => {
          newNodes.push({ id: `child_${nodeId}_${handle}`, type: 'caseNode', position: { x: baseX, y: baseY + (index * 80) }, data: { label, ...(handle === 'empty' ? { tone: 'error' } : {}) } });
          newEdges.push({ id: `m_${nodeId}_${handle}`, source: nodeId, target: `child_${nodeId}_${handle}`, sourceHandle: handle, type: 'default' });
        });
        if (newData.hasElse !== false) {
          newNodes.push({ id: `child_${nodeId}_else`, type: 'caseNode', position: { x: baseX, y: baseY + 160 }, data: { label: 'Else' } });
          newEdges.push({ id: `m_${nodeId}_else`, source: nodeId, target: `child_${nodeId}_else`, sourceHandle: 'else', style: { strokeDasharray: 5, stroke: '#94a3b8' } });
        }
        setNodes(nds => [...nds, ...newNodes]);
        setEdges(eds => [...eds, ...newEdges]);
        toast.success("Ramificações criadas!");
        return;
      }

      if (newData.createBranches === false) {
        if (newNodes.length > 0) {
          setNodes(nds => [...nds, ...newNodes]);
          setEdges(eds => [...eds, ...newEdges]);
        }
        toast.success("Configuração salva");
        return;
      }

      newData.options.forEach((opt, index) => {
        const optionId = String(opt.id || index + 1);
        const childId = `child_${nodeId}_${optionId}`;
        newNodes.push({
          id: childId,
          type: 'caseNode',
          position: { x: baseX, y: baseY + (index * 80) },
          data: { label: opt.label || optionId }
        });

        newEdges.push({
          id: `m_${nodeId}_${optionId}`,
          source: nodeId,
          target: childId,
          sourceHandle: optionId,
          type: 'default',
          style: { stroke: '#94a3b8' }
        });
      });

      if (newData.hasElse !== false) {
        const elseId = `child_${nodeId}_else`;
        newNodes.push({
          id: elseId,
          type: 'caseNode',
          position: { x: baseX, y: baseY + (newData.options.length * 80) },
          data: { label: 'Else' }
        });
        newEdges.push({
          id: `m_${nodeId}_else`,
          source: nodeId,
          target: elseId,
          sourceHandle: 'else',
          style: { strokeDasharray: 5, stroke: '#94a3b8' }
        });
      }
    }


    if (parentNode.type === 'scheduleNode') {

      setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
      setEdges(eds => eds.filter(e =>
        !(e.source === nodeId && (
          e.id.startsWith(`e_${nodeId}_`)
        ))
      ));

      ['inside', 'outside'].forEach((type, index) => {
        const childId = `child_${nodeId}_${type}`;
        newNodes.push({
          id: childId, type: 'caseNode',
          position: { x: baseX, y: baseY + (index * 80) },
          data: { label: type === 'inside' ? 'Aberto' : 'Fechado' }
        });
        newEdges.push({
          id: `e_${nodeId}_${type}`, source: nodeId, target: childId, sourceHandle: 'source',
          style: { stroke: type === 'inside' ? '#16a34a' : '#ef4444' }
        });
      });
    }

    // As tres rotas do subfluxo sao fixas do sistema: o autor do subfluxo nunca
    // as define, entao editar o subfluxo nao quebra o contrato do fluxo pai.
    if (parentNode.type === 'subflowNode') {
      setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
      setEdges(eds => eds.filter(e => !(e.source === nodeId && e.id.startsWith(`e_${nodeId}_`))));

      const rotas = [
        { handle: 'success', label: 'Prosseguir', stroke: '#16a34a', tone: null },
        { handle: 'resumed', label: 'Retomou do atendimento', stroke: '#2563eb', tone: null },
        { handle: 'error', label: 'Excecao', stroke: '#ef4444', tone: 'error' }
      ];
      rotas.forEach((rota, index) => {
        const childId = `child_${nodeId}_${rota.handle}`;
        newNodes.push({
          id: childId,
          type: 'caseNode',
          position: { x: baseX, y: baseY + (index * 90) },
          data: { label: rota.label, ...(rota.tone ? { tone: rota.tone } : {}) }
        });
        newEdges.push({
          id: `e_${nodeId}_${rota.handle}`,
          source: nodeId,
          target: childId,
          sourceHandle: rota.handle,
          type: 'smoothstep',
          style: { stroke: rota.stroke }
        });
      });
    }

    if (parentNode.type === 'httpRequestNode') {
      setNodes(nds => nds.filter(n => !n.id.startsWith(`child_${nodeId}`)));
      setEdges(eds => eds.filter(e =>
        !(e.source === nodeId && (
          e.id.startsWith(`e_${nodeId}_`)
        ))
      ));

      const successId = `child_${nodeId}_success`;
      const errorId = `child_${nodeId}_error`;

      newNodes.push({
        id: successId, type: 'caseNode',
        position: { x: baseX, y: baseY },
        data: { label: 'Sucesso' }
      });
      newNodes.push({
        id: errorId, type: 'caseNode',
        position: { x: baseX + 20, y: baseY + 90 },
        data: { label: 'Erro', tone: 'error' }
      });

      newEdges.push({
        id: `e_${nodeId}_success`,
        source: nodeId,
        target: successId,
        sourceHandle: 'success',
        type: 'smoothstep',
        style: { stroke: '#16a34a' }
      });
      newEdges.push({
        id: `e_${nodeId}_error`,
        source: nodeId,
        target: errorId,
        sourceHandle: 'error',
        type: 'smoothstep',
        style: { stroke: '#ef4444' }
      });
    }

    if (newNodes.length > 0) {
      setNodes(nds => [...nds, ...newNodes]);
      setEdges(eds => [...eds, ...newEdges]);
      toast.success("Ramificações criadas!");
    } else {
      toast.success("Configuração salva");
    }
  };



  const load = useCallback(async () => {
    setHistoryEnabled(false);
    try {
      const supportPromise = Promise.all([
        getJSON('/variables'),
        getJSON('/templates'),
        getJSON('/schedules'),
        getJSON('/queues'),
        getJSON('/flows/snippets/library'),
        getJSON('/subflows').catch(() => [])
      ]);
      const fD = await getJSON(isSubflow ? `/subflows/${id}` : `/flows/${id}?view=editor`);
      setFlowName(fD.name);
      setFlowMeta({
        description: fD.description || '',
        version: fD.version || null,
        createdAt: fD.createdAt || null,
        updatedAt: fD.updatedAt || null,
        publishedAt: fD.published?.publishedAt || fD.publishedAt || fD.publishedSnapshot?.publishedAt || null
      });
      setPublishedSnapshot(fD.publishedSnapshot || null);

      const source = fD.editorSnapshot || fD.draft || fD.published || { nodes: [createStartNode()], edges: [] };
      const sourceNodeTypes = new Set((Array.isArray(source?.nodes) ? source.nodes : []).map((node) => node?.type));

      const normalizedGraph = normalizeGraphStructure(source.nodes || [], source.edges || []);
      const rigido = usesRigidLayout(isSubflow, normalizedGraph.nodes);
      const nodesNoLugar = rigido
        ? applyFlowLayout(normalizedGraph.nodes, normalizedGraph.edges, { startId: START_NODE_ID })
        : normalizedGraph.nodes;
      const blocosNoLugar = rigido
        ? fitVisualBlocksToNodes(normalizeVisualBlocks(source.visualBlocks || []), nodesNoLugar)
        : normalizeVisualBlocks(source.visualBlocks || []);
      setNodes(nodesNoLugar.map((node) => hydrateNode(node, [], [], [])));
      setEdges(normalizedGraph.edges);
      setVisualBlocks(blocosNoLugar);
      // A posicao calculada nao conta como alteracao: o fluxo abre "Salvo".
      setPersistedSnapshotKey(flowSnapshotKey(buildFlowHistorySnapshot(
        nodesNoLugar,
        normalizedGraph.edges,
        blocosNoLugar,
        sanitizeNodeData,
        { ignorePositions: rigido }
      )));
      const loadedSavedAt = new Date(fD.updatedAt || fD.published?.publishedAt || Date.now());
      setLastSavedAt(Number.isNaN(loadedSavedAt.getTime()) ? new Date() : loadedSavedAt);
      window.requestAnimationFrame(() => {
        if (loadedFlowIdRef.current === id) setHistoryEnabled(true);
      });

      void supportPromise
        .then(([vD, tD, sD, qD, snippetData, subflowData]) => {
          setVars(vD);
          setTemplates(tD);
          setSchedules(sD);
          setQueues(qD);
          setFlowSnippets(Array.isArray(snippetData?.items) ? snippetData.items : []);
          setSubflows(Array.isArray(subflowData) ? subflowData : []);
          setNodes((current) => current.map((node) => hydrateNode(node, vD, tD, sD)));

          if (sourceNodeTypes.has('catalogNode')) {
            ensureCatalogItems();
          }
          if (sourceNodeTypes.has('mediaNode')) {
            ensureMediaAssets();
          }
          if (sourceNodeTypes.has('whatsappTemplateNode')) {
            ensureWhatsAppEditorData();
          }
        })
        .catch(() => {
          toast.error("Erro ao carregar dados auxiliares do editor");
        });
    } catch (e) { toast.error("Erro ao carregar fluxo"); }
  }, [ensureCatalogItems, ensureMediaAssets, ensureWhatsAppEditorData, hydrateNode, id, isSubflow, normalizeGraphStructure, sanitizeNodeData]);

  useEffect(() => {
    // Funções de hidratação e dados auxiliares podem mudar durante a edição.
    // O grafo persistido, porém, só deve ser recarregado ao trocar de fluxo.
    if (loadedFlowIdRef.current === id) return;
    loadedFlowIdRef.current = id;
    load();
  }, [id, load]);



  const onNodesChange = useCallback((changes) => {
    const visualBlockChanges = changes.filter((change) => String(change.id || '').startsWith('visual_block_'));
    const graphChanges = changes.filter((change) => !String(change.id || '').startsWith('visual_block_'));

    visualBlockChanges.forEach((change) => {
      const blockId = String(change.id || '').replace(/^visual_block_/, '');

      if (change.type === 'select') {
        setSelectedVisualBlockId(change.selected ? blockId : null);
        return;
      }

      if (change.type === 'remove') {
        setVisualBlocks((current) => current.filter((block) => block.id !== blockId));
        setSelectedVisualBlockId((current) => (current === blockId ? null : current));
        return;
      }

      if (change.type === 'position' && change.position) {
        setVisualBlocks((current) => {
          let movePayload = null;
          const nextBlocks = current.map((block) => {
            if (block.id !== blockId) return block;
            const nextX = Number(change.position.x || 0);
            const nextY = Number(change.position.y || 0);
            const dx = nextX - Number(block.bounds?.x || 0);
            const dy = nextY - Number(block.bounds?.y || 0);
            movePayload = {
              dx,
              dy,
              nodeIds: Array.isArray(block.nodeIds) ? block.nodeIds : []
            };
            return {
              ...block,
              bounds: {
                ...block.bounds,
                x: nextX,
                y: nextY
              }
            };
          });

          if (movePayload && (movePayload.dx !== 0 || movePayload.dy !== 0)) {
            const nodeIds = new Set(movePayload.nodeIds);
            setNodes((currentNodes) => currentNodes.map((node) => (
              nodeIds.has(node.id)
                ? {
                  ...node,
                  position: {
                    x: Number(node.position?.x || 0) + movePayload.dx,
                    y: Number(node.position?.y || 0) + movePayload.dy
                  }
                }
                : node
            )));
          }

          return nextBlocks;
        });
      }
    });

    if (graphChanges.some((change) => change.type === 'select' && change.selected)) {
      setSelectedVisualBlockId(null);
    }
    const safeChanges = graphChanges.filter((change) => !(change.type === 'remove' && change.id === START_NODE_ID));
    // A ancora presa sai junto com o node dela, na mesma mudanca (um desfazer so).
    const removendo = new Set(safeChanges.filter((change) => change.type === 'remove').map((change) => change.id));
    presasRef.current.forEach((alvo, ancora) => {
      if (removendo.has(alvo) && !removendo.has(ancora)) safeChanges.push({ type: 'remove', id: ancora });
    });
    const removedIds = new Set(safeChanges.filter((change) => change.type === 'remove').map((change) => change.id));
    if (removedIds.size) {
      setVisualBlocks((current) => current.map((block) => ({
        ...block,
        nodeIds: block.nodeIds.filter((nodeId) => !removedIds.has(nodeId))
      })));
    }
    setNodes((nds) => applyNodeChanges(safeChanges, nds));
  }, []);
  const onEdgesChange = useCallback((c) => setEdges(eds => applyEdgeChanges(c, eds)), []);

  const validateConnection = useCallback((params, options = {}) => {
    const candidateEdges = options.edges || edges;
    const sourceNode = options.sourceNode || nodes.find(n => n.id === params.source);
    const targetNode = options.targetNode || nodes.find(n => n.id === params.target);
    if (!sourceNode) return;
    if (!targetNode) return;

    if (sourceNode.type === 'menuNode' && sourceNode.data?.createBranches !== false) {
      return { error: 'Este no gera conexoes automaticamente. Configure-o com duplo clique.' };
    }


    if (['gotoNode', 'endNode', 'finalNode', 'conditionNode', 'httpRequestNode', 'subflowNode', 'templateNode', 'scheduleNode'].includes(sourceNode.type)) {
      return { error: 'Este no gera conexoes automaticamente. Configure-o com duplo clique.' };
    }


    const inputHasInvalidBranch = sourceNode.type === 'inputNode'
      && sourceNode.data?.onFailBehavior === 'branch';
    if (inputHasInvalidBranch) {
      if (candidateEdges.some(e => e.source === params.source && e.sourceHandle === params.sourceHandle)) {
        return { error: 'Essa saida ja esta conectada.' };
      }
    } else {
      if (candidateEdges.some(e => e.source === params.source)) return { error: 'Apenas uma saida permitida.' };
    }

    return { edge: { ...params, type: options.edgeType || 'flowEdge' } };
  }, [nodes, edges]);

  const onConnect = useCallback((params) => {
    const result = validateConnection(params);
    if (result?.error) return toast.error(result.error);
    if (result?.edge) setEdges((current) => addEdge(result.edge, current));
  }, [validateConnection]);

  const onReconnect = useCallback((oldEdge, connection) => {
    if (String(oldEdge.id || '').startsWith('e_')) {
      toast.error('Conexao estrutural fixa.');
      return;
    }
    const remainingEdges = edges.filter((edge) => edge.id !== oldEdge.id);
    const result = validateConnection(connection, {
      edges: remainingEdges,
      edgeType: oldEdge.type || 'flowEdge'
    });
    if (result?.error) return toast.error(result.error);
    if (!result?.edge) return;
    setEdges((current) => reconnectEdge(oldEdge, {
      ...connection,
      type: result.edge.type,
      style: result.edge.style,
      data: result.edge.data
    }, current));
  }, [edges, validateConnection]);

  const onEdgeClick = useCallback(async (evt, edge) => {
    if (edge.id.startsWith('e_')) return toast.error("Conexão estrutural fixa.");
    const ok = await confirm({
      title: 'Remover conexão',
      message: 'Tem certeza que deseja remover esta conexão entre os nós?',
      confirmText: 'Remover',
      type: 'danger',
    });
    if (!ok) return;
    setEdges((eds) => eds.filter(e => e.id !== edge.id));
  }, [confirm]);


  const onKeyDown = useCallback((event) => {
    const target = event.target;
    const tagName = String(target?.tagName || '').toUpperCase();
    const isTypingTarget = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || target?.isContentEditable;
    if (isTypingTarget) return;

    // Enquanto um modal estiver aberto, os atalhos do canvas (copy/paste/delete
    // /space) não devem disparar — senão o Ctrl+C/V de texto dentro do modal
    // é capturado pelo fluxo. Deixa o evento seguir para o comportamento nativo.
    const isModalOpen = configModal.open || visualBlockModal.open || inactivityModalOpen || flowSettingsOpen || integrationsOpen || assistantOpen;
    if (isModalOpen) return;

    if (readOnly) {
      const key = String(event.key || '').toLowerCase();
      const allowed = event.key === 'Escape' || event.key === 'Alt' || ((event.ctrlKey || event.metaKey) && ['f', 'c'].includes(key));
      if (!allowed) return;
    }

    const lowerKey = String(event.key || '').toLowerCase();
    const hasModifier = event.ctrlKey || event.metaKey;

    if (hasModifier && lowerKey === 'z') {
      event.preventDefault();
      if (event.shiftKey) flowHistory.redo();
      else flowHistory.undo();
      return;
    }

    if (hasModifier && lowerKey === 'y') {
      event.preventDefault();
      flowHistory.redo();
      return;
    }

    if (hasModifier && lowerKey === 'f') {
      event.preventDefault();
      setCanvasSearch((current) => ({ ...current, open: true }));
      return;
    }

    if (event.key === 'Escape') {
      setSelectionActionsOpen(false);
      setCanvasSearch({ open: false, query: '', index: 0 });
      return;
    }

    if (event.key === 'Alt' && nodes.some((node) => node.selected)) {
      event.preventDefault();
      setSelectionActionsOpen(true);
      return;
    }

    if (hasModifier && lowerKey === 'c') {
      event.preventDefault();
      copySelectedNodes();
      return;
    }

    if (hasModifier && lowerKey === 'v') {
      event.preventDefault();
      pasteCopiedNodes();
      return;
    }

    if (['delete', 'backspace', 'a'].includes(lowerKey) || (hasModifier && lowerKey === 'a')) {
      const selectedNodes = nodes.filter(n => n.selected);

      if (selectedNodes.some(n => n.id === START_NODE_ID)) {
        event.preventDefault();
        event.stopPropagation();
        toast.error("O nó de início é protegido e não pode ser removido.");
      }
    }
  }, [copySelectedNodes, flowHistory, nodes, pasteCopiedNodes, readOnly, configModal.open, visualBlockModal.open, inactivityModalOpen, flowSettingsOpen, integrationsOpen, assistantOpen]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onKeyDown]);



  const createNode = useCallback((type, requestedPosition = null, connection = null) => {
    const newId = `${type}_${Date.now()}`;
    const { x, y, zoom } = getViewport();

    let xPos = Math.round(Number(requestedPosition?.x ?? ((-x + window.innerWidth / 2) / zoom)) / 20) * 20;
    let yPos = Math.round(Number(requestedPosition?.y ?? ((-y + window.innerHeight / 2) / zoom)) / 20) * 20;
    const occupied = (candidateX, candidateY) => nodes.some((node) => (
      Math.abs(Number(node.position?.x || 0) - candidateX) < 180
      && Math.abs(Number(node.position?.y || 0) - candidateY) < 50
    ));
    while (occupied(xPos, yPos)) {
      xPos += 40;
      yPos += 40;
    }

    const newNode = hydrateNode({
      id: newId, type, position: { x: xPos, y: yPos },
      data: defaultNodeData(type)
    }, vars, templates, schedules);
    setNodes((nds) => [...nds, newNode]);
    if (connection?.source) {
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const result = validateConnection(
        { ...connection, target: newId, targetHandle: null },
        { targetNode: newNode, sourceNode }
      );
      if (result?.edge) setEdges((current) => addEdge(result.edge, current));
      if (result?.error) toast.error(result.error);
    }
    return newId;
  }, [getViewport, isSuperAdmin, nodes, schedules, templates, validateConnection, vars]);

  const handlePaletteDrop = useCallback((event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/onion-node');
    if (!type) return;
    createNode(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [createNode, screenToFlowPosition]);

  const handleConnectEnd = useCallback((event, connectionState) => {
    if (connectionState?.isValid || !connectionState?.fromNode?.id) return;
    const sourceNode = nodes.find((node) => node.id === connectionState.fromNode.id);
    if (!sourceNode) return;
    if ((sourceNode.type === 'menuNode' && sourceNode.data?.createBranches !== false)
      || ['gotoNode', 'endNode', 'finalNode', 'conditionNode', 'templateNode', 'scheduleNode'].includes(sourceNode.type)) {
      toast.error('Este no gera conexoes automaticamente.');
      return;
    }
    const clientX = Number(event?.clientX ?? event?.changedTouches?.[0]?.clientX);
    const clientY = Number(event?.clientY ?? event?.changedTouches?.[0]?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    setQuickCreate({
      screen: { x: clientX, y: clientY },
      position: screenToFlowPosition({ x: clientX, y: clientY }),
      connection: {
        source: sourceNode.id,
        sourceHandle: connectionState?.fromHandle?.id || null
      }
    });
  }, [nodes, screenToFlowPosition]);

  const saveInactivityConfig = async () => {
    if (!tenant?.id) return;
    try {
      setInactivitySaving(true);
      await putJSON(`/tenants/${tenant.id}/settings`, {
        inactivityMaxHours: Number(inactivityConfig.inactivityMaxHours || 0),
        inactivityMessage: inactivityConfig.inactivityMessage || ''
      });
      toast.success('Inatividade global atualizada');
      setInactivityModalOpen(false);
    } catch (e) {
      toast.error('Erro ao salvar inatividade');
    } finally {
      setInactivitySaving(false);
    }
  };

  const save = useCallback(async (publish = false, options = {}) => {
    const isAutosave = options.autosave === true;
    if (saveInFlightRef.current) return false;

    if (publish) {
      const blockingProblems = flowProblems.filter((problem) => problem.severity === 'error');
      if (blockingProblems.length > 0) {
        setProblemsOpen(true);
        focusProblemNode(blockingProblems[0]);
        return false;
      }
      if (!options.confirmed) {
        setPublishDiffOpen(true);
        return false;
      }
      const warningCount = flowProblems.filter((problem) => problem.severity === 'warning').length;
      const ok = options.confirmed || await confirm({
        title: 'Publicar fluxo em Produção',
        message: `Publicar "${flowName}" em Produção? Essa versão substituirá a atual.${warningCount > 0 ? ` O fluxo possui ${warningCount} aviso(s) nao bloqueante(s).` : ''}`,
        confirmText: 'Publicar',
        type: 'warning',
      });
      if (!ok) return false;
    }

    const normalizedGraph = normalizeGraphStructure(nodes, edges);

    const cleanNodes = normalizedGraph.nodes.map(({ data, hidden, ...n }) => {
      const {
        availableVars,
        availableTemplates,
        availableSchedules,
        onDelete,
        onConfig,
        ...cleanData
      } = data;
      return { ...n, data: cleanData };
    });

    const snapshotBeingSaved = buildFlowHistorySnapshot(
      normalizedGraph.nodes,
      normalizedGraph.edges,
      visualBlocks,
      sanitizeNodeData,
      { ignorePositions: usesRigidLayout(isSubflow) }
    );

    try {
      saveInFlightRef.current = true;
      setSaveStatus(isAutosave ? 'autosaving' : (publish ? 'publishing' : 'saving'));
      const cleanEdges = normalizedGraph.edges.map(({ hidden, ...edge }) => edge);

      const savedFlow = await putJSON(`${apiBase}/${id}`, { 
        nodes: cleanNodes, 
        edges: cleanEdges, 
        visualBlocks: normalizeVisualBlocks(visualBlocks),
        published: publish,
        publish,
        status: publish ? 'published' : 'draft',
        ...(options.meta || {})
      });
      if (!savedFlow) {
        throw new Error('O servidor nao confirmou o salvamento do fluxo.');
      }
      if (publish && !savedFlow?.published?.publishedAt) {
        throw new Error('O servidor salvou a requisicao, mas nao confirmou a publicacao do fluxo.');
      }
      if (publish) {
        setPublishedSnapshot({
          nodes: cleanNodes,
          edges: cleanEdges,
          visualBlocks: normalizeVisualBlocks(visualBlocks)
        });
        setPublishDiffOpen(false);
      }
      setPersistedSnapshotKey(flowSnapshotKey(snapshotBeingSaved));
      setLastSavedAt(new Date());
      if (options.meta?.name) setFlowName(savedFlow.name || options.meta.name);
      setFlowMeta((atual) => ({
        ...atual,
        ...(options.meta ? { description: savedFlow.description ?? options.meta.description } : {}),
        version: savedFlow.version ?? atual.version,
        updatedAt: savedFlow.updatedAt ?? atual.updatedAt,
        publishedAt: savedFlow.published?.publishedAt ?? atual.publishedAt
      }));
      setServerProblems([]);
      autosaveFailureNotifiedRef.current = false;
      if (!isAutosave) toast.success(publish ? "Publicado!" : options.meta ? "Fluxo salvo" : "Rascunho Salvo");
      return true;
    } catch (e) { 
      console.error("Erro ao salvar:", e);
      if (e?.code === 'script_validation_failed' && Array.isArray(e?.violations)) {
        setServerProblems(e.violations.map((violation, index) => ({
          severity: 'error',
          code: 'script_validation_failed',
          nodeId: violation?.nodeId || null,
          nodeLabel: violation?.label || violation?.nodeId || `Script ${index + 1}`,
          message: violation?.reason || 'O backend rejeitou o script deste node.'
        })));
        if (!isAutosave) setProblemsOpen(true);
        return false;
      }
      if (!isAutosave || !autosaveFailureNotifiedRef.current) {
        toast.error(`${isAutosave ? 'Falha no autosave: ' : 'Erro ao salvar: '}${e.message || 'Erro desconhecido'}`);
        if (isAutosave) autosaveFailureNotifiedRef.current = true;
      }
      return false;
    } finally {
      saveInFlightRef.current = false;
      setSaveStatus(null);
    }
  }, [confirm, edges, flowName, flowProblems, focusProblemNode, id, nodes, normalizeGraphStructure, sanitizeNodeData, visualBlocks]);

  useEffect(() => {
    if (readOnly || !isDirty || saveStatus || serverProblems.length > 0) return undefined;
    const timer = window.setTimeout(() => {
      void save(false, { autosave: true });
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [currentSnapshotKey, isDirty, readOnly, save, saveStatus, serverProblems.length]);

  const selectedNodes = nodes.filter((node) => node.selected);
  const onlyStartSelected = selectedNodes.length === 1 && selectedNodes[0].id === START_NODE_ID;
  const selectedBounds = getNodesBounds(selectedNodes);
  const selectionActionPoint = selectedBounds
    ? toScreenPoint({ x: selectedBounds.centerX, y: selectedBounds.y }, viewport)
    : null;
  const selectedVisualBlock = useMemo(() => (
    normalizeVisualBlocks(visualBlocks).find((block) => block.id === selectedVisualBlockId) || null
  ), [selectedVisualBlockId, visualBlocks]);
  const canToggleSelectedNodes = selectedNodes.length > 0
    && selectedNodes.every((node) => (
      !DISABLE_BLOCKED_NODE_TYPES.has(node.type)
      && edges.filter((edge) => edge.source === node.id).length === 1
    ));
  const selectedNodesAreDisabled = canToggleSelectedNodes
    && selectedNodes.every((node) => node.data?.disabled === true);

  const toggleSelectedNodesDisabled = () => {
    if (!canToggleSelectedNodes) {
      toast.error('Inicio e nodes com multiplas saidas nao podem ser desativados.');
      return;
    }
    const ids = new Set(selectedNodes.map((node) => node.id));
    setNodes((current) => current.map((node) => ids.has(node.id)
      ? { ...node, data: { ...node.data, disabled: !selectedNodesAreDisabled } }
      : node));
    setSelectionActionsOpen(false);
  };

  const saveSelectionAsSnippet = async () => {
    const name = String(snippetModal.name || '').trim();
    const selected = nodes.filter((node) => node.selected && node.type !== 'startNode');
    if (!name || !selected.length) return;
    const ids = new Set(selected.map((node) => node.id));
    const payloadNodes = selected.map((node) => {
      const { data, selected: _selected, dragging: _dragging, positionAbsolute: _positionAbsolute, measured: _measured, ...persistentNode } = node;
      const cleanData = sanitizeNodeData(data || {});
      return {
        ...persistentNode,
        data: node.type === 'secretNode' ? { ...cleanData, value: '' } : cleanData
      };
    });
    try {
      const snippet = await postJSON('/flows/snippets/library', {
        name,
        nodes: payloadNodes,
        edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      });
      setFlowSnippets((current) => [snippet, ...current]);
      setSnippetModal({ open: false, name: '' });
      setSelectionActionsOpen(false);
      toast.success('Trecho salvo na biblioteca');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar trecho');
    }
  };

  const insertFlowSnippet = useCallback((snippet) => {
    const sourceNodes = Array.isArray(snippet?.nodes) ? snippet.nodes : [];
    if (!sourceNodes.length) return;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const viewportState = getViewport();
    const center = {
      x: (-viewportState.x + window.innerWidth / 2) / viewportState.zoom,
      y: (-viewportState.y + window.innerHeight / 2) / viewportState.zoom
    };
    const instance = instantiateFlowSnippet(snippet, suffix, center);
    const nextNodes = instance.nodes.map((node) => hydrateNode(node, vars, templates, schedules));
    const nextEdges = instance.edges;
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...nextNodes]);
    setEdges((current) => [...current, ...nextEdges]);
    toast.success(`Trecho "${snippet.name}" inserido`);
  }, [getViewport, hydrateNode, schedules, templates, vars]);

  const deleteFlowSnippet = useCallback(async (snippet) => {
    if (!snippet?.id) return;
    const ok = await confirm({
      title: 'Excluir trecho',
      message: `Remover "${snippet.name}" da lista de trechos? Os fluxos que ja usaram esse trecho nao sao afetados.`,
      confirmText: 'Excluir',
      type: 'danger'
    });
    if (!ok) return;
    try {
      await deleteJSON(`/flows/snippets/library/${snippet.id}`);
      setFlowSnippets((current) => current.filter((item) => item.id !== snippet.id));
      toast.success('Trecho removido');
    } catch (error) {
      toast.error(error?.message || 'Falha ao remover trecho');
    }
  }, [confirm]);

  const closeFlowTest = useCallback(async () => {
    const sessionId = flowTest.session?.id;
    setFlowTest({ open: false, busy: false, session: null });
    if (sessionId) {
      try { await deleteJSON(`/flows/${id}/test-sessions/${sessionId}`); } catch (_) {}
    }
  }, [flowTest.session?.id, id]);

  const startFlowTest = useCallback(async () => {
    const previousId = flowTest.session?.id;
    setFlowTest((current) => ({ ...current, open: true, busy: true }));
    try {
      if (previousId) await deleteJSON(`/flows/${id}/test-sessions/${previousId}`);
      const normalized = normalizeGraphStructure(nodes, edges);
      const session = await postJSON(`/flows/${id}/test-sessions`, {
        nodes: normalized.nodes.map((node) => ({ ...node, data: sanitizeNodeData(node.data || {}) })),
        edges: normalized.edges
      });
      setFlowTest({ open: true, busy: false, session });
      if (session.currentNodeId) focusProblemNode({ nodeId: session.currentNodeId });
    } catch (error) {
      setFlowTest((current) => ({ ...current, busy: false }));
      toast.error(error.message || 'Falha ao iniciar teste');
    }
  }, [edges, flowTest.session?.id, focusProblemNode, id, nodes, normalizeGraphStructure, sanitizeNodeData]);

  const sendFlowTestInput = useCallback(async (text) => {
    if (!flowTest.session?.id) return;
    setFlowTest((current) => ({ ...current, busy: true }));
    try {
      const session = await postJSON(`/flows/${id}/test-sessions/${flowTest.session.id}/input`, { text });
      setFlowTest({ open: true, busy: false, session });
      if (session.currentNodeId) focusProblemNode({ nodeId: session.currentNodeId });
    } catch (error) {
      setFlowTest((current) => ({ ...current, busy: false }));
      toast.error(error.message || 'Falha ao enviar entrada de teste');
    }
  }, [flowTest.session?.id, focusProblemNode, id]);

  const zoomToAll = () => {
    fitView({ padding: 0.18, duration: 520 });
  };

  const zoomToSelection = () => {
    const bounds = getNodesBounds(selectedNodes);
    if (!bounds) {
      toast.error('Selecione um ou mais nodes para focar.');
      return;
    }
    setCenter(bounds.centerX, bounds.centerY, {
      zoom: selectedNodes.length === 1 ? 1.18 : 0.95,
      duration: 520
    });
  };

  const zoomToSelectedBlock = () => {
    if (!selectedVisualBlock?.bounds) {
      toast.error('Selecione um bloco visual para focar.');
      return;
    }
    const { bounds } = selectedVisualBlock;
    const maxSize = Math.max(Number(bounds.width || 1), Number(bounds.height || 1));
    const zoom = Math.max(0.45, Math.min(1.18, 760 / Math.max(maxSize, 240)));
    setCenter(
      Number(bounds.x || 0) + Number(bounds.width || 0) / 2,
      Number(bounds.y || 0) + Number(bounds.height || 0) / 2,
      { zoom, duration: 520 }
    );
  };

  const enterPresentationMode = () => {
    setPresentationMode(true);
    setSelectionActionsOpen(false);
    setCanvasMenuOpen(false);
    window.setTimeout(() => {
      fitView({ padding: 0.22, duration: 700 });
    }, 80);
  };

  const exitPresentationMode = () => {
    setPresentationMode(false);
  };

  useEffect(() => {
    if (!presentationMode) return undefined;
    const onPresentationKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exitPresentationMode();
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitView({ padding: 0.22, duration: 520 });
      }
    };
    window.addEventListener('keydown', onPresentationKeyDown);
    return () => window.removeEventListener('keydown', onPresentationKeyDown);
  }, [fitView, presentationMode]);

  useEffect(() => {
    if (!selectedNodes.length && selectionActionsOpen) {
      setSelectionActionsOpen(false);
    }
  }, [selectedNodes.length, selectionActionsOpen]);

  useEffect(() => {
    setNodes((current) => {
      let changed = false;
      const nextNodes = current.map((node) => {
        if (!node.hidden) return node;
        changed = true;
        const { hidden, ...nextNode } = node;
        return nextNode;
      });
      return changed ? nextNodes : current;
    });

    setEdges((current) => {
      let changed = false;
      const nextEdges = current.map((edge) => {
        if (!edge.hidden) return edge;
        changed = true;
        const { hidden, ...nextEdge } = edge;
        return nextEdge;
      });
      return changed ? nextEdges : current;
    });
  }, [visualBlocks]);

  const renameVisualBlock = useCallback((blockId) => {
    const block = visualBlocks.find((item) => item.id === blockId);
    if (!block) return;
    setVisualBlockModal({
      open: true,
      mode: 'rename',
      title: block.title.replace(/^##\s*/, ''),
      note: block.note || '',
      blockId,
      blockDraft: null
    });
  }, [visualBlocks]);

  const removeVisualBlock = useCallback((blockId) => {
    setVisualBlocks((current) => current.filter((item) => item.id !== blockId));
    setSelectedVisualBlockId((current) => (current === blockId ? null : current));
    toast.success('Bloco visual removido');
  }, []);

  const getVisualBlockNodes = useCallback((blockId) => {
    const block = normalizeVisualBlocks(visualBlocks).find((item) => item.id === blockId);
    if (!block) return { block: null, blockNodes: [] };
    const blockNodeIds = new Set(block.nodeIds);
    return {
      block,
      blockNodes: nodes.filter((node) => blockNodeIds.has(node.id))
    };
  }, [nodes, visualBlocks]);

  const selectVisualBlock = useCallback((blockId) => {
    setSelectedVisualBlockId(blockId);
    setSelectionActionsOpen(false);
    setNodes((current) => current.map((node) => (
      node.selected ? { ...node, selected: false } : node
    )));
  }, []);

  const copyVisualBlockNodes = useCallback((blockId, options = {}) => {
    const { blockNodes } = getVisualBlockNodes(blockId);
    const copied = copyNodesToClipboard(blockNodes, { toast: options.toast !== false });
    if (!copied && options.toast !== false) {
      toast.error('Este bloco nao possui nodes copiaveis.');
    }
    return copied;
  }, [copyNodesToClipboard, getVisualBlockNodes]);

  const duplicateVisualBlock = useCallback((blockId) => {
    const { block } = getVisualBlockNodes(blockId);
    if (!block) return false;

    const copied = copyVisualBlockNodes(blockId, { toast: false });
    if (!copied) return false;

    const pasted = pasteCopiedNodes();
    const idMap = pasted?.idMap;
    if (!idMap) return false;

    const nextNodeIds = block.nodeIds
      .map((nodeId) => idMap.get(nodeId))
      .filter(Boolean);

    const nextBlock = {
      ...block,
      id: `block_${Date.now()}`,
      title: `${block.title.replace(/^##\s*/, '## ')} copia`,
      hidden: false,
      collapsed: false,
      bounds: {
        ...block.bounds,
        x: block.bounds.x + 40,
        y: block.bounds.y + 40
      },
      nodeIds: nextNodeIds
    };

    setVisualBlocks((current) => [...current, nextBlock]);
    setSelectedVisualBlockId(nextBlock.id);
    toast.success('Bloco duplicado');
    return true;
  }, [copyVisualBlockNodes, getVisualBlockNodes, pasteCopiedNodes]);

  const toggleVisualBlockHidden = useCallback((blockId) => {
    setVisualBlocks((current) => current.map((block) => (
      block.id === blockId ? { ...block, hidden: !block.hidden } : block
    )));
  }, []);

  const toggleVisualBlockCollapsed = useCallback((blockId) => {
    setVisualBlocks((current) => current.map((block) => (
      block.id === blockId ? { ...block, collapsed: !block.collapsed } : block
    )));
  }, []);

  const deleteVisualBlockNodes = useCallback(async (blockId) => {
    const { block, blockNodes } = getVisualBlockNodes(blockId);
    if (!block || !blockNodes.length) {
      removeVisualBlock(blockId);
      return;
    }

    const ok = await confirm({
      title: 'Apagar nodes do bloco',
      message: `Apagar todos os ${blockNodes.length} nodes do bloco "${block.title.replace(/^##\s*/, '')}"?`,
      confirmText: 'Apagar',
      type: 'danger'
    });
    if (!ok) return;

    const removableIds = new Set(blockNodes.map((node) => node.id));
    const shouldRemoveNode = (node) => (
      removableIds.has(node.id)
      || [...removableIds].some((id) => node.id.startsWith(`child_${id}`))
    );

    setNodes((current) => current.filter((node) => !shouldRemoveNode(node)));
    setEdges((current) => current.filter((edge) => !removableIds.has(edge.source) && !removableIds.has(edge.target)));
    setVisualBlocks((current) => current
      .filter((item) => item.id !== blockId)
      .map((item) => ({
        ...item,
        nodeIds: item.nodeIds.filter((nodeId) => !removableIds.has(nodeId))
      })));
    setSelectedVisualBlockId(null);
    toast.success('Nodes do bloco apagados');
  }, [confirm, getVisualBlockNodes, removeVisualBlock]);

  const handleVisualBlockPointerDown = useCallback((blockId, event) => {
    if (event.button !== 0) return;
    const { block, blockNodes } = getVisualBlockNodes(blockId);
    if (!block) return;

    event.preventDefault();
    event.stopPropagation();
    selectVisualBlock(blockId);

    const nodeStarts = new Map(blockNodes.map((node) => [
      node.id,
      {
        x: Number(node.position?.x || 0),
        y: Number(node.position?.y || 0)
      }
    ]));

    visualBlockDragRef.current = {
      blockId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBounds: { ...block.bounds },
      nodeStarts,
      zoom: viewport.zoom || 1
    };

    const handlePointerMove = (moveEvent) => {
      const drag = visualBlockDragRef.current;
      if (!drag || drag.blockId !== blockId) return;

      const deltaX = (moveEvent.clientX - drag.startClientX) / drag.zoom;
      const deltaY = (moveEvent.clientY - drag.startClientY) / drag.zoom;

      setVisualBlocks((current) => current.map((item) => (
        item.id === blockId
          ? {
            ...item,
            bounds: {
              ...item.bounds,
              x: drag.startBounds.x + deltaX,
              y: drag.startBounds.y + deltaY
            }
          }
          : item
      )));

      setNodes((current) => current.map((node) => {
        const start = drag.nodeStarts.get(node.id);
        if (!start) return node;
        return {
          ...node,
          position: {
            x: start.x + deltaX,
            y: start.y + deltaY
          }
        };
      }));
    };

    const handlePointerUp = () => {
      visualBlockDragRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [getVisualBlockNodes, selectVisualBlock, viewport.zoom]);

  const closeVisualBlockModal = useCallback(() => {
    setVisualBlockModal({
      open: false,
      mode: 'create',
      title: '',
      note: '',
      blockId: null,
      blockDraft: null
    });
  }, []);

  const submitVisualBlockModal = useCallback(() => {
    const titleText = String(visualBlockModal.title || 'Novo bloco').trim() || 'Novo bloco';
    const normalizedTitle = titleText.startsWith('##') ? titleText : `## ${titleText}`;

    if (visualBlockModal.mode === 'rename' && visualBlockModal.blockId) {
      setVisualBlocks((current) => current.map((item) => (
        item.id === visualBlockModal.blockId
          ? { ...item, title: normalizedTitle, note: String(visualBlockModal.note || '') }
          : item
      )));
      toast.success('Bloco visual renomeado');
      closeVisualBlockModal();
      return;
    }

    if (visualBlockModal.blockDraft) {
      setVisualBlocks((current) => [
        ...current,
        {
          ...visualBlockModal.blockDraft,
          title: normalizedTitle,
          note: String(visualBlockModal.note || '')
        }
      ]);
      toast.success('Bloco visual criado');
    }

    closeVisualBlockModal();
  }, [closeVisualBlockModal, visualBlockModal]);

  useEffect(() => {
    if (configModal.open || integrationsOpen || flowSettingsOpen) setAssistantOpen(false);
  }, [configModal.open, integrationsOpen, flowSettingsOpen]);

  useEffect(() => {
    if (!assistantOpen) return;
    getJSON('/rest-integrations')
      .then((lista) => { assistantIntegrationsRef.current = Array.isArray(lista) ? lista : []; })
      .catch(() => { assistantIntegrationsRef.current = []; });
  }, [assistantOpen]);

  // Resumo do fluxo para a IA: as saidas (caseNode) viram "branch" de quem
  // se divide, como a pessoa enxerga no canvas.
  const askAssistant = useCallback(async (instruction) => {
    const saidaDe = new Map();
    edges.forEach((edge) => {
      const alvo = nodes.find((node) => node.id === edge.target);
      if (alvo?.type === 'caseNode') saidaDe.set(alvo.id, { parent: edge.source, branch: String(edge.sourceHandle || '') });
    });
    const visiveis = nodes.filter((node) => node.type !== 'caseNode' && !String(node.id).startsWith('visual_block_'));
    const textoDe = (data = {}) => {
      const valor = data.text && data.text !== '...' ? data.text : (data.queueMessage || data.title || '');
      return String(valor || '');
    };
    const selecionados = nodes.filter((node) => node.selected);
    const selecionado = selecionados.length === 1 ? selecionados[0] : null;
    const saidaSelecionada = selecionado?.type === 'caseNode' ? saidaDe.get(selecionado.id) : null;
    const flow = {
      nodes: visiveis.map((node) => ({
        id: node.id,
        type: node.type,
        name: node.data?.customName || '',
        text: textoDe(node.data),
        variableName: node.data?.variableName || '',
        ...(node.type === 'menuNode' ? {
          options: node.data?.optionsSource === 'variable' ? undefined : (node.data?.options || []),
          ...(node.data?.optionsSource === 'variable' ? { optionsSource: 'variable', optionsVariable: node.data?.optionsVariable || '' } : {})
        } : {}),
        ...(node.type === 'conditionNode' ? { conditions: node.data?.conditions || [] } : {}),
        ...(node.data?.queueName ? { queueName: node.data.queueName } : {})
      })),
      edges: edges.flatMap((edge) => {
        const alvo = nodes.find((node) => node.id === edge.target);
        if (alvo?.type === 'caseNode') return [];
        const saida = saidaDe.get(edge.source);
        return [saida ? { source: saida.parent, branch: saida.branch, target: edge.target } : { source: edge.source, target: edge.target }];
      }),
      selectedNodeId: saidaSelecionada ? saidaSelecionada.parent : (selecionado?.id || null),
      selectedBranch: saidaSelecionada?.branch || null,
      variables: (vars || []).map((item) => item.name).filter(Boolean),
      queues: (queues || []).map((item) => item.name).filter(Boolean),
      integrations: assistantIntegrationsRef.current.map((item) => ({ id: item.id, name: item.name }))
    };
    return postJSON('/flow-assistant', { instruction, flowId: id, flow });
  }, [edges, id, nodes, queues, vars]);

  const applyAssistant = useCallback(async (resposta) => {
    const operations = Array.isArray(resposta?.operations) ? resposta.operations : [];
    // Variaveis novas primeiro, para a configuracao dos nodes ja enxergar.
    const existentes = new Set((vars || []).map((item) => item.name));
    const criadas = [];
    for (const op of operations.filter((item) => item.op === 'create_variable' && !existentes.has(item.name))) {
      try {
        criadas.push(await postJSON('/variables', { name: op.name, type: 'text', defaultValue: '', description: 'Criada pelo assistente do fluxo', isRoot: false, enabled: true }));
      } catch (error) {
        toast.error(`Não criei a variável ${op.name}: ${error.message}`);
      }
    }
    if (criadas.length) setVars((atual) => [...(atual || []), ...criadas.filter(Boolean)]);
    const varsAtuais = [...(vars || []), ...criadas.filter(Boolean)];

    const resultado = applyAssistantOperations({
      nodes,
      edges,
      operations: operations.filter((item) => item.op !== 'create_variable'),
      makeNode: (type, nodeId, data) => hydrateNode({
        id: nodeId,
        type,
        position: { x: 0, y: 0 },
        data: type === 'caseNode' ? data : { ...defaultNodeData(type), ...data }
      }, varsAtuais, templates, schedules),
      conditionLabel: formatConditionCaseLabel,
      integrations: assistantIntegrationsRef.current,
      labels: NODE_TYPE_LABELS
    });
    // Node novo nasce onde esta quem aponta para ele; dali o layout desliza.
    const posicao = new Map(resultado.nodes.map((node) => [node.id, node.position]));
    const novos = new Set(resultado.nodes.filter((node) => !nodes.some((atual) => atual.id === node.id)).map((node) => node.id));
    for (let volta = 0; volta < 4; volta += 1) {
      resultado.edges.forEach((edge) => {
        if (novos.has(edge.target) && !novos.has(edge.source) && posicao.has(edge.source)) {
          posicao.set(edge.target, posicao.get(edge.source));
          novos.delete(edge.target);
        }
      });
    }
    setNodes(resultado.nodes.map((node) => ({ ...node, position: posicao.get(node.id) || node.position })));
    setEdges(resultado.edges);
    const total = resultado.createdIds.length;
    toast.success(total ? `${total} ${total === 1 ? 'node criado' : 'nodes criados'}` : 'Mudanças aplicadas');
    return { ok: true, warnings: resultado.warnings };
  }, [edges, hydrateNode, nodes, schedules, templates, vars]);

  const describeAssistant = useCallback(
    (operations) => describeOperations(operations, nodes, NODE_TYPE_LABELS),
    [nodes]
  );

  const rigidLayout = usesRigidLayout(isSubflow, nodes);
  const presas = useMemo(() => dockedAnchors(nodes, edges), [nodes, edges]);
  presasRef.current = presas;
  // So a copia que vai para a tela leva a marca: o estado salvo nao muda.
  const flowNodes = useMemo(() => (presas.size
    ? nodes.map((node) => (presas.has(node.id) ? { ...node, data: { ...node.data, __docked: true } } : node))
    : nodes), [nodes, presas]);
  // Ancora pelo botao do hover: nasce presa em cima do node e ja abre para dar nome.
  const createDockedAnchor = useCallback((alvo) => {
    setHoveredNodeId(null);
    const newId = `anchorNode_${Date.now()}`;
    const newNode = hydrateNode({
      id: newId,
      type: 'anchorNode',
      position: { x: Number(alvo.position?.x || 0), y: Number(alvo.position?.y || 0) - ANCHOR_DOCK_OFFSET },
      data: { ...defaultNodeData('anchorNode'), anchorName: nextAnchorName(nodes) }
    }, vars, templates, schedules);
    setNodes((nds) => [...nds, newNode]);
    setEdges((current) => addEdge({ source: newId, sourceHandle: null, target: alvo.id, targetHandle: null, type: 'flowEdge' }, current));
    // O React Flow ainda nao tem o node novo: abre direto, sem o openConfig.
    setFlowSettingsOpen(false);
    setConfigModal({ open: true, nodeId: newId });
  }, [hydrateNode, nodes, schedules, templates, vars]);
  const layoutKey = useMemo(() => (rigidLayout ? JSON.stringify([
    nodes.map((node) => [node.id, node.type]),
    edges.map((edge) => [edge.source, edge.target])
  ]) : ''), [edges, nodes, rigidLayout]);
  // Quando a estrutura muda, os nodes deslizam ate o lugar novo. A posicao e
  // interpolada no proprio estado (e nao por CSS) para as linhas acompanharem.
  const reduceMotion = useReducedMotion();
  const layoutAnimationRef = useRef(null);
  useEffect(() => {
    if (!layoutKey) return undefined;
    const destino = computeFlowLayout(nodes, edges, { startId: START_NODE_ID });
    const origem = new Map(nodes.map((node) => [node.id, { x: Number(node.position?.x || 0), y: Number(node.position?.y || 0) }]));
    const algoMuda = [...destino].some(([nodeId, alvo]) => {
      const atual = origem.get(nodeId);
      return !atual || atual.x !== alvo.x || atual.y !== alvo.y;
    });
    if (!algoMuda) return undefined;
    const aplicar = (progresso) => setNodes((current) => current.map((node) => {
      const alvo = destino.get(node.id);
      if (!alvo) return node;
      const inicio = origem.get(node.id) || alvo;
      const position = progresso >= 1
        ? alvo
        : { x: inicio.x + (alvo.x - inicio.x) * progresso, y: inicio.y + (alvo.y - inicio.y) * progresso };
      return { ...node, position };
    }));
    layoutAnimationRef.current?.stop();
    if (reduceMotion) {
      aplicar(1);
      return undefined;
    }
    layoutAnimationRef.current = animate(0, 1, {
      duration: 0.32,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: aplicar,
      onComplete: () => aplicar(1)
    });
    return () => layoutAnimationRef.current?.stop();
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const positionsKey = useMemo(() => (rigidLayout
    ? nodes.map((node) => `${node.id}:${node.position?.x}:${node.position?.y}`).join('|')
    : ''), [nodes, rigidLayout]);
  useEffect(() => {
    if (!positionsKey) return;
    setVisualBlocks((current) => fitVisualBlocksToNodes(current, nodes));
  }, [positionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Botao + ao lado do node: some com um pequeno atraso para dar tempo de o
  // mouse sair do node e chegar nele.
  const showNextButton = useCallback((nodeId) => {
    window.clearTimeout(hoverTimerRef.current);
    setHoveredNodeId(nodeId);
  }, []);
  const hideNextButtonSoon = useCallback(() => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoveredNodeId(null), 220);
  }, []);
  const nextButtonNode = (() => {
    if (readOnly || presentationMode || quickCreate) return null;
    const selecionados = nodes.filter((node) => node.selected);
    const alvo = nodes.find((node) => node.id === hoveredNodeId) || (selecionados.length === 1 ? selecionados[0] : null);
    return canAddNextNode(alvo, edges) ? alvo : null;
  })();
  const anchorButtonNode = (() => {
    if (readOnly || presentationMode || quickCreate || isSubflow || !hoveredNodeId) return null;
    const alvo = nodes.find((node) => node.id === hoveredNodeId);
    return canDockAnchor(alvo, presas) ? alvo : null;
  })();
  const openNextNodePicker = useCallback((node, rect) => {
    setHoveredNodeId(null);
    setQuickCreate({
      screen: { x: rect.right + 6, y: rect.top },
      position: { x: Number(node.position?.x || 0) + layoutWidth(node) + 72, y: Number(node.position?.y || 0) },
      connection: { source: node.id, sourceHandle: null }
    });
  }, []);

  const visualBlockFlowNodes = normalizeVisualBlocks(visualBlocks).map((block) => ({
    id: `visual_block_${block.id}`,
    type: 'visualBlockNode',
    position: {
      x: block.bounds.x,
      y: block.bounds.y
    },
    draggable: !readOnly && !rigidLayout,
    selectable: true,
    deletable: !readOnly,
    zIndex: 0,
    style: {
      width: block.bounds.width,
      height: block.collapsed ? Math.min(block.bounds.height, 72) : block.bounds.height
    },
    data: {
      block,
      readOnly,
      onRename: renameVisualBlock,
      onRemove: removeVisualBlock,
      onCopy: copyVisualBlockNodes,
      onDuplicate: duplicateVisualBlock,
      onToggleHidden: toggleVisualBlockHidden,
      onToggleCollapsed: toggleVisualBlockCollapsed,
      onDeleteNodes: deleteVisualBlockNodes
    }
  }));
  const renderedNodes = [...visualBlockFlowNodes, ...nodes];
  const selectedEdgeNodeId = nodes.find(
    (node) => node?.selected && !String(node?.id || '').startsWith('visual_block_')
  )?.id || null;
  const displayEdges = useMemo(() => {
    const activeState = buildActiveEdgeState(selectedEdgeNodeId, edges);
    const hasActiveNode = Boolean(activeState.selectedNodeId);

    return edges.map((edge) => {
      const active = activeState.edgeIds.has(edge.id);
      const tone = getFlowEdgeTone(edge);
      const sourceHandle = String(edge.sourceHandle || '').trim();
      const markerColor = active
        ? (tone === 'error' ? '#991b1b' : 'var(--flow-edge-active)')
        : (tone === 'error' ? '#dc2626' : '#64748b');

      return {
        ...edge,
        type: 'flowEdge',
        // Ligacao da ancora presa: existe para o motor, a etiqueta ja mostra.
        hidden: presas.has(edge.source),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 9,
          height: 9,
          color: markerColor
        },
        data: {
          ...(edge.data || {}),
          onDelete: readOnly || String(edge.id || '').startsWith('e_') ? null : () => onEdgeClick(null, edge),
          active,
          dimmed: hasActiveNode && !active,
          dashed: sourceHandle === 'else' || edge?.style?.strokeDasharray,
          tone
        }
      };
    });
  }, [edges, onEdgeClick, presas, selectedEdgeNodeId]);
  const publishDiff = useMemo(() => diffFlowSnapshots(
    { nodes, edges, visualBlocks },
    publishedSnapshot || { nodes: [], edges: [], visualBlocks: [] }
  ), [edges, nodes, publishedSnapshot, visualBlocks]);

  const canvasSearchResults = useMemo(() => {
    const query = normalizePaletteSearch(canvasSearch.query);
    if (!query) return [];
    return nodes.filter((node) => {
      const data = node.data || {};
      const variableValues = Object.entries(data)
        .filter(([key]) => key !== 'availableVars' && /(?:variable|varname|var$|vars$|varmap|mapping)/i.test(key))
        .flatMap(([, value]) => {
          if (Array.isArray(value)) return value;
          if (value && typeof value === 'object') return Object.values(value);
          return [value];
        })
        .filter((value) => ['string', 'number'].includes(typeof value));
      const searchable = [
        data.customName,
        data.text,
        node.type,
        data.variableName,
        data.lastMessageVar,
        data.listVar,
        data.textVar,
        data.countVar,
        ...variableValues
      ];
      if (node.type === 'secretNode') searchable.splice(1, 1);
      return normalizePaletteSearch(searchable.filter(Boolean).join(' ')).includes(query);
    });
  }, [canvasSearch.query, nodes]);

  const focusCanvasSearchResult = useCallback((requestedIndex) => {
    if (!canvasSearchResults.length) return;
    const index = ((requestedIndex % canvasSearchResults.length) + canvasSearchResults.length) % canvasSearchResults.length;
    const node = canvasSearchResults[index];
    setCanvasSearch((current) => ({ ...current, index }));
    focusProblemNode({ nodeId: node.id });
  }, [canvasSearchResults, focusProblemNode]);

  return (
    <div className={`h-full flex flex-col bg-slate-50 dark:bg-slate-900 ${presentationMode ? 'fixed inset-0 z-[9998]' : ''}`}>

      {}
      <IntegrationsDrawer open={integrationsOpen} onClose={() => setIntegrationsOpen(false)} />
      <FlowAssistantPanel
        open={assistantOpen && !readOnly}
        onClose={() => setAssistantOpen(false)}
        onAsk={askAssistant}
        onApply={applyAssistant}
        describe={describeAssistant}
      />
      <FlowSettingsPanel
        open={flowSettingsOpen}
        onClose={() => setFlowSettingsOpen(false)}
        readOnly={readOnly}
        isSubflow={isSubflow}
        flowId={id}
        name={flowName}
        meta={flowMeta}
        stats={{ nodes: nodes.length, edges: edges.length }}
        isDirty={isDirty}
        onSave={(meta) => save(false, { meta })}
        onOpenInactivity={readOnly ? null : async () => {
          setFlowSettingsOpen(false);
          await loadInactivityConfig();
          setInactivityModalOpen(true);
        }}
      />
      <NodeConfigModal
        isOpen={configModal.open}
        node={nodes.find(n => n.id === configModal.nodeId)}
        onClose={() => setConfigModal({ open: false, nodeId: null })}
        subflows={subflows}
        onSave={readOnly ? null : handleSaveConfig}
        nodes={nodes}
        vars={vars} templates={templates} schedules={schedules}
        whatsappTemplates={whatsappTemplates}
        whatsappInteractiveTemplates={whatsappInteractiveTemplates}
        whatsappSenderOptions={whatsappSenderOptions}
        whatsappChannelReady={whatsappChannelReady}
        whatsappDataLoading={whatsappDataLoading}
        whatsappDataError={whatsappDataError}
        queues={queues}
        catalogItems={catalogItems}
        mediaAssets={mediaAssets}
      />

      <VisualBlockNameModal
        open={visualBlockModal.open}
        mode={visualBlockModal.mode}
        title={visualBlockModal.title}
        note={visualBlockModal.note || ''}
        onChangeTitle={(title) => setVisualBlockModal((current) => ({ ...current, title }))}
        onChangeNote={(note) => setVisualBlockModal((current) => ({ ...current, note }))}
        onClose={closeVisualBlockModal}
        onSubmit={submitVisualBlockModal}
      />
      <PublishDiffModal
        open={publishDiffOpen}
        flowName={flowName}
        diff={publishDiff}
        busy={saveStatus === 'publishing'}
        onClose={() => setPublishDiffOpen(false)}
        onConfirm={() => save(true, { confirmed: true })}
        onSelectNode={(item) => {
          if (item.status !== 'removed') focusProblemNode({ nodeId: item.id });
          setPublishDiffOpen(false);
        }}
      />
      <SnippetNameModal
        open={snippetModal.open}
        value={snippetModal.name}
        onChange={(name) => setSnippetModal((current) => ({ ...current, name }))}
        onClose={() => setSnippetModal({ open: false, name: '' })}
        onSubmit={saveSelectionAsSnippet}
      />

      {}
      {!presentationMode && (
      <header data-flow-editor-header className="relative z-40 flex min-h-[62px] shrink-0 items-center gap-4 border-b border-slate-400 bg-slate-100 px-4 dark:border-slate-600 dark:bg-slate-900">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
            <span>Editor de fluxo</span>
            <span className="text-slate-300 dark:text-slate-700">/</span>
            <span className="max-w-[160px] truncate">{id}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-3">
            <h1 className="min-w-0">
              <button
                type="button"
                onClick={() => { setConfigModal({ open: false, nodeId: null }); setIntegrationsOpen(false); setFlowSettingsOpen(true); }}
                className="block max-w-full truncate rounded-[2px] text-left text-[15px] font-semibold leading-tight text-slate-950 decoration-slate-400 underline-offset-4 hover:underline dark:text-slate-100"
                title="Nome, descrição e situação do fluxo"
              >
                {flowName || 'Fluxo sem nome'}
              </button>
            </h1>
            {!readOnly && <span
              className={`flex shrink-0 items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] ${
              isDirty ? 'text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'
              }`}
              title={isDirty ? 'Alteracoes nao salvas' : 'Rascunho salvo'}
            >
              <span className={`h-1.5 w-1.5 ${isDirty ? 'bg-amber-500' : 'bg-slate-400 dark:bg-slate-600'}`} />
              <span className="hidden sm:inline">
                {saveStatus === 'autosaving' || saveStatus === 'saving'
                  ? 'Salvando rascunho...'
                  : saveStatus === 'publishing'
                    ? 'Publicando...'
                    : isDirty
                      ? 'Alteracoes nao salvas'
                      : `Salvo${lastSavedAt ? ` as ${lastSavedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}`}
              </span>
            </span>}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="flex items-center border border-slate-400 bg-slate-100 dark:border-slate-600 dark:bg-slate-900">
            <button
              type="button"
              onClick={flowHistory.undo}
              disabled={!flowHistory.canUndo}
              className="grid h-9 w-9 place-items-center border-r border-slate-400 text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:text-slate-300 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800 dark:disabled:text-slate-700"
              aria-label="Desfazer alteracao no canvas"
              title="Desfazer (Ctrl+Z)"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              onClick={flowHistory.redo}
              disabled={!flowHistory.canRedo}
              className="grid h-9 w-9 place-items-center text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:text-slate-300 dark:text-slate-200 dark:hover:bg-slate-800 dark:disabled:text-slate-700"
              aria-label="Refazer alteracao no canvas"
              title="Refazer (Ctrl+Shift+Z ou Ctrl+Y)"
            >
              <Redo2 size={14} />
            </button>
          </div>

          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                setConfigModal({ open: false, nodeId: null });
                setIntegrationsOpen(false);
                setFlowSettingsOpen(false);
                setAssistantOpen((current) => !current);
              }}
              className={`flex h-9 items-center gap-1.5 rounded-[3px] border px-2.5 font-mono text-[10px] font-bold uppercase transition-colors ${
                assistantOpen
                  ? 'border-slate-950 bg-slate-950 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950'
                  : 'border-slate-400 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
              aria-expanded={assistantOpen}
              title="Assistente de IA: edite o fluxo pedindo em português"
            >
              <Sparkles size={14} />
              <span className="hidden lg:inline">Assistente</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setVariablesOpen((current) => !current);
              setProblemsOpen(false);
            }}
            className={`grid h-9 w-9 place-items-center rounded-[3px] border transition-colors ${
              variablesOpen
                ? 'border-slate-950 bg-slate-300 text-slate-950 dark:border-slate-200 dark:bg-slate-700 dark:text-white'
                : 'border-slate-400 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
            aria-label={`Variaveis do fluxo: ${variableUsage.used.length} utilizadas de ${variableUsage.total}`}
            aria-expanded={variablesOpen}
            title={`Variaveis: ${variableUsage.used.length} utilizadas, ${variableUsage.unused.length} sem uso`}
          >
            <Braces size={14} />
          </button>

          <button
            type="button"
            onClick={() => { setFlowSettingsOpen(false); setIntegrationsOpen((current) => !current); }}
            className={`grid h-9 w-9 place-items-center rounded-[3px] border transition-colors ${
              integrationsOpen
                ? 'border-slate-950 bg-slate-300 text-slate-950 dark:border-slate-200 dark:bg-slate-700 dark:text-white'
                : 'border-slate-400 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
            aria-label="Integrações"
            aria-expanded={integrationsOpen}
            title="Integrações"
          >
            <Plug size={14} />
          </button>

          {flowProblems.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setProblemsOpen((current) => !current);
                setVariablesOpen(false);
              }}
              className={`grid h-9 w-9 place-items-center rounded-[3px] border transition-colors ${
                flowProblemCounts.errors > 0
                  ? 'border-red-500 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70'
                  : 'border-amber-500 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/70'
              }`}
              aria-label={`Problemas do fluxo: ${flowProblems.length}`}
              aria-expanded={problemsOpen}
              title={`${flowProblems.length} ${flowProblems.length === 1 ? 'problema encontrado' : 'problemas encontrados'}`}
            >
              <AlertTriangle size={14} />
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setConfigModal({ open: false, nodeId: null });
              setIntegrationsOpen(false);
              setFlowSettingsOpen((current) => !current);
            }}
            className={`grid h-9 w-9 place-items-center rounded-[3px] border transition-colors ${
              flowSettingsOpen
                ? 'border-slate-950 bg-slate-300 text-slate-950 dark:border-slate-200 dark:bg-slate-700 dark:text-white'
                : 'border-slate-400 bg-slate-100 text-slate-700 hover:border-slate-950 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
            aria-expanded={flowSettingsOpen}
            aria-label="Configuração do fluxo"
            title="Configuração do fluxo"
          >
            <Settings size={14} />
          </button>

          {readOnly ? (
            <span className="flex h-9 items-center gap-2 rounded-[3px] border border-slate-300 bg-slate-100 px-3 font-mono text-[10px] font-bold uppercase text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              Somente visualização
            </span>
          ) : <>
          <button
            type="button"
            onClick={() => setFlowTest((current) => ({ ...current, open: true }))}
            className="grid h-9 w-9 place-items-center rounded-[3px] border border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
            aria-label="Testar fluxo"
            title="Testar fluxo"
          >
            <Play size={14} />
          </button>

          <button
            onClick={() => save(false)}
            disabled={Boolean(saveStatus)}
            className="flex h-9 items-center gap-2 rounded-[3px] border border-slate-400 bg-slate-100 px-3 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Save size={14} />
            <span className="hidden sm:inline">Salvar</span>
          </button>

          <button
            onClick={() => save(true)}
            disabled={Boolean(saveStatus)}
            className="flex h-9 items-center gap-2 rounded-[3px] border border-slate-950 bg-slate-950 px-3 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
          >
            <Rocket size={14} />
            <span>Publicar</span>
          </button>
          </>}
        </div>
      </header>
      )}

      <div style={{ flex: 1 }} className={`flow-editor-canvas relative ${presentationMode ? 'min-h-screen bg-[#07111f]' : (embedded ? 'min-h-0' : 'min-h-[60vh]')}`}>
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={flowNodes} edges={displayEdges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onConnectEnd={handleConnectEnd}
          onDrop={handlePaletteDrop}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onPaneClick={() => {
            setSelectionActionsOpen(false);
            setCanvasMenuOpen(false);
            setFlowSettingsOpen(false);
            setSelectedVisualBlockId(null);
          }}
          onMove={(_, nextViewport) => setViewport(nextViewport)}
          nodeTypes={isSubflow ? subflowNodeTypes : nodeTypes}
          edgeTypes={edgeTypes}
          connectionLineComponent={FlowConnectionLine}
          fitView
          snapToGrid={true}
          snapGrid={[20, 20]}
          selectionOnDrag={true}
          panOnDrag={[2]}
          nodesDraggable={!presentationMode && !readOnly && !rigidLayout}
          // Duplo clique e do node (abre a configuracao). Com o arrasto travado, o
          // node perde a marca nopan e o zoom do canvas engoliria o duplo clique.
          zoomOnDoubleClick={false}
          onNodeMouseEnter={(_, node) => showNextButton(node.id)}
          onNodeMouseLeave={hideNextButtonSoon}
          nodesConnectable={!presentationMode && !readOnly}
          edgesReconnectable={!readOnly}
          deleteKeyCode={readOnly ? null : undefined}
          elementsSelectable={!presentationMode}
          edgesFocusable={!presentationMode}
          nodesFocusable={!presentationMode}
        >
          <Background
            id="fine-grid"
            color={isDark ? '#334155' : '#cbd5e1'}
            gap={20}
            size={1}
          />
          <Background
            id="wide-grid"
            color={isDark ? '#475569' : '#94a3b8'}
            gap={100}
            size={1.25}
          />
          {showMiniMap && !presentationMode && (
            <MiniMap
              className={`!absolute !bottom-4 !h-36 !w-52 overflow-hidden !rounded-[3px] !border !border-slate-500 !bg-slate-100/95 !shadow-[5px_6px_0_rgba(15,23,42,0.16)] !transition-[right] !duration-200 dark:!bg-slate-900/95 ${(problemsOpen || variablesOpen) ? '!right-[400px]' : '!right-4'}`}
              nodeColor={(node) => {
                if (node.type === 'startNode') return '#10b981';
                if (node.type === 'finalNode' || node.type === 'endNode') return '#ef4444';
                if (node.type === 'conditionNode') return '#7c3aed';
                if (node.type === 'caseNode') return '#94a3b8';
                return '#38bdf8';
              }}
              nodeStrokeColor={(node) => (node.selected ? '#0ea5e9' : 'transparent')}
              nodeStrokeWidth={4}
              maskColor={isDark ? 'rgba(15,23,42,0.62)' : 'rgba(226,232,240,0.64)'}
              pannable
              zoomable
            />
          )}
        </ReactFlow>
        {quickCreate && !presentationMode && !readOnly && (
          <QuickNodePicker
            point={quickCreate.screen}
            isManager={isManager}
            isSuperAdmin={isSuperAdmin}
            isSubflow={isSubflow}
            onClose={() => setQuickCreate(null)}
            onSelect={(type) => {
              createNode(type, quickCreate.position, quickCreate.connection);
              setQuickCreate(null);
            }}
          />
        )}
        {canvasSearch.open && !presentationMode && (
          <CanvasNodeSearch
            value={canvasSearch.query}
            resultCount={canvasSearchResults.length}
            activeIndex={canvasSearch.index}
            onChange={(query) => setCanvasSearch({ open: true, query, index: 0 })}
            onNavigate={focusCanvasSearchResult}
            onClose={() => {
              setCanvasSearch({ open: false, query: '', index: 0 });
              setNodes((current) => current.map((node) => ({ ...node, selected: false })));
            }}
          />
        )}
        {!presentationMode && (
        <FlowProblemsPanel
            open={problemsOpen}
            problems={flowProblems}
            onClose={() => setProblemsOpen(false)}
            onSelect={focusProblemNode}
          />
        )}
        {!presentationMode && (
          <FlowVariablesPanel
            open={variablesOpen}
            usage={variableUsage}
            onClose={() => setVariablesOpen(false)}
            onSelectNode={focusProblemNode}
          />
        )}
        <FlowTestPanel
          open={flowTest.open}
          session={flowTest.session}
          busy={flowTest.busy}
          onStart={startFlowTest}
          onSend={sendFlowTestInput}
          onClose={closeFlowTest}
        />
        {!presentationMode && !readOnly && (
          <NodePalette
            isManager={isManager}
            isSuperAdmin={isSuperAdmin}
            onCreateNode={createNode}
            isSubflow={isSubflow}
            snippets={flowSnippets}
            onDeleteSnippet={deleteFlowSnippet}
            onInsertSnippet={insertFlowSnippet}
          />
        )}
        {nextButtonNode && (
          <NextNodeButton
            key={nextButtonNode.id}
            node={nextButtonNode}
            onEnter={() => showNextButton(nextButtonNode.id)}
            onLeave={hideNextButtonSoon}
            onPick={openNextNodePicker}
          />
        )}
        {anchorButtonNode && (
          <AnchorButton
            key={`ancora_${anchorButtonNode.id}`}
            node={anchorButtonNode}
            onEnter={() => showNextButton(anchorButtonNode.id)}
            onLeave={hideNextButtonSoon}
            onPick={createDockedAnchor}
          />
        )}
        {!presentationMode && showCanvasHint && (
          <div className="absolute bottom-[22px] left-[64px] z-20 hidden items-center gap-2 rounded-[2px] border border-slate-400 bg-slate-100/95 py-1 pl-2.5 pr-1 text-[11px] text-slate-500 shadow-[3px_3px_0_rgba(15,23,42,0.12)] sm:flex dark:border-slate-600 dark:bg-slate-900/95 dark:text-slate-400">
            <span>
              <strong className="font-semibold text-slate-700 dark:text-slate-200">Botão direito + arrastar</strong> move
              <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
              <strong className="font-semibold text-slate-700 dark:text-slate-200">Rolar</strong> dá zoom
              <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
              <strong className="font-semibold text-slate-700 dark:text-slate-200">Duplo clique</strong> abre o bloco
            </span>
            <button
              type="button"
              onClick={dismissCanvasHint}
              className="grid h-5 w-5 place-items-center rounded-[2px] text-slate-400 transition-colors hover:bg-slate-300 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="Fechar dica"
              title="Fechar dica"
            >
              <X size={12} />
            </button>
          </div>
        )}
        {!presentationMode && (
        <CanvasNavigationPanel
          open={canvasMenuOpen}
          showMiniMap={showMiniMap}
          selectedCount={selectedNodes.length}
          selectedBlock={selectedVisualBlock}
          onFitAll={zoomToAll}
          onFitSelection={zoomToSelection}
          onFitBlock={zoomToSelectedBlock}
          onToggleOpen={() => setCanvasMenuOpen((current) => !current)}
          onToggleMiniMap={() => setShowMiniMap((current) => !current)}
          onPresentation={enterPresentationMode}
        />
        )}
        <VisualBlocksLayer
          blocks={visualBlocks}
          viewport={viewport}
          selectedBlockId={selectedVisualBlockId}
          onSelect={selectVisualBlock}
          onRemove={removeVisualBlock}
        />
        {presentationMode && (
          <PresentationOverlay
            flowName={flowName}
            selectedNode={selectedNodes[0]}
            onFit={() => fitView({ padding: 0.22, duration: 520 })}
            onExit={exitPresentationMode}
          />
        )}
        {!presentationMode && selectedNodes.length > 0 && selectionActionPoint && (
          <SelectionActionHint
            readOnly={readOnly}
            point={selectionActionPoint}
            open={selectionActionsOpen}
            selectedCount={selectedNodes.length}
            canEdit={selectedNodes.length === 1 && !onlyStartSelected}
            canDelete={!onlyStartSelected}
            canToggleDisabled={canToggleSelectedNodes}
            disabledState={selectedNodesAreDisabled}
            onCopy={() => {
              copySelectedNodes();
              setSelectionActionsOpen(false);
            }}
            onDuplicate={duplicateSelectedNodes}
            onDelete={deleteSelectedNodes}
            onCreateBlock={createVisualBlockFromSelection}
            onSaveSnippet={() => setSnippetModal({ open: true, name: '' })}
            onToggleDisabled={toggleSelectedNodesDisabled}
            onEdit={() => {
              if (selectedNodes.length === 1) {
                openConfig(selectedNodes[0].id);
                setSelectionActionsOpen(false);
              }
            }}
          />
        )}
      </div>

      {inactivityModalOpen && (
        <div className="ui-overlay-fade fixed inset-0 z-[9999] grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[6px_8px_0_rgba(15,23,42,0.2)] dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3 border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
              <div className="min-w-0">
                <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Configurações do fluxo</p>
                <h3 className="font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">Inatividade</h3>
              </div>
              <button type="button" onClick={() => setInactivityModalOpen(false)} aria-label="Fechar" className="grid h-7 w-7 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><X size={15} /></button>
            </div>
            <div className="space-y-4 p-4">
              <label className="block">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Tempo máximo (horas)</span>
                <input
                  type="number"
                  min="0"
                  className="mt-1.5 w-full rounded-[2px] border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
                  value={inactivityConfig.inactivityMaxHours}
                  onChange={e => setInactivityConfig(prev => ({ ...prev, inactivityMaxHours: Number(e.target.value) || 0 }))}
                />
                <span className="block mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">0 desativa o encerramento automático.</span>
              </label>
              <label className="block">
                <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Mensagem ao encerrar</span>
                <textarea
                  className="mt-1.5 w-full rounded-[2px] border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300 h-24 resize-y"
                  value={inactivityConfig.inactivityMessage}
                  onChange={e => setInactivityConfig(prev => ({ ...prev, inactivityMessage: e.target.value }))}
                  placeholder="Atendimento encerrado por inatividade."
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-400 bg-slate-200 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800">
              <button type="button" onClick={() => setInactivityModalOpen(false)} className="h-9 rounded-[2px] border border-slate-500 bg-slate-100 px-4 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button>
              <button type="button" onClick={saveInactivityConfig} disabled={inactivitySaving} className="h-9 rounded-[2px] border border-slate-950 bg-slate-950 px-4 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">
                {inactivitySaving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const VisualBlockNameModal = ({ open, mode, title, note, onChangeTitle, onChangeNote, onClose, onSubmit }) => {
  if (!open) return null;

  const isRename = mode === 'rename';

  return (
    <div className="ui-overlay-fade fixed inset-0 z-[9999] grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="node-config-modal-surface w-full max-w-sm overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[6px_8px_0_rgba(15,23,42,0.2)] dark:bg-slate-900"
      >
        <div className="border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Bloco visual</p>
          <h3 className="font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">
            {isRename ? 'Renomear bloco' : 'Nomear novo bloco'}
          </h3>
        </div>
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Nome</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => onChangeTitle(event.target.value)}
              placeholder="Comandos"
              className="mt-1.5 w-full rounded-[2px] border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
            />
            <span className="block mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">O título aparece no canvas como ## Nome do bloco.</span>
          </label>
          <label className="block">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Nota do bloco</span>
            <textarea
              value={note}
              onChange={(event) => onChangeNote(event.target.value)}
              placeholder="Explique a finalidade deste trecho..."
              className="mt-1.5 w-full rounded-[2px] border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300 min-h-24 resize-y"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-400 bg-slate-200 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800">
          <button type="button" onClick={onClose} className="h-9 rounded-[2px] border border-slate-500 bg-slate-100 px-4 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button>
          <button type="submit" className="h-9 rounded-[2px] border border-slate-950 bg-slate-950 px-4 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">{isRename ? 'Salvar nome' : 'Criar bloco'}</button>
        </div>
      </form>
    </div>
  );
};

const CanvasNavigationPanel = ({
  open,
  showMiniMap,
  selectedCount,
  selectedBlock,
  onFitAll,
  onFitSelection,
  onFitBlock,
  onToggleOpen,
  onToggleMiniMap,
  onPresentation
}) => (
  <div className="pointer-events-none absolute bottom-4 left-4 z-40">
    <div className="pointer-events-auto flex items-end gap-2">
      <button
        type="button"
        onClick={onToggleOpen}
        className={`grid h-9 w-9 place-items-center rounded-[3px] border shadow-[3px_3px_0_rgba(15,23,42,0.12)] transition-colors ${
          open
            ? 'border-slate-950 bg-slate-300 text-slate-950 dark:border-slate-200 dark:bg-slate-700 dark:text-white'
            : 'border-slate-400 bg-slate-100 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
        }`}
        title={open ? 'Fechar menu do canvas' : 'Abrir menu do canvas'}
      >
        <Menu size={15} />
      </button>

      {open && (
        <div className="animate-[nodeConfigPop_180ms_ease-out] overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[5px_6px_0_rgba(15,23,42,0.16)] dark:bg-slate-900">
          <div className="border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
            <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Canvas</p>
          </div>
          <div className="grid p-1">
            <CanvasNavButton icon={Maximize2} label="Encaixar tudo" onClick={onFitAll} />
            <CanvasNavButton
              icon={Circle}
              label={selectedCount ? `Focar selecao (${selectedCount})` : 'Focar selecao'}
              onClick={onFitSelection}
              muted={!selectedCount}
            />
            <CanvasNavButton
              icon={Layers3}
              label={selectedBlock ? `Focar ${selectedBlock.title}` : 'Focar bloco'}
              onClick={onFitBlock}
              muted={!selectedBlock}
            />
            <CanvasNavButton
              icon={showMiniMap ? EyeOff : MapIcon}
              label={showMiniMap ? 'Ocultar minimapa' : 'Mostrar minimapa'}
              onClick={onToggleMiniMap}
            />
            <CanvasNavButton icon={MonitorPlay} label="Modo apresentacao" onClick={onPresentation} />
          </div>
        </div>
      )}
    </div>
  </div>
);

const PresentationOverlay = ({ flowName, selectedNode, onFit, onExit }) => (
  <>
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-slate-950/78 via-slate-950/34 to-transparent px-6 py-5 text-white">
      <div className="pointer-events-auto flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-300/80">Modo apresentacao</p>
          <h1 className="mt-1 max-w-[720px] truncate text-2xl font-black">{flowName || 'Fluxo'}</h1>
          <p className="mt-1 text-xs font-medium text-slate-300">
            {selectedNode
              ? `Node selecionado: ${selectedNode.data?.customName || selectedNode.data?.label || selectedNode.data?.text || selectedNode.type}`
              : 'Selecione um node antes de apresentar para destacar o caminho.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onFit}
            className="h-9 rounded-[2px] border border-white/30 bg-white/10 px-4 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-white/20"
          >
            Encaixar fluxo
          </button>
          <button
            type="button"
            onClick={onExit}
            className="h-9 rounded-[2px] bg-white px-4 font-mono text-[10px] font-bold uppercase text-slate-950 transition-colors hover:bg-slate-200"
          >
            Sair ESC
          </button>
        </div>
      </div>
    </div>
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-slate-950/65 to-transparent px-6 py-5 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-slate-300">
      Arraste para navegar • Scroll para zoom • F para encaixar • ESC para sair
    </div>
  </>
);

const CanvasNavButton = ({ icon: Icon, label, onClick, muted = false }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
      muted
        ? 'text-slate-400 hover:bg-slate-200/60 dark:text-slate-500 dark:hover:bg-slate-800/60'
        : 'text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800'
    }`}
  >
    <Icon size={14} />
    <span className="max-w-[150px] truncate">{label}</span>
  </button>
);

const VisualBlocksLayer = ({ blocks, viewport, selectedBlockId, onSelect, onRemove }) => (
  <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
    {normalizeVisualBlocks(blocks).map((block) => {
      const topLeft = toScreenPoint({ x: block.bounds.x, y: block.bounds.y }, viewport);
      const width = block.bounds.width * viewport.zoom;
      const height = block.bounds.height * viewport.zoom;
      const selected = block.id === selectedBlockId;
      return (
        <div
          key={block.id}
          className={`absolute rounded-[4px] border border-dashed shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] transition-[opacity,box-shadow,transform] duration-200 ${
            selected ? 'ring-2 ring-slate-900/70 ring-offset-2 ring-offset-transparent dark:ring-slate-200/70' : ''
          }`}
          style={{
            left: topLeft.x,
            top: topLeft.y,
            width,
            height,
            borderColor: block.color,
            background: block.color,
            opacity: selected ? Math.min(Number(block.opacity || 0.09) + 0.08, 0.24) : block.opacity
          }}
        />
      );
    })}
    {normalizeVisualBlocks(blocks).map((block) => {
      const titlePoint = toScreenPoint({ x: block.bounds.x + 18, y: block.bounds.y + 14 }, viewport);
      const selected = block.id === selectedBlockId;
      return (
        <div
          key={`${block.id}_title`}
          className="absolute flex items-center gap-2"
          style={{ left: titlePoint.x, top: titlePoint.y }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(block.id);
            }}
            className={`pointer-events-auto select-none rounded-[2px] px-2 py-1 text-left text-lg font-black uppercase tracking-[0.18em] transition-colors ${
              selected
                ? 'bg-slate-100/90 text-slate-900 dark:bg-slate-900/90 dark:text-slate-100'
                : 'text-slate-400/65 hover:bg-white/70 hover:text-slate-600 dark:text-slate-500/70 dark:hover:bg-slate-950/50 dark:hover:text-slate-300'
            }`}
          >
            {block.title}
          </button>
          <button
            type="button"
            onClick={() => onRemove(block.id)}
            className="pointer-events-auto rounded-[2px] border border-slate-400 bg-slate-100/90 p-1 text-slate-500 hover:border-red-500 hover:text-red-600 dark:border-slate-600 dark:bg-slate-900/90 opacity-70 hover:opacity-100 focus:opacity-100 transition-opacity"
            title="Remover bloco visual"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    })}
  </div>
);

const SelectionActionHint = ({
  point,
  open,
  selectedCount,
  canEdit,
  canDelete,
  canToggleDisabled,
  disabledState,
  onCopy,
  onDuplicate,
  onDelete,
  onCreateBlock,
  onSaveSnippet,
  onToggleDisabled,
  onEdit,
  readOnly = false
}) => (
  <div
    className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full"
    style={{ left: point.x, top: point.y - 14 }}
  >
    {!open ? (
      <div className="rounded-[2px] border border-slate-400 bg-slate-100/95 font-mono text-[10px] font-bold uppercase text-slate-600 shadow-[3px_3px_0_rgba(15,23,42,0.12)] dark:border-slate-600 dark:bg-slate-900/95 dark:text-slate-300 px-2 py-1">
        ALT = ações
      </div>
    ) : (
      <div className="pointer-events-auto min-w-[210px] overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[5px_6px_0_rgba(15,23,42,0.16)] dark:bg-slate-900 animate-[nodeConfigPop_180ms_ease-out]">
        <div className="border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Seleção</p>
          <p className="text-xs font-semibold text-slate-950 dark:text-slate-100">
            {selectedCount === 1 ? '1 node selecionado' : `${selectedCount} nodes selecionados`}
          </p>
        </div>
        <div className="p-1">
          {canEdit && (
            <SelectionActionButton icon={readOnly ? Eye : Pencil} label={readOnly ? 'Ver configuracao' : 'Editar configuracao'} onClick={onEdit} />
          )}
          <SelectionActionButton icon={Copy} label="Copiar" onClick={onCopy} />
          {!readOnly && <>
          <SelectionActionButton icon={Clipboard} label="Duplicar" onClick={onDuplicate} />
          <SelectionActionButton icon={Layers3} label="Criar bloco visual" onClick={onCreateBlock} />
          <SelectionActionButton icon={Save} label="Salvar como trecho" onClick={onSaveSnippet} />
          {canToggleDisabled && (
            <SelectionActionButton
              icon={disabledState ? Play : EyeOff}
              label={disabledState ? 'Ativar selecao' : 'Desativar selecao'}
              onClick={onToggleDisabled}
            />
          )}
          {canDelete && (
            <SelectionActionButton icon={Trash2} label="Excluir selecao" onClick={onDelete} danger />
          )}
          </>}
        </div>
      </div>
    )}
  </div>
);

const SelectionActionButton = ({ icon: Icon, label, onClick, danger = false }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
      danger
        ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
        : 'text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800'
    }`}
  >
    <Icon size={14} />
    {label}
  </button>
);

const normalizePaletteSearch = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

// Botao + na saida do node: abre a lista de nodes e o escolhido nasce ligado,
// na distancia fixa do layout.
const NextNodeButton = ({ node, onEnter, onLeave, onPick }) => {
  const viewport = useViewport();
  const reduceMotion = useReducedMotion();
  const ponto = toScreenPoint({
    x: Number(node.position?.x || 0) + layoutWidth(node),
    y: Number(node.position?.y || 0) + 20
  }, viewport);
  return (
    <motion.button
      type="button"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(event) => onPick(node, event.currentTarget.getBoundingClientRect())}
      className="nodrag nopan absolute z-30 grid h-6 w-6 place-items-center rounded-[2px] border border-slate-950 bg-slate-950 text-white shadow-[2px_2px_0_rgba(15,23,42,0.18)] transition-colors hover:bg-slate-700 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
      style={{ left: ponto.x + 14, top: ponto.y, y: '-50%' }}
      aria-label="Adicionar o próximo node"
      title="Adicionar o próximo node"
    >
      <Plus size={14} strokeWidth={2.5} />
    </motion.button>
  );
};

// Botao de ancora na entrada do node: cria a ancora presa em cima dele.
const AnchorButton = ({ node, onEnter, onLeave, onPick }) => {
  const viewport = useViewport();
  const reduceMotion = useReducedMotion();
  const ponto = toScreenPoint({ x: Number(node.position?.x || 0), y: Number(node.position?.y || 0) + 20 }, viewport);
  return (
    <motion.button
      type="button"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() => onPick(node)}
      className="nodrag nopan absolute z-30 grid h-6 w-6 place-items-center rounded-[2px] border border-slate-400 bg-white text-slate-700 shadow-[2px_2px_0_rgba(15,23,42,0.12)] transition-colors hover:border-slate-950 hover:text-slate-950 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-100 dark:hover:text-white"
      style={{ left: ponto.x - 14 - 24, top: ponto.y, y: '-50%' }}
      aria-label="Criar âncora neste node"
      title="Criar âncora neste node"
    >
      <Anchor size={13} strokeWidth={2.25} />
    </motion.button>
  );
};

const QuickNodePicker = ({ point, isManager, isSuperAdmin, isSubflow = false, onSelect, onClose }) => {
  const [query, setQuery] = useState('');
  const normalizedQuery = normalizePaletteSearch(query);
  const choices = NODE_PALETTE_GROUPS.flatMap((group) => group.nodes)
    .filter((node) => (!node.superAdminOnly || isSuperAdmin) && (!node.adminOnly || !isManager) && !(isSubflow && SUBFLOW_BLOCKED_TYPES.includes(node.type)))
    .filter((node) => !normalizedQuery || normalizePaletteSearch(`${node.label} ${node.code} ${node.description}`).includes(normalizedQuery));

  return (
    <div
      className="fixed z-[80] w-64 border border-slate-500 bg-slate-100 shadow-[5px_6px_0_rgba(15,23,42,0.18)] dark:bg-slate-900"
      style={{ left: Math.min(point.x, window.innerWidth - 280), top: Math.min(point.y, window.innerHeight - 390) }}
    >
      <div className="flex items-center border-b border-slate-400 p-2 dark:border-slate-600">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
          placeholder="Criar node..."
          className="h-8 min-w-0 flex-1 border border-slate-400 bg-white px-2 font-mono text-[10px] outline-none focus:border-slate-950 dark:bg-slate-950 dark:text-slate-100"
        />
        <button type="button" onClick={onClose} className="ml-2 h-8 px-2 text-xs text-slate-500 hover:text-slate-950 dark:hover:text-white">Esc</button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {choices.map((node) => (
          <button
            key={node.type}
            type="button"
            onClick={() => onSelect(node.type)}
            className="grid w-full grid-cols-[42px_1fr] border-b border-slate-300 text-left hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <span className="grid min-h-11 place-items-center border-r border-slate-300 font-mono text-[8px] font-black text-slate-500 dark:border-slate-700">{node.code}</span>
            <span className="px-3 py-2 text-[11px] font-semibold text-slate-900 dark:text-slate-100">{node.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

const CanvasNodeSearch = ({ value, resultCount, activeIndex, onChange, onNavigate, onClose }) => (
  <div className="absolute left-1/2 top-3 z-[90] flex h-10 w-[min(460px,calc(100%-32px))] -translate-x-1/2 items-center border border-slate-500 bg-slate-100 shadow-[4px_5px_0_rgba(15,23,42,0.16)] dark:bg-slate-900">
    <Search size={14} className="ml-3 shrink-0 text-slate-500" />
    <input
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'Enter') {
          event.preventDefault();
          onNavigate(activeIndex + (event.shiftKey ? -1 : 1));
        }
      }}
      placeholder="Buscar por nome, texto, tipo ou variavel"
      className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[11px] text-slate-950 outline-none dark:text-slate-100"
    />
    <span className="border-l border-slate-400 px-3 font-mono text-[9px] text-slate-500 dark:border-slate-600">
      {resultCount ? `${activeIndex + 1}/${resultCount}` : '0'}
    </span>
  </div>
);

const NodePalette = ({ isManager, isSuperAdmin, isSubflow = false, onCreateNode, snippets = [], onInsertSnippet, onDeleteSnippet }) => {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({ flow: true, data: true, routing: true });
  const normalizedQuery = normalizePaletteSearch(query);

  const groups = NODE_PALETTE_GROUPS.map((group) => ({
    ...group,
    nodes: group.nodes.filter((node) => {
      if (node.superAdminOnly && !isSuperAdmin) return false;
      if (node.adminOnly && isManager) return false;
      if (isSubflow && SUBFLOW_BLOCKED_TYPES.includes(node.type)) return false;
      if (!normalizedQuery) return true;
      return normalizePaletteSearch(`${node.label} ${node.code} ${node.description} ${group.label}`).includes(normalizedQuery);
    })
  })).filter((group) => group.nodes.length > 0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute left-3 top-3 z-30 grid h-10 w-10 place-items-center rounded-[3px] border border-slate-500 bg-slate-200 text-slate-800 shadow-[3px_4px_0_rgba(15,23,42,0.14)] hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-100"
        title="Abrir paleta de nodes"
      >
        <PanelLeftOpen size={16} />
      </button>
    );
  }

  return (
    <aside className="absolute bottom-20 left-3 top-3 z-30 flex w-[264px] flex-col overflow-hidden rounded-[3px] border border-slate-500 bg-slate-100 shadow-[4px_6px_0_rgba(15,23,42,0.14)] dark:bg-slate-900">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-500 bg-slate-300 px-3 dark:bg-slate-800">
        <div>
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Paleta</p>
          <p className="font-mono text-[11px] font-black uppercase text-slate-950 dark:text-slate-100">Adicionar node</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="grid h-7 w-7 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-700 hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-200"
          title="Recolher paleta"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="shrink-0 border-b border-slate-400 bg-slate-200 p-2 dark:bg-slate-800/70">
        <label className="relative block">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar node..."
            className="h-8 w-full rounded-[2px] border border-slate-400 bg-slate-100 pl-8 pr-2 font-mono text-[10px] text-slate-950 outline-none placeholder:text-slate-500 focus:border-slate-950 focus:ring-1 focus:ring-slate-950 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {snippets.length > 0 && (
          <section className="border-b border-slate-400">
            <div className="bg-slate-200 px-3 py-2 font-mono text-[9px] font-black uppercase tracking-[0.1em] text-slate-800 dark:bg-slate-800 dark:text-slate-100">
              Trechos reutilizaveis
            </div>
            {snippets.map((snippet) => (
              <div key={snippet.id} className="group grid grid-cols-[42px_minmax(0,1fr)_32px] border-t border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800">
                <button type="button" onClick={() => onInsertSnippet?.(snippet)} title={`Inserir "${snippet.name}"`} className="grid min-h-11 place-items-center border-r border-slate-300 font-mono text-[8px] font-black dark:border-slate-700">BLK</button>
                <button type="button" onClick={() => onInsertSnippet?.(snippet)} className="min-w-0 px-3 py-2 text-left">
                  <strong className="block truncate text-[10px]">{snippet.name}</strong>
                  <small className="text-[9px] text-slate-500">{snippet.nodes?.length || 0} nodes</small>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteSnippet?.(snippet)}
                  title={`Excluir "${snippet.name}"`}
                  aria-label={`Excluir trecho ${snippet.name}`}
                  className="grid place-items-center text-slate-400 opacity-0 transition-opacity hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </section>
        )}
        {groups.map((group) => {
          const isCollapsed = !normalizedQuery && Boolean(collapsed[group.id]);
          return (
            <section key={group.id} className="border-b border-slate-400 last:border-b-0">
              <button
                type="button"
                onClick={() => setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))}
                className="flex h-9 w-full items-center gap-2 bg-slate-200 px-3 text-left hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="flex-1 font-mono text-[9px] font-black uppercase tracking-[0.1em] text-slate-800 dark:text-slate-100">{group.label}</span>
                <span className="font-mono text-[8px] text-slate-500 dark:text-slate-400">{group.nodes.length}</span>
              </button>

              {!isCollapsed && (
                <div className="divide-y divide-slate-300 dark:divide-slate-700">
                  {group.nodes.map((node) => (
                    <button
                      key={node.type}
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData('application/onion-node', node.type);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => onCreateNode(node.type)}
                      className="group grid w-full grid-cols-[42px_minmax(0,1fr)] items-stretch bg-slate-100 text-left transition-colors hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800"
                    >
                      <span className="flex min-h-[52px] items-center justify-center border-r border-slate-300 bg-slate-200/70 px-1 font-mono text-[8px] font-black uppercase text-slate-600 group-hover:bg-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {node.code}
                      </span>
                      <span className="flex min-w-0 flex-col justify-center px-2.5 py-2">
                        <span className="truncate font-mono text-[10px] font-bold text-slate-950 dark:text-slate-100">{node.label}</span>
                        <span className="mt-0.5 line-clamp-2 text-[9px] leading-tight text-slate-500 dark:text-slate-400">{node.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {groups.length === 0 && (
          <div className="p-4 font-mono text-[10px] text-slate-500">Nenhum node encontrado.</div>
        )}
      </div>
    </aside>
  );
};

const SnippetNameModal = ({ open, value, onChange, onClose, onSubmit }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} className="w-full max-w-sm border border-slate-500 bg-slate-100 shadow-[6px_8px_0_rgba(15,23,42,0.2)] dark:bg-slate-900">
        <div className="border-b border-slate-400 bg-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800"><p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Biblioteca</p><h3 className="font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">Salvar trecho reutilizável</h3></div>
        <div className="p-5"><label className="font-mono text-[9px] font-bold uppercase text-slate-500">Nome</label><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-10 w-full border border-slate-400 bg-white px-3 text-sm outline-none focus:border-slate-950 dark:bg-slate-950" /></div>
        <div className="flex justify-end gap-2 border-t border-slate-400 bg-slate-200 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800"><button type="button" onClick={onClose} className="h-9 rounded-[2px] border border-slate-500 bg-slate-100 px-4 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button><button type="submit" disabled={!value.trim()} className="h-9 rounded-[2px] border border-slate-950 bg-slate-950 px-4 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">Salvar</button></div>
      </form>
    </div>
  );
};

export default (props) => (<ReactFlowProvider><FlowEditor {...props} /></ReactFlowProvider>);
