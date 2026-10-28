import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Cloud, Image, PackagePlus, RefreshCw, Search, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { useDialog } from '../context/DialogContext';
import { TableSkeleton } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';
import TablePagination, { usePagination } from '../components/TablePagination';
import { listMediaAssets, uploadMediaAsset } from '../services/media';

const emptyForm = { id: null, name: '', description: '', sku: '', category: '', mediaUrl: '', productUrl: '', brand: '', currency: 'BRL', price: '', active: true };
const money = (value) => value === null || value === undefined ? '-' : Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const Catalog = () => {
  const { confirm } = useDialog();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [form, setForm] = useState(emptyForm);
  const [surface, setSurface] = useState(null);
  const [mediaAssets, setMediaAssets] = useState([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [integration, setIntegration] = useState(null);
  const [integrationForm, setIntegrationForm] = useState({ catalogId: '', currency: 'BRL', defaultBrand: '', enabled: true });
  const [metaBusy, setMetaBusy] = useState(false);

  const fetchItems = async () => {
    try {
      setLoading(true);
      const res = await apiRequest('/catalog/items?active=all&limit=500');
      if (!res?.ok) throw new Error('Erro ao carregar catalogo');
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      toast.error(error.message || 'Erro ao carregar catalogo');
    } finally {
      setLoading(false);
    }
  };

  const fetchIntegration = async () => {
    try {
      const res = await apiRequest('/catalog/meta');
      if (!res?.ok) return;
      const data = await res.json();
      const next = data?.integration || null;
      setIntegration(next);
      if (next) setIntegrationForm({ catalogId: next.catalogId || '', currency: next.currency || 'BRL', defaultBrand: next.defaultBrand || '', enabled: next.enabled !== false });
    } catch {
      setIntegration(null);
    }
  };

  useEffect(() => {
    fetchItems();
    fetchIntegration();
    listMediaAssets().then(setMediaAssets).catch(() => setMediaAssets([]));
  }, []);

  const openCreate = () => { setForm({ ...emptyForm, currency: integration?.currency || 'BRL', brand: integration?.defaultBrand || '' }); setSurface({ mode: 'form', item: null }); };
  const openMeta = () => setSurface({ mode: 'meta', item: null });
  const openDetail = (item) => setSurface({ mode: 'detail', item });
  const openEdit = (item) => {
    setForm({ id: item.id, name: item.name || '', description: item.description || '', sku: item.sku || '', category: item.category || '', mediaUrl: item.mediaUrl || '', productUrl: item.productUrl || '', brand: item.brand || '', currency: item.currency || integration?.currency || 'BRL', price: item.price == null ? '' : String(item.price), active: item.active !== false });
    setSurface({ mode: 'form', item });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return toast.error('Nome do item e obrigatorio');
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), description: form.description.trim(), sku: form.sku.trim(), category: form.category.trim(), mediaUrl: form.mediaUrl.trim(), productUrl: form.productUrl.trim(), brand: form.brand.trim(), currency: form.currency.trim().toUpperCase(), price: form.price === '' ? null : Number(form.price), active: Boolean(form.active) };
      const res = await apiRequest(form.id ? `/catalog/items/${form.id}` : '/catalog/items', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      if (!res?.ok) { const body = await res?.json().catch(() => ({})); throw new Error(body?.error || 'Falha ao salvar item'); }
      toast.success(form.id ? 'Item atualizado' : 'Item criado');
      setSurface(null);
      setForm(emptyForm);
      await fetchItems();
    } catch (error) {
      toast.error(error.message || 'Erro ao salvar item');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveIntegration = async (event) => {
    event.preventDefault();
    if (!integrationForm.catalogId.trim()) return toast.error('Informe o Catalog ID da Meta');
    setMetaBusy(true);
    try {
      const res = await apiRequest('/catalog/meta', { method: 'PUT', body: JSON.stringify(integrationForm) });
      const data = await res?.json().catch(() => ({}));
      if (!res?.ok) throw new Error(data?.error || 'Falha ao conectar catalogo Meta');
      setIntegration(data.integration);
      toast.success(`Catalogo conectado: ${data.integration?.remoteName || data.integration?.catalogId}`);
    } catch (error) {
      toast.error(error.message || 'Falha ao conectar catalogo Meta');
    } finally {
      setMetaBusy(false);
    }
  };

  const handleSyncAll = async () => {
    setMetaBusy(true);
    try {
      const res = await apiRequest('/catalog/meta/sync', { method: 'POST', body: JSON.stringify({}) });
      const data = await res?.json().catch(() => ({}));
      if (!res?.ok) throw new Error(data?.error || 'Falha ao sincronizar catalogo');
      await Promise.all([fetchItems(), fetchIntegration()]);
      toast.success(`${data.success || 0} produto(s) sincronizado(s); ${data.failed || 0} falha(s).`);
    } catch (error) {
      toast.error(error.message || 'Falha ao sincronizar catalogo');
    } finally {
      setMetaBusy(false);
    }
  };

  const handleSyncItem = async (item) => {
    setMetaBusy(true);
    try {
      const res = await apiRequest(`/catalog/items/${item.id}/meta-sync`, { method: 'POST' });
      const data = await res?.json().catch(() => ({}));
      if (!res?.ok) throw new Error(data?.error || 'Falha ao sincronizar produto');
      await fetchItems();
      if (data?.item) setSurface({ mode: 'detail', item: data.item });
      toast.success('Produto sincronizado com a Meta');
    } catch (error) {
      await fetchItems();
      toast.error(error.message || 'Falha ao sincronizar produto');
    } finally {
      setMetaBusy(false);
    }
  };

  const handleDelete = async (item) => {
    const ok = await confirm({ title: 'Remover item', message: `Remover "${item.name}" do catalogo?`, confirmText: 'Remover', type: 'danger' });
    if (!ok) return;
    try {
      const res = await apiRequest(`/catalog/items/${item.id}`, { method: 'DELETE' });
      if (!res?.ok) throw new Error('Falha ao remover item');
      toast.success('Item removido');
      setSurface(null);
      await fetchItems();
    } catch (error) {
      toast.error(error.message || 'Erro ao remover item');
    }
  };

  const handleMediaUpload = async (file) => {
    if (!file) return;
    setUploadingMedia(true);
    try {
      const uploaded = await uploadMediaAsset(file);
      setMediaAssets((current) => [uploaded, ...current.filter((item) => item.id !== uploaded.id)]);
      setForm((current) => ({ ...current, mediaUrl: uploaded.url }));
      toast.success('Arquivo enviado');
    } catch (error) {
      toast.error(error.message || 'Erro no upload');
    } finally {
      setUploadingMedia(false);
    }
  };

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesQuery = !normalized || [item.name, item.description, item.sku, item.category].filter(Boolean).join(' ').toLowerCase().includes(normalized);
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' && item.active !== false) || (statusFilter === 'inactive' && item.active === false);
      return matchesQuery && matchesStatus;
    });
  }, [items, query, statusFilter]);
  const itemsPage = usePagination(visibleItems);

  const summary = useMemo(() => ({
    total: items.length,
    active: items.filter((item) => item.active !== false).length,
    categories: new Set(items.map((item) => item.category).filter(Boolean)).size,
    media: items.filter((item) => item.mediaUrl).length,
    value: items.reduce((total, item) => total + Number(item.price || 0), 0),
    synced: items.filter((item) => item.metaSyncStatus === 'synced').length
  }), [items]);

  const selectedItem = surface?.item;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-3 sm:p-4 lg:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Catalogo</h1>
        <div className="flex gap-2"><button type="button" onClick={openMeta} className="inline-flex h-10 items-center justify-center gap-2 border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"><Cloud size={16} /> Meta</button><button type="button" onClick={openCreate} className="inline-flex h-10 items-center justify-center gap-2 bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700"><PackagePlus size={16} /> Novo item</button></div>
      </header>

      <section className="grid grid-cols-2 border-y border-gray-200 dark:border-gray-800 lg:grid-cols-5">
        {[
          ['Itens', summary.total], ['Ativos', summary.active], ['Sincronizados', summary.synced], ['Categorias', summary.categories], ['Valor catalogado', money(summary.value)]
        ].map(([label, value], index) => <div key={label} className={`px-4 py-4 ${index ? 'border-l border-gray-200 dark:border-gray-800' : ''}`}><span className="text-xs text-gray-500 dark:text-gray-400">{label}</span><strong className="mt-2 block text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{value}</strong></div>)}
      </section>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} className="h-11 w-full border border-gray-200 bg-white pl-10 pr-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="Buscar por nome, categoria ou SKU" /></div>
        <div className="flex border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-900/30">{[['all', 'Todos'], ['active', 'Ativos'], ['inactive', 'Inativos']].map(([value, label]) => <button key={value} type="button" onClick={() => setStatusFilter(value)} className={`px-3 py-2 text-xs font-semibold ${statusFilter === value ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-700 dark:text-blue-300' : 'text-gray-500'}`}>{label}</button>)}</div>
      </div>

      <section>
        <div className="mb-3 flex items-end justify-between"><h2 className="text-sm font-semibold text-gray-950 dark:text-white">Inventario</h2><span className="text-xs text-gray-400">{visibleItems.length} resultado(s)</span></div>
        {loading ? <TableSkeleton rows={8} cols={4} /> : <div className="border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/20">
          {visibleItems.length === 0 ? <div className="py-12 text-center text-sm text-gray-500">Nenhum item encontrado.</div> : itemsPage.pageItems.map((item, index) => (
            <div key={item.id} className={`grid gap-4 px-1 py-4 hover:bg-gray-50 dark:hover:bg-gray-900/40 sm:grid-cols-[minmax(220px,1.2fr)_minmax(150px,0.6fr)_130px_100px_auto] sm:items-center sm:px-4 ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
              <div className="min-w-0"><p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{item.name}</p><p className="mt-1 truncate text-xs text-gray-400">{item.description || item.id}</p></div>
              <p className="text-xs text-gray-500 dark:text-gray-300">{item.category || 'Sem categoria'}</p>
              <p className="font-mono text-xs text-gray-400">{item.sku || '-'}</p>
              <div><p className="text-xs font-medium text-gray-700 dark:text-gray-200">{money(item.price)}</p><p className="mt-1 flex items-center gap-2 text-[11px] text-gray-400"><span className={`h-1.5 w-1.5 ${item.metaSyncStatus === 'synced' ? 'bg-blue-600' : item.metaSyncStatus === 'error' ? 'bg-red-500' : 'bg-gray-300'}`} />{item.metaSyncStatus === 'synced' ? 'Meta sincronizado' : item.metaSyncStatus === 'error' ? 'Falha Meta' : item.metaSyncStatus === 'stale' ? 'Meta desatualizado' : 'Somente Onion'}</p></div>
              <button type="button" onClick={() => openDetail(item)} className="inline-flex h-8 items-center gap-1.5 justify-self-start border border-gray-200 px-3 text-xs font-semibold text-gray-500 transition hover:border-blue-400 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 sm:justify-self-end">Detalhes <ChevronRight size={13} /></button>
            </div>
          ))}
          <TablePagination {...itemsPage} label="itens" />
        </div>}
      </section>

      <OperationalModal open={Boolean(surface)} onClose={() => setSurface(null)} size="lg" title={surface?.mode === 'meta' ? 'Integracao Meta Catalog' : surface?.mode === 'detail' ? 'Detalhes do item' : form.id ? 'Editar item' : 'Novo item'} bodyClassName="bg-slate-100 dark:bg-slate-950">
        {surface?.mode === 'meta' ? (
          <form onSubmit={handleSaveIntegration} className="mx-auto max-w-4xl px-4 py-7 sm:px-6 sm:py-9">
            <header className="border-b border-gray-200 pb-6 dark:border-gray-800"><div className="flex items-center gap-3"><Cloud className="text-blue-600" size={22} /><div><h2 className="text-xl font-semibold text-gray-950 dark:text-white">Catalogo de produtos da Meta</h2><p className="mt-1 text-sm text-gray-500">Usa o access token armazenado no canal WhatsApp deste tenant.</p></div></div></header>
            <div className="grid gap-8 py-7 lg:grid-cols-[1fr_0.8fr]"><section className="space-y-4"><label className="block"><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Catalog ID</span><input value={integrationForm.catalogId} onChange={(e) => setIntegrationForm((current) => ({ ...current, catalogId: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 font-mono text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="123456789012345" /></label><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Moeda</span><input value={integrationForm.currency} maxLength={3} onChange={(e) => setIntegrationForm((current) => ({ ...current, currency: e.target.value.toUpperCase() }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Marca padrao</span><input value={integrationForm.defaultBrand} onChange={(e) => setIntegrationForm((current) => ({ ...current, defaultBrand: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label></div><label className="flex h-11 items-center justify-between border border-gray-200 bg-white px-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">Integracao ativa<input type="checkbox" checked={integrationForm.enabled} onChange={(e) => setIntegrationForm((current) => ({ ...current, enabled: e.target.checked }))} /></label></section><dl className="divide-y divide-gray-200 border-y border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">{[['Status', integration?.status || 'Nao conectado'], ['Catalogo', integration?.remoteName || '-'], ['Vinculo WhatsApp', integration?.wabaLinked ? 'Confirmado' : 'Nao verificado'], ['Produtos remotos', integration?.remoteProductCount ?? '-'], ['Ultima verificacao', integration?.verifiedAt ? new Date(integration.verifiedAt).toLocaleString('pt-BR') : '-']].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-3"><dt className="text-gray-500">{label}</dt><dd className="text-right font-medium text-gray-800 dark:text-gray-200">{value}</dd></div>)}</dl></div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-5 dark:border-gray-800">{integration?.status === 'connected' && <button type="button" disabled={metaBusy} onClick={handleSyncAll} className="inline-flex h-10 items-center gap-2 border border-gray-200 px-4 text-sm font-semibold text-gray-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"><RefreshCw size={15} className={metaBusy ? 'animate-spin' : ''} /> Sincronizar produtos</button>}<button disabled={metaBusy} className="h-10 bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-50">{metaBusy ? 'Validando...' : 'Conectar e validar'}</button></div>
          </form>
        ) : surface?.mode === 'detail' && selectedItem ? (
          <div className="mx-auto max-w-4xl px-4 py-7 sm:px-6 sm:py-9">
            <header className="flex flex-col gap-5 border-b border-gray-200 pb-7 dark:border-gray-800 sm:flex-row sm:items-end sm:justify-between"><div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400"><span className={`h-2 w-2 ${selectedItem.active === false ? 'bg-gray-300' : 'bg-blue-600'}`} />{selectedItem.active === false ? 'Inativo' : 'Disponivel'}</div><h2 className="mt-3 text-3xl font-semibold tracking-tight text-gray-950 dark:text-white">{selectedItem.name}</h2><p className="mt-2 font-mono text-xs text-gray-400">{selectedItem.id}</p></div><div className="flex flex-wrap gap-2">{integration?.status === 'connected' && <button type="button" disabled={metaBusy} onClick={() => handleSyncItem(selectedItem)} className="inline-flex h-9 items-center gap-2 border border-blue-200 px-3 text-xs font-semibold text-blue-700 disabled:opacity-50 dark:border-blue-900 dark:text-blue-300"><RefreshCw size={14} className={metaBusy ? 'animate-spin' : ''} /> Sincronizar Meta</button>}<button type="button" onClick={() => handleDelete(selectedItem)} className="h-9 border border-gray-200 px-3 text-xs font-semibold text-gray-500 dark:border-gray-700 dark:text-gray-300">Excluir</button><button type="button" onClick={() => openEdit(selectedItem)} className="h-9 bg-blue-600 px-4 text-xs font-semibold text-white">Editar item</button></div></header>
            <div className="grid gap-8 py-8 lg:grid-cols-[1fr_0.8fr]"><section><h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Descricao</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-gray-200">{selectedItem.description || 'Nenhuma descricao cadastrada.'}</p>{selectedItem.mediaUrl && <a href={selectedItem.mediaUrl} target="_blank" rel="noreferrer" className="mt-6 flex items-center gap-3 border-y border-gray-200 py-4 text-sm text-blue-600 dark:border-gray-800"><Image size={17} /> Abrir midia associada</a>}{selectedItem.metaSyncError && <div className="mt-5 flex gap-3 border-l-2 border-red-500 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300"><AlertTriangle size={16} className="shrink-0" />{selectedItem.metaSyncError}</div>}</section><dl className="divide-y divide-gray-200 border-y border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">{[['Categoria', selectedItem.category || '-'], ['SKU', selectedItem.sku || '-'], ['Preco', money(selectedItem.price)], ['Marca', selectedItem.brand || integration?.defaultBrand || '-'], ['Meta', selectedItem.metaSyncStatus || 'Nao sincronizado'], ['Retailer ID', selectedItem.metaProductRetailerId || '-']].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-3"><dt className="text-gray-500">{label}</dt><dd className="break-all text-right font-medium text-gray-800 dark:text-gray-200">{value}</dd></div>)}</dl></div>
          </div>
        ) : surface?.mode === 'form' ? (
          <form onSubmit={handleSubmit} className="mx-auto max-w-4xl px-4 py-7 sm:px-6 sm:py-9">
            <div className="space-y-7"><section><h3 className="border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400 dark:border-gray-800">Identificacao</h3><div className="mt-4 space-y-4"><label className="block"><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Nome</span><input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label className="block"><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Descricao</span><textarea value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} className="min-h-24 w-full border border-gray-200 bg-white p-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">SKU</span><input value={form.sku} onChange={(e) => setForm((current) => ({ ...current, sku: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Categoria</span><input value={form.category} onChange={(e) => setForm((current) => ({ ...current, category: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label></div></div></section>
              <section><h3 className="border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400 dark:border-gray-800">Comercial e midia</h3><div className="mt-4 space-y-4"><div className="grid gap-4 sm:grid-cols-3"><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Preco</span><input type="number" step="0.01" value={form.price} onChange={(e) => setForm((current) => ({ ...current, price: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Moeda</span><input maxLength={3} value={form.currency} onChange={(e) => setForm((current) => ({ ...current, currency: e.target.value.toUpperCase() }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label className="flex items-end"><span className="flex h-11 w-full items-center justify-between border border-gray-200 px-3 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300">Item ativo<input type="checkbox" checked={form.active} onChange={(e) => setForm((current) => ({ ...current, active: e.target.checked }))} /></span></label></div><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Marca</span><input value={form.brand} onChange={(e) => setForm((current) => ({ ...current, brand: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><label><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">URL publica do produto</span><input value={form.productUrl} onChange={(e) => setForm((current) => ({ ...current, productUrl: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="https://..." /></label></div><label className="block"><span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">URL de midia</span><input value={form.mediaUrl} onChange={(e) => setForm((current) => ({ ...current, mediaUrl: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" /></label><select value={form.mediaUrl} onChange={(e) => setForm((current) => ({ ...current, mediaUrl: e.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"><option value="">Selecionar da biblioteca</option>{mediaAssets.map((asset) => <option key={asset.id} value={asset.url}>{asset.originalName || asset.fileName}</option>)}</select><label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-blue-600"><Upload size={14} />{uploadingMedia ? 'Enviando...' : 'Enviar nova midia'}<input type="file" className="hidden" disabled={uploadingMedia} onChange={(e) => handleMediaUpload(e.target.files?.[0] || null)} /></label></div></section></div>
            <div className="mt-8 flex justify-end gap-2 border-t border-gray-200 pt-5 dark:border-gray-800"><button type="button" onClick={() => setSurface(null)} className="h-10 border border-gray-200 px-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button><button disabled={saving} className="h-10 bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Salvando...' : 'Salvar item'}</button></div>
          </form>
        ) : null}
      </OperationalModal>
    </main>
  );
};

export default Catalog;
