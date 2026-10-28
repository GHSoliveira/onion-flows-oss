import { useEffect, useMemo, useState } from 'react';

export const DEFAULT_PAGE_SIZE = 20;

/**
 * Paginacao client-side para listas que ja estao inteiras em memoria.
 *
 * Nao serve para as telas que paginam no servidor (logs, historico de chats,
 * contatos): essas continuam pedindo pagina por pagina para a API.
 */
export const usePagination = (items, pageSize = DEFAULT_PAGE_SIZE) => {
  const list = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const [page, setPage] = useState(1);

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Um filtro pode encolher a lista enquanto o usuario esta numa pagina alta.
  // Sem este ajuste a tabela ficaria vazia sem explicacao nenhuma.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = useMemo(() => list.slice(start, start + pageSize), [list, start, pageSize]);

  return {
    page: safePage,
    setPage,
    totalPages,
    pageItems,
    total,
    pageSize,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
  };
};

/**
 * Barra de paginacao. Some sozinha quando tudo cabe numa pagina so, entao
 * pode ser colocada abaixo de qualquer tabela sem poluir as listas curtas.
 */
const TablePagination = ({ page, totalPages, setPage, total, from, to, label = 'registros', className = '' }) => {
  if (!totalPages || totalPages <= 1) return null;

  // Tudo alinhado a esquerda de proposito: varias destas tabelas ficam dentro de
  // um container com overflow-x-auto e sao mais largas que a tela no celular.
  // Com justify-between os botoes cairiam na ponta direita, fora da area visivel
  // ate o usuario rolar a tabela de lado.
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs dark:border-slate-800 dark:bg-slate-950/40 ${className}`}
    >
      <span className="font-mono text-slate-500 dark:text-slate-400">
        {from}-{to} de {total} {label}
      </span>
      <div className="flex items-center gap-2 font-mono text-slate-500 dark:text-slate-400">
        <button
          type="button"
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="border border-slate-300 px-2 py-1 transition hover:border-blue-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700"
        >
          Anterior
        </button>
        <span>
          Pagina {page} de {totalPages}
        </span>
        <button
          type="button"
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="border border-slate-300 px-2 py-1 transition hover:border-blue-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700"
        >
          Proxima
        </button>
      </div>
    </div>
  );
};

export default TablePagination;
