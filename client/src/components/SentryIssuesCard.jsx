import { useEffect, useState } from 'react';
import { Bug, ExternalLink, RefreshCw } from 'lucide-react';
import { apiRequest } from '../services/api';
import { SkeletonBox } from './LoadingSkeleton';
import { Chip } from './admin/OpsKit';

// Problemas abertos no Sentry (API e painel). Os dados vem do nosso servidor,
// que guarda o token; o clique abre o problema no Sentry.

// node-express e o nome que o Sentry deu ao projeto da API na criacao.
const PROJECT_LABEL = { 'node-express': 'API', 'onion-api': 'API', 'onion-painel': 'Painel' };
const ERROR_TEXT = {
  token_invalido: 'O Sentry recusou o token. Confira SENTRY_API_TOKEN no servidor.',
  sentry_indisponivel: 'Nao foi possivel falar com o Sentry agora.'
};

const tempoAtras = (iso) => {
  const minutos = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `ha ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `ha ${horas} h`;
  return `ha ${Math.round(horas / 24)} d`;
};

export default function SentryIssuesCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const carregar = async () => {
    setLoading(true);
    try {
      const res = await apiRequest('/super-admin/errors');
      setData(res && res.ok ? await res.json() : { issues: [], error: 'sentry_indisponivel', configured: true });
    } catch {
      setData({ issues: [], error: 'sentry_indisponivel', configured: true });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { carregar(); }, []);

  if (data && !data.configured) return null;
  const issues = data?.issues || [];

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4 sm:p-6 mb-8">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <Bug size={20} />
          Erros abertos
          {!loading && !data?.error && (
            <Chip tone={issues.length ? 'bad' : 'ok'}>
              {issues.length ? `${issues.length}${issues.length === 10 ? '+' : ''}` : 'nenhum'}
            </Chip>
          )}
        </h2>
        <button
          onClick={carregar}
          disabled={loading}
          title="Atualizar"
          aria-label="Atualizar erros"
          className="p-1.5 rounded text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => <SkeletonBox key={index} className="h-12 w-full" />)}
        </div>
      ) : data?.error ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">{ERROR_TEXT[data.error] || ERROR_TEXT.sentry_indisponivel}</p>
      ) : issues.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Nenhum erro aberto nos ultimos 14 dias.</p>
      ) : (
        <ul className="space-y-2">
          {issues.map((issue) => (
            <li key={issue.id}>
              <a
                href={issue.link}
                target="_blank"
                rel="noreferrer"
                className="group flex items-start justify-between gap-3 p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-200">
                      {PROJECT_LABEL[issue.project] || issue.project}
                    </span>
                    <span className="font-medium text-slate-800 dark:text-white truncate">{issue.title}</span>
                  </div>
                  {issue.culprit && <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{issue.culprit}</div>}
                </div>
                <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">{issue.count}x</div>
                  <div>{tempoAtras(issue.lastSeen)}</div>
                  <ExternalLink size={12} className="inline opacity-0 group-hover:opacity-100" />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
