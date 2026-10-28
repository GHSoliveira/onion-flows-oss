import { useState } from 'react';
import { Download, FileText, Loader2, Package } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE } from '../services/api';

/**
 * Página de Relatórios — disponível para MANAGER e ADMIN.
 * Lista os relatórios CSV que o backend expõe em /api/reports/*. Cada item
 * dispara download autenticado via fetch com Bearer (atributo download não
 * funciona com header Authorization).
 */

const REPORTS = [
  { key: 'resumo-geral', label: 'Resumo geral', description: 'Visão consolidada do tenant no período.' },
  { key: 'conversas', label: 'Conversas', description: 'Lista detalhada de atendimentos com duração e status.' },
  { key: 'mensagens', label: 'Mensagens', description: 'Volume de mensagens por canal e direção.' },
  { key: 'filas', label: 'Filas', description: 'Tempo de espera médio, abandono e throughput por fila.' },
  { key: 'agentes', label: 'Desempenho dos agentes', description: 'Tempo de resposta, atendimentos, avaliação média.' },
  { key: 'fluxo-nodes', label: 'Nós do fluxo', description: 'Engajamento por nó (timeout, abandono, conversão).' },
  { key: 'campanhas', label: 'Campanhas ativas', description: 'Resultados de outreach por campanha.' },
  { key: 'templates-whatsapp', label: 'Templates WhatsApp', description: 'Aprovados, recusados, em uso.' },
  { key: 'erros', label: 'Erros do sistema', description: 'Falhas técnicas registradas no período.' }
];

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

const downloadFile = async (url, fallbackName) => {
  const token = localStorage.getItem('token');
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Falha ao baixar (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
};

const buildQuery = (filters) => {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const tenantId = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('selectedTenant') || 'null');
      return saved?.id && saved.id !== 'super_admin' ? saved.id : null;
    } catch {
      return null;
    }
  })();
  if (tenantId) params.set('tenantId', tenantId);
  return params.toString();
};

const ReportsCenter = () => {
  const [filters, setFilters] = useState({ from: monthAgo(), to: today() });
  const [loadingKey, setLoadingKey] = useState(null);

  const handleDownload = async (key, label) => {
    setLoadingKey(key);
    try {
      const qs = buildQuery(filters);
      const url = `${API_BASE}/api/reports/${key}.csv${qs ? `?${qs}` : ''}`;
      await downloadFile(url, `${key}.csv`);
      toast.success(`${label} baixado`);
    } catch (err) {
      toast.error(err?.message || 'Falha ao baixar relatório');
    } finally {
      setLoadingKey(null);
    }
  };

  const handleZip = async () => {
    setLoadingKey('zip');
    try {
      const qs = buildQuery(filters);
      const url = `${API_BASE}/api/reports/export.zip${qs ? `?${qs}` : ''}`;
      await downloadFile(url, 'relatorio_onion.zip');
      toast.success('Pacote completo baixado');
    } catch (err) {
      toast.error(err?.message || 'Falha ao baixar pacote');
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Relatórios</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Baixe relatórios consolidados em CSV ou um pacote ZIP completo. Limite de 10 downloads por hora.
        </p>
      </div>

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 shadow-sm flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[11px] uppercase font-semibold text-slate-500">De</label>
          <input
            type="date"
            className="block mt-1 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            value={filters.from}
            onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
          />
        </div>
        <div>
          <label className="text-[11px] uppercase font-semibold text-slate-500">Até</label>
          <input
            type="date"
            className="block mt-1 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            value={filters.to}
            onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
          />
        </div>
        <div className="flex-1" />
        <button
          onClick={handleZip}
          disabled={loadingKey === 'zip'}
          className="px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {loadingKey === 'zip' ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
          Baixar pacote (ZIP)
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {REPORTS.map((report) => (
          <div
            key={report.key}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 shadow-sm flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">
                <FileText size={16} />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-slate-800 dark:text-slate-100">{report.label}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{report.description}</div>
              </div>
            </div>
            <button
              onClick={() => handleDownload(report.key, report.label)}
              disabled={loadingKey === report.key}
              className="shrink-0 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 rounded-md inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {loadingKey === report.key ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              CSV
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ReportsCenter;
