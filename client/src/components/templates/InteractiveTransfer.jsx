import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileJson, Loader2, Search, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import OperationalModal from '../OperationalModal';
import { apiRequest } from '../../services/api';

// Modais de exportar e importar interactives do WhatsApp. A exportacao gera um
// arquivo ou, para super admin, copia direto para outro tenant passando pela
// mesma previa da importacao.

const KIND_LABELS = {
  list: 'Interactive list',
  button: 'Reply buttons',
  product: 'Single product',
  product_list: 'Multi product'
};

const KIND_TONES = {
  list: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  button: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300',
  product: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  product_list: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
};

const CONFLICT_OPTIONS = [
  { key: 'copy', label: 'Criar cópia', help: 'Quando o nome já existe, cria outro com "(importado)" no nome.' },
  { key: 'replace', label: 'Substituir', help: 'Quando o nome já existe, troca o conteúdo e mantém o id: fluxos que já usam ele continuam funcionando.' },
  { key: 'skip', label: 'Pular', help: 'Quando o nome já existe, mantém o que está no tenant.' }
];

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const KindChip = ({ kind }) => (
  <span className={`inline-flex shrink-0 items-center px-1.5 py-0.5 text-[10px] font-semibold ${KIND_TONES[kind] || 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
    {KIND_LABELS[kind] || kind || 'Tipo desconhecido'}
  </span>
);

const readError = async (res, fallback) => {
  if (!res) return fallback;
  const payload = await res.json().catch(() => ({}));
  if (Array.isArray(payload?.error)) return payload.error[0]?.message || fallback;
  return payload?.error || fallback;
};

const normalize = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const slug = (value) => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tenant';

const downloadJson = (data, fileName) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const describeItem = (item) => {
  if (item.kind === 'list') {
    const rows = (item.sections || []).reduce((sum, section) => sum + (section.rows?.length || 0), 0);
    return `${rows} ${rows === 1 ? 'linha' : 'linhas'}`;
  }
  if (item.kind === 'button') return `${item.buttons?.length || 0} botões`;
  if (item.kind === 'product') return '1 produto';
  const products = (item.productSections || []).reduce((sum, section) => sum + (section.productItems?.length || 0), 0);
  return `${products} ${products === 1 ? 'produto' : 'produtos'}`;
};

const formatDate = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
};

const primaryButton = 'inline-flex h-9 items-center gap-2 border border-blue-600 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'inline-flex h-9 items-center gap-2 border border-gray-300 px-4 text-xs font-semibold text-gray-600 transition hover:border-gray-400 dark:border-gray-700 dark:text-gray-300';

/* ------------------------------ exportar ------------------------------ */

export function InteractiveExportModal({ open, onClose, items = [], tenant = null, isSuperAdmin = false, tenants = [], fetchTenants, onCopyToTenant }) {
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [destination, setDestination] = useState('file');
  const [targetTenantId, setTargetTenantId] = useState('');
  const [busy, setBusy] = useState(false);

  // items e fetchTenants mudam de referencia a cada render do pai; a selecao so
  // reinicia quando o modal abre.
  const latest = useRef({ items, fetchTenants, tenantsCount: tenants.length });
  latest.current = { items, fetchTenants, tenantsCount: tenants.length };

  useEffect(() => {
    if (!open) return;
    const current = latest.current;
    setSelected(new Set(current.items.map((item) => String(item.id))));
    setQuery('');
    setDestination('file');
    setTargetTenantId('');
    if (isSuperAdmin && !current.tenantsCount) current.fetchTenants?.();
  }, [open, isSuperAdmin]);

  const visible = useMemo(() => {
    const term = normalize(query.trim());
    return term ? items.filter((item) => normalize(item.name).includes(term)) : items;
  }, [items, query]);

  const otherTenants = useMemo(() => (Array.isArray(tenants) ? tenants : [])
    .filter((item) => item?.id && item.id !== tenant?.id)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR')), [tenants, tenant?.id]);

  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.has(String(item.id)));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    visible.forEach((item) => (allVisibleSelected ? next.delete(String(item.id)) : next.add(String(item.id))));
    return next;
  });

  const canSubmit = selected.size > 0 && (destination === 'file' || targetTenantId) && !busy;

  const handleSubmit = async () => {
    setBusy(true);
    try {
      const res = await apiRequest('/templates/whatsapp/interactive/export', { method: 'POST', body: JSON.stringify({ ids: [...selected] }) });
      if (!res?.ok) throw new Error(await readError(res, 'Não foi possível exportar.'));
      const bundle = await res.json();
      if (destination === 'file') {
        downloadJson(bundle, `interactives-${slug(tenant?.name)}-${new Date().toISOString().slice(0, 10)}.onion.json`);
        toast.success(bundle.items.length === 1 ? '1 interactive exportado' : `${bundle.items.length} interactives exportados`);
        onClose?.();
      } else {
        onCopyToTenant?.(bundle, otherTenants.find((item) => item.id === targetTenantId) || { id: targetTenantId, name: '' });
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <OperationalModal
      open={open}
      onClose={onClose}
      size="md"
      context="Interactive WhatsApp"
      title="Exportar interactives"
      description="Escolha quais levar. Nada muda neste tenant."
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">{selected.size} de {items.length} selecionados</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={secondaryButton}>Cancelar</button>
            <button type="button" onClick={handleSubmit} disabled={!canSubmit} className={primaryButton}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : destination === 'file' ? <Download size={14} aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
              {destination === 'file' ? 'Baixar arquivo' : 'Continuar'}
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4 p-4 sm:p-5">
        {isSuperAdmin ? (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">Destino</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { key: 'file', title: 'Baixar arquivo', help: 'Para importar depois em qualquer tenant ou guardar de backup.' },
                { key: 'tenant', title: 'Copiar para outro tenant', help: 'Sem arquivo. Você revisa antes de gravar.' }
              ].map((option) => (
                <label key={option.key} className={`flex cursor-pointer gap-3 border px-3 py-2.5 transition ${destination === option.key ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30' : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'}`}>
                  <input type="radio" name="destino-exportacao" value={option.key} checked={destination === option.key} onChange={() => setDestination(option.key)} className="mt-0.5 h-4 w-4 accent-blue-600" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">{option.title}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{option.help}</span>
                  </span>
                </label>
              ))}
            </div>
            {destination === 'tenant' ? (
              <select
                value={targetTenantId}
                onChange={(event) => setTargetTenantId(event.target.value)}
                aria-label="Tenant de destino"
                className="h-9 w-full border border-gray-300 bg-white px-2 text-sm text-gray-900 outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                <option value="">{otherTenants.length ? 'Escolha o tenant de destino' : 'Carregando tenants...'}</option>
                {otherTenants.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
              </select>
            ) : null}
          </fieldset>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">O arquivo pode ser importado em outro tenant pelo botão Importar.</p>
        )}

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar pelo nome"
              aria-label="Buscar interactive pelo nome"
              className="h-9 w-full border border-gray-300 bg-white pl-8 pr-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <button type="button" onClick={toggleVisible} disabled={!visible.length} className="h-9 shrink-0 border border-gray-300 px-3 text-xs font-semibold text-gray-600 hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300">
            {allVisibleSelected ? 'Desmarcar' : 'Marcar'} {query.trim() ? 'resultados' : 'todos'}
          </button>
        </div>

        <ul className="max-h-[45vh] divide-y divide-gray-100 overflow-y-auto border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {visible.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">Nenhum interactive com esse nome.</li>
          ) : visible.map((item) => {
            const id = String(item.id);
            return (
              <li key={id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60">
                  <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} className="h-4 w-4 shrink-0 accent-blue-600" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">{item.name}</span>
                  <span className="hidden text-xs text-gray-500 dark:text-gray-400 sm:inline">{describeItem(item)}</span>
                  <KindChip kind={item.kind} />
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </OperationalModal>
  );
}

/* ------------------------------ importar ------------------------------ */

const STATUS_VIEW = {
  created: { tone: 'text-emerald-700 dark:text-emerald-400' },
  replaced: { tone: 'text-blue-700 dark:text-blue-400' },
  skipped: { tone: 'text-gray-500 dark:text-gray-400' },
  invalid: { tone: 'text-red-600 dark:text-red-400' }
};

// Conflito de nome pede atencao mesmo quando o item vai entrar.
const actionTone = (item) => (item.status !== 'invalid' && item.conflictWith
  ? 'text-amber-700 dark:text-amber-400'
  : STATUS_VIEW[item.status]?.tone || '');

const actionText = (item) => {
  if (item.status === 'invalid') return item.errors?.join(' ') || 'Item inválido.';
  if (item.note) return item.note;
  if (item.status === 'replaced') return `Já existe · o conteúdo de "${item.targetName}" será substituído`;
  if (item.status === 'skipped') return 'Já existe · fica o que está no tenant';
  if (item.conflictWith) return `Já existe · entra como "${item.targetName}"`;
  return 'Novo';
};

const doneText = (item) => {
  if (item.status === 'invalid') return item.errors?.join(' ') || 'Não importado.';
  if (item.status === 'replaced') return `Substituiu "${item.targetName}"`;
  if (item.status === 'skipped') return item.note || 'Pulado: já existia';
  return item.targetName !== item.name ? `Criado como "${item.targetName}"` : 'Criado';
};

export function InteractiveImportModal({ open, onClose, initialBundle = null, targetTenant = null, currentTenantName = '', onImported }) {
  const fileRef = useRef(null);
  const requestSeq = useRef(0);
  const selectionFor = useRef(null);
  const [bundle, setBundle] = useState(null);
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [onConflict, setOnConflict] = useState('copy');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const endpoint = `/templates/whatsapp/interactive/import${targetTenant?.id ? `?tenantId=${encodeURIComponent(targetTenant.id)}` : ''}`;
  const targetName = targetTenant?.name || currentTenantName || 'este tenant';

  useEffect(() => {
    if (!open) return;
    requestSeq.current += 1;
    selectionFor.current = null;
    setBundle(initialBundle);
    setFileName('');
    setOnConflict('copy');
    setPreview(null);
    setPreviewing(false);
    setSelected(new Set());
    setResult(null);
    setError('');
  }, [open, initialBundle]);

  // Previa sem gravar. Roda de novo ao trocar o modo de conflito.
  useEffect(() => {
    if (!open || !bundle || result) return;
    const seq = ++requestSeq.current;
    setPreviewing(true);
    setError('');
    (async () => {
      try {
        const res = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify({ bundle, onConflict, dryRun: true }) });
        if (!res?.ok) throw new Error(await readError(res, 'Não foi possível ler o arquivo.'));
        const data = await res.json();
        if (seq !== requestSeq.current) return;
        const validIds = data.items.filter((item) => item.status !== 'invalid').map((item) => item.sourceId);
        if (selectionFor.current !== bundle) {
          selectionFor.current = bundle;
          setSelected(new Set(validIds));
        } else {
          setSelected((prev) => new Set([...prev].filter((id) => validIds.includes(id))));
        }
        setPreview(data);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err.message);
        if (!initialBundle) {
          setBundle(null);
          setPreview(null);
        }
      } finally {
        if (seq === requestSeq.current) setPreviewing(false);
      }
    })();
  }, [open, bundle, onConflict, endpoint, result, initialBundle]);

  const handleFile = async (file) => {
    if (!file) return;
    setError('');
    if (file.size > MAX_FILE_BYTES) {
      setError('Arquivo grande demais (máximo 5 MB).');
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'onion-interactives') throw new Error('Este arquivo não é uma exportação de interactives da Onion.');
      setFileName(file.name);
      setPreview(null);
      setBundle(data);
    } catch (err) {
      setError(err instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : err.message);
    }
  };

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify({ bundle, onConflict, selectedIds: [...selected] }) });
      if (!res?.ok) throw new Error(await readError(res, 'Não foi possível importar.'));
      const data = await res.json();
      setResult(data);
      onImported?.(data);
      toast.success('Importação concluída');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setImporting(false);
    }
  };

  const items = preview?.items || [];
  const validCount = items.filter((item) => item.status !== 'invalid').length;
  const conflictCount = items.filter((item) => item.conflictWith).length;
  const conflictHelp = CONFLICT_OPTIONS.find((option) => option.key === onConflict)?.help;

  let footer = null;
  if (result) {
    footer = <div className="flex justify-end"><button type="button" onClick={onClose} className={primaryButton}>Fechar</button></div>;
  } else if (bundle) {
    footer = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-gray-500 dark:text-gray-400">{preview ? `${selected.size} de ${validCount} selecionados` : 'Lendo arquivo...'}</span>
        <div className="flex gap-2">
          {!initialBundle ? <button type="button" onClick={() => { setBundle(null); setPreview(null); setError(''); }} className={secondaryButton}>Trocar arquivo</button> : null}
          <button type="button" onClick={onClose} className={secondaryButton}>Cancelar</button>
          <button type="button" onClick={handleImport} disabled={!preview || previewing || importing || selected.size === 0} className={primaryButton}>
            {importing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
            {importing ? 'Importando...' : `Importar ${selected.size}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <OperationalModal
      open={open}
      onClose={onClose}
      size="md"
      context="Interactive WhatsApp"
      title={targetTenant ? `Copiar para ${targetName}` : 'Importar interactives'}
      description={result ? null : `Os itens entram em ${targetName}. Nada é gravado antes de você confirmar.`}
      footer={footer}
    >
      {result ? (
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <CheckCircle2 size={18} className="text-emerald-600" aria-hidden="true" />
            Importação concluída em {targetName}
          </div>
          <dl className="grid grid-cols-2 border border-gray-200 dark:border-gray-800 sm:grid-cols-4">
            {[
              ['Criados', result.summary.created],
              ['Substituídos', result.summary.replaced],
              ['Pulados', result.summary.skipped],
              ['Com erro', result.summary.invalid]
            ].map(([label, value]) => (
              <div key={label} className="border-gray-200 px-3 py-3 odd:border-r dark:border-gray-800 sm:border-r sm:last:border-r-0">
                <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-white">{value}</dd>
              </div>
            ))}
          </dl>
          {result.flows?.length ? (
            <p className="border-l-2 border-blue-500 bg-blue-50/60 px-3 py-2 text-xs text-gray-700 dark:bg-blue-950/30 dark:text-gray-200">
              {result.flows.length === 1 ? 'O fluxo' : 'Os fluxos'} {result.flows.map((flow) => `"${flow.name}"`).join(', ')} {result.flows.length === 1 ? 'apontava' : 'apontavam'} para os interactives de origem e já {result.flows.length === 1 ? 'usa' : 'usam'} os importados.
            </p>
          ) : null}
          <ul className="max-h-[40vh] divide-y divide-gray-100 overflow-y-auto border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {result.items.map((item) => (
              <li key={item.sourceId} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-white">{item.name}</span>
                  <span className={`shrink-0 text-xs ${STATUS_VIEW[item.status]?.tone || ''}`}>{doneText(item)}</span>
                </div>
                {item.warnings?.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-700 dark:text-amber-400">{warning}</p>)}
              </li>
            ))}
          </ul>
        </div>
      ) : !bundle ? (
        <div className="space-y-3 p-4 sm:p-5">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { handleFile(event.target.files?.[0]); event.target.value = ''; }} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files?.[0]); }}
            className={`flex w-full flex-col items-center gap-2 border-2 border-dashed px-4 py-10 text-center transition ${dragging ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30' : 'border-gray-300 hover:border-blue-400 dark:border-gray-700'}`}
          >
            <FileJson size={28} className="text-gray-400" aria-hidden="true" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">Escolha ou arraste o arquivo exportado</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">Arquivo .onion.json gerado em Exportar</span>
          </button>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      ) : (
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span><span className="font-semibold text-gray-700 dark:text-gray-200">Origem:</span> {bundle.source?.tenantName || 'tenant de origem'}{fileName ? ` · ${fileName}` : ''}</span>
            {formatDate(bundle.exportedAt) ? <span><span className="font-semibold text-gray-700 dark:text-gray-200">Exportado em:</span> {formatDate(bundle.exportedAt)}</span> : null}
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
              Nome que já existe{preview ? ` (${conflictCount} ${conflictCount === 1 ? 'item' : 'itens'})` : ''}
            </legend>
            <div className="inline-flex border border-gray-300 dark:border-gray-700" role="radiogroup">
              {CONFLICT_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={onConflict === option.key}
                  onClick={() => setOnConflict(option.key)}
                  className={`h-8 border-r border-gray-300 px-3 text-xs font-semibold last:border-r-0 dark:border-gray-700 ${onConflict === option.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:text-blue-600 dark:bg-gray-900 dark:text-gray-300'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{conflictHelp}</p>
          </fieldset>

          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

          <div className="relative">
            {previewing ? (
              <div className="absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 bg-white/90 px-2 py-1 text-xs text-gray-500 dark:bg-gray-900/90 dark:text-gray-400">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Atualizando prévia
              </div>
            ) : null}
            <ul className={`max-h-[42vh] divide-y divide-gray-100 overflow-y-auto border border-gray-200 transition-opacity dark:divide-gray-800 dark:border-gray-800 ${previewing && preview ? 'opacity-60' : ''}`}>
              {!preview ? (
                Array.from({ length: Math.min(bundle.items?.length || 3, 5) }).map((_, index) => (
                  <li key={`carregando_${index}`} className="px-3 py-3"><div className="h-4 w-1/2 animate-pulse bg-gray-100 dark:bg-gray-800" /></li>
                ))
              ) : items.map((item) => {
                const invalid = item.status === 'invalid';
                return (
                  <li key={item.sourceId}>
                    <label className={`flex gap-3 px-3 py-2.5 ${invalid ? 'cursor-not-allowed opacity-80' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60'}`}>
                      <input type="checkbox" checked={!invalid && selected.has(item.sourceId)} disabled={invalid} onChange={() => toggle(item.sourceId)} className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">{item.name}</span>
                          {item.kind ? <KindChip kind={item.kind} /> : null}
                        </span>
                        <span className={`mt-0.5 block text-xs ${actionTone(item)}`}>{actionText(item)}</span>
                        {item.warnings?.map((warning) => (
                          <span key={warning} className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {warning}
                          </span>
                        ))}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </OperationalModal>
  );
}
