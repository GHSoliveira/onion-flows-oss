import React, { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath
} from 'reactflow';

const TONE_STYLES = {
  default: {
    stroke: '#64748b',
    activeStroke: 'var(--flow-edge-active)' 
  },
  error: {
    stroke: '#dc2626',
    activeStroke: '#991b1b'
  },
  muted: {
    stroke: '#94a3b8',
    activeStroke: '#475569'
  }
};

export const EDGE_STROKE_WIDTH = 1.5;

// Linha que aparece enquanto se arrasta uma conexao nova: mesmo traçado em
// angulo reto e mesma espessura da conexao pronta, para nao "virar" ao soltar.
export const FlowConnectionLine = ({ fromX, fromY, toX, toY, fromPosition, toPosition }) => {
  const [path] = getSmoothStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    borderRadius: 0,
    offset: 18
  });
  return (
    <g>
      <path d={path} fill="none" stroke="var(--flow-edge-active)" strokeWidth={EDGE_STROKE_WIDTH} strokeDasharray="4 3" />
      <rect x={toX - 3} y={toY - 3} width={6} height={6} fill="var(--flow-edge-active)" />
    </g>
  );
};

const FlowEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  selected
}) => {
  const [hovered, setHovered] = useState(false);
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    // borderRadius 0 = cantos em angulo reto (traçado "reto", nao curvo). Varias
    // arestas saindo do mesmo handle compartilham o primeiro trecho e se dividem
    // em angulo, dando o efeito de uma conexao unica que se ramifica.
    borderRadius: 0,
    offset: 18
  });

  const tone = TONE_STYLES[data?.tone] || TONE_STYLES.default;
  const active = Boolean(data?.active || selected);
  const dimmed = Boolean(data?.dimmed && !active);

  // Espessura e cor fixas: o destaque do caminho selecionado muda so o tom.
  // Cor gravada na aresta (ex.: ramos antigos de template) e ignorada para
  // todas as conexoes terem o mesmo traço.
  const composedStyle = {
    stroke: active ? tone.activeStroke : tone.stroke,
    strokeWidth: EDGE_STROKE_WIDTH,
    opacity: dimmed ? 0.35 : 1,
    transition: 'stroke 120ms linear, opacity 120ms linear'
  };

  if (data?.dashed) {
    composedStyle.strokeDasharray = '4 3';
  }

  const middleX = (sourceX + targetX) / 2;
  const middleY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={composedStyle} interactionWidth={16} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} />
      {typeof data?.onDelete === 'function' && (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onDelete();
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className={`nodrag nopan absolute grid h-5 w-5 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-[11px] font-bold text-slate-600 transition-opacity hover:border-red-600 hover:text-red-600 dark:bg-slate-900 dark:text-slate-300 ${hovered || selected ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
            style={{ transform: `translate(-50%, -50%) translate(${middleX}px, ${middleY}px)` }}
            title="Remover conexao"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

export default FlowEdge;
