import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock3, Copy, Download, Languages, MessageSquare, MousePointer2, Plus, RefreshCcw, Save, ShieldCheck, Trash2, Upload, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { SkeletonBox } from '../components/LoadingSkeleton';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import { apiRequest } from '../services/api';
import OperationalModal from '../components/OperationalModal';
import { InteractiveExportModal, InteractiveImportModal } from '../components/templates/InteractiveTransfer';

const mkId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const mkInternalButton = () => ({ id: mkId('btn'), label: '' });
const mkRow = () => ({ id: mkId('row'), title: '', description: '', sku: '', unitPrice: '' });
const mkSection = () => ({ id: mkId('section'), title: '', rows: [mkRow()] });
const mkReplyButton = () => ({ id: mkId('ibtn'), title: '' });
const mkProductItem = () => ({ id: mkId('prod'), productRetailerId: '' });
const mkProductSection = () => ({ id: mkId('psec'), title: '', productItems: [mkProductItem()] });
const mkInteractiveForm = () => ({
  id: null,
  name: '',
  kind: 'list',
  headerText: '',
  bodyText: '',
  footerText: '',
  actionTitle: 'Ver opcoes',
  sections: [mkSection()],
  buttons: [mkReplyButton()],
  catalogId: '',
  productRetailerId: '',
  productSections: [mkProductSection()]
});
const INTERACTIVE_LIMITS = {
  headerText: 60,
  bodyText: 1024,
  footerText: 60,
  actionTitle: 20,
  catalogId: 256,
  productRetailerId: 256,
  sectionTitle: 24,
  productSectionTitle: 24,
  rowId: 200,
  rowTitle: 24,
  rowDescription: 72,
  buttonId: 256,
  buttonTitle: 20,
  maxSections: 10,
  maxProductSections: 10,
  maxRows: 10,
  maxProductItems: 30,
  maxButtons: 3
};

const normalizeInteractive = (item) => ({
  id: item?.id || null,
  name: item?.name || '',
  kind: item?.kind === 'button' ? 'button' : item?.kind === 'product' ? 'product' : item?.kind === 'product_list' ? 'product_list' : 'list',
  headerText: item?.headerText || '',
  bodyText: item?.bodyText || '',
  footerText: item?.footerText || '',
  actionTitle: item?.actionTitle || 'Ver opcoes',
  sections: Array.isArray(item?.sections) && item.sections.length ? item.sections.map((section) => ({
    id: section?.id || mkId('section'),
    title: section?.title || '',
    rows: Array.isArray(section?.rows) && section.rows.length ? section.rows.map((row) => ({ id: row?.id || mkId('row'), title: row?.title || '', description: row?.description || '', sku: row?.sku || '', unitPrice: row?.unitPrice ?? '' })) : [mkRow()]
  })) : [mkSection()],
  buttons: Array.isArray(item?.buttons) && item.buttons.length ? item.buttons.map((button) => ({ id: button?.id || mkId('ibtn'), title: button?.title || '' })) : [mkReplyButton()],
  catalogId: item?.catalogId || '',
  productRetailerId: item?.productRetailerId || '',
  productSections: Array.isArray(item?.productSections) && item.productSections.length ? item.productSections.map((section) => ({
    id: section?.id || mkId('psec'),
    title: section?.title || '',
    productItems: Array.isArray(section?.productItems) && section.productItems.length
      ? section.productItems.map((productItem) => ({ id: productItem?.id || mkId('prod'), productRetailerId: productItem?.productRetailerId || '' }))
      : [mkProductItem()]
  })) : [mkProductSection()]
});

const getInteractiveKindLabel = (kind) => {
  if (kind === 'button') return 'Reply buttons';
  if (kind === 'product') return 'Single product';
  if (kind === 'product_list') return 'Multi product';
  return 'Interactive list';
};

const fmtDate = (value) => {
  if (!value) return 'Nunca sincronizado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Nunca sincronizado';
  return date.toLocaleString('pt-BR');
};

const readError = async (response, fallback) => {
  const payload = await response.json().catch(() => ({}));
  if (Array.isArray(payload?.error)) return payload.error[0]?.message || fallback;
  return payload?.error || fallback;
};

const textLength = (value) => String(value || '').length;

const counterTone = (value, limit) => textLength(value) > limit
  ? 'text-red-500 dark:text-red-400'
  : 'text-gray-400 dark:text-gray-500';

const buildInteractiveValidationErrors = (form) => {
  const errors = [];
  const rowIds = new Set();
  const buttonIds = new Set();
  const totalRows = Array.isArray(form?.sections) ? form.sections.reduce((sum, section) => sum + (Array.isArray(section?.rows) ? section.rows.length : 0), 0) : 0;
  const totalProductItems = Array.isArray(form?.productSections) ? form.productSections.reduce((sum, section) => sum + (Array.isArray(section?.productItems) ? section.productItems.length : 0), 0) : 0;

  if (!String(form?.name || '').trim()) errors.push('Defina um nome interno para a interactive message.');
  if (!String(form?.bodyText || '').trim()) errors.push('Preencha o body da interactive message.');
  if (textLength(form?.headerText) > INTERACTIVE_LIMITS.headerText) errors.push(`O header excede ${INTERACTIVE_LIMITS.headerText} caracteres.`);
  if (textLength(form?.bodyText) > INTERACTIVE_LIMITS.bodyText) errors.push(`O body excede ${INTERACTIVE_LIMITS.bodyText} caracteres.`);
  if (textLength(form?.footerText) > INTERACTIVE_LIMITS.footerText) errors.push(`O footer excede ${INTERACTIVE_LIMITS.footerText} caracteres.`);
  if (textLength(form?.catalogId) > INTERACTIVE_LIMITS.catalogId) errors.push(`O catalogId excede ${INTERACTIVE_LIMITS.catalogId} caracteres.`);
  if (textLength(form?.productRetailerId) > INTERACTIVE_LIMITS.productRetailerId) errors.push(`O productRetailerId excede ${INTERACTIVE_LIMITS.productRetailerId} caracteres.`);

  if (form?.kind === 'list') {
    if (!String(form?.actionTitle || '').trim()) errors.push('Preencha o texto do botao da lista.');
    if (textLength(form?.actionTitle) > INTERACTIVE_LIMITS.actionTitle) errors.push(`O texto do botao excede ${INTERACTIVE_LIMITS.actionTitle} caracteres.`);
    if (!Array.isArray(form?.sections) || form.sections.length === 0) errors.push('Adicione ao menos uma secao.');
    if ((form?.sections || []).length > INTERACTIVE_LIMITS.maxSections) errors.push(`O WhatsApp aceita no maximo ${INTERACTIVE_LIMITS.maxSections} secoes por lista.`);
    if (totalRows === 0) errors.push('Adicione ao menos uma linha na lista.');
    if (totalRows > INTERACTIVE_LIMITS.maxRows) errors.push(`O WhatsApp aceita no maximo ${INTERACTIVE_LIMITS.maxRows} linhas por lista.`);

    (form?.sections || []).forEach((section, sectionIndex) => {
      if (textLength(section?.title) > INTERACTIVE_LIMITS.sectionTitle) errors.push(`O titulo da secao ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.sectionTitle} caracteres.`);
      if ((form?.sections || []).length > 1 && !String(section?.title || '').trim()) errors.push(`A secao ${sectionIndex + 1} precisa de titulo quando houver mais de uma secao.`);
      if (!Array.isArray(section?.rows) || section.rows.length === 0) errors.push(`A secao ${sectionIndex + 1} precisa ter ao menos uma linha.`);

      (section?.rows || []).forEach((row, rowIndex) => {
        const trimmedId = String(row?.id || '').trim();
        if (!trimmedId) errors.push(`Defina o ID da linha ${rowIndex + 1} da secao ${sectionIndex + 1}.`);
        if (textLength(row?.id) > INTERACTIVE_LIMITS.rowId) errors.push(`O ID da linha ${rowIndex + 1} da secao ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.rowId} caracteres.`);
        if (rowIds.has(trimmedId) && trimmedId) errors.push(`O ID "${trimmedId}" esta repetido em mais de uma linha.`);
        if (trimmedId) rowIds.add(trimmedId);

        if (!String(row?.title || '').trim()) errors.push(`Preencha o titulo da linha ${rowIndex + 1} da secao ${sectionIndex + 1}.`);
        if (textLength(row?.title) > INTERACTIVE_LIMITS.rowTitle) errors.push(`O titulo da linha ${rowIndex + 1} da secao ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.rowTitle} caracteres.`);
        if (textLength(row?.description) > INTERACTIVE_LIMITS.rowDescription) errors.push(`A descricao da linha ${rowIndex + 1} da secao ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.rowDescription} caracteres.`);
        if (row?.unitPrice !== '' && row?.unitPrice !== null && row?.unitPrice !== undefined && (!Number.isFinite(Number(row.unitPrice)) || Number(row.unitPrice) < 0)) {
          errors.push(`O preco interno da linha ${rowIndex + 1} da secao ${sectionIndex + 1} e invalido.`);
        }
      });
    });
  }

  if (form?.kind === 'button') {
    if (!Array.isArray(form?.buttons) || form.buttons.length === 0) errors.push('Adicione ao menos um reply button.');
    if ((form?.buttons || []).length > INTERACTIVE_LIMITS.maxButtons) errors.push(`O WhatsApp aceita no maximo ${INTERACTIVE_LIMITS.maxButtons} reply buttons.`);

    (form?.buttons || []).forEach((button, buttonIndex) => {
      const trimmedId = String(button?.id || '').trim();
      if (!trimmedId) errors.push(`Defina o ID do botao ${buttonIndex + 1}.`);
      if (textLength(button?.id) > INTERACTIVE_LIMITS.buttonId) errors.push(`O ID do botao ${buttonIndex + 1} excede ${INTERACTIVE_LIMITS.buttonId} caracteres.`);
      if (buttonIds.has(trimmedId) && trimmedId) errors.push(`O ID "${trimmedId}" esta repetido em mais de um botao.`);
      if (trimmedId) buttonIds.add(trimmedId);

      if (!String(button?.title || '').trim()) errors.push(`Preencha o texto do botao ${buttonIndex + 1}.`);
      if (textLength(button?.title) > INTERACTIVE_LIMITS.buttonTitle) errors.push(`O texto do botao ${buttonIndex + 1} excede ${INTERACTIVE_LIMITS.buttonTitle} caracteres.`);
    });
  }

  if (form?.kind === 'product') {
    if (String(form?.headerText || '').trim()) errors.push('Single product nao aceita header.');
    if (!String(form?.catalogId || '').trim()) errors.push('Preencha o catalogId da Meta para o produto.');
    if (!String(form?.productRetailerId || '').trim()) errors.push('Preencha o productRetailerId do produto.');
  }

  if (form?.kind === 'product_list') {
    if (!String(form?.headerText || '').trim()) errors.push('Preencha o header do multi product.');
    if (!String(form?.catalogId || '').trim()) errors.push('Preencha o catalogId da Meta para o multi product.');
    if (!Array.isArray(form?.productSections) || form.productSections.length === 0) errors.push('Adicione ao menos uma secao de produtos.');
    if ((form?.productSections || []).length > INTERACTIVE_LIMITS.maxProductSections) errors.push(`O WhatsApp aceita no maximo ${INTERACTIVE_LIMITS.maxProductSections} secoes no multi product.`);
    if (totalProductItems === 0) errors.push('Adicione ao menos um produto no multi product.');
    if (totalProductItems > INTERACTIVE_LIMITS.maxProductItems) errors.push(`O WhatsApp aceita no maximo ${INTERACTIVE_LIMITS.maxProductItems} produtos no multi product.`);

    (form?.productSections || []).forEach((section, sectionIndex) => {
      if (textLength(section?.title) > INTERACTIVE_LIMITS.productSectionTitle) errors.push(`O titulo da secao de produtos ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.productSectionTitle} caracteres.`);
      if ((form?.productSections || []).length > 1 && !String(section?.title || '').trim()) errors.push(`A secao de produtos ${sectionIndex + 1} precisa de titulo quando houver mais de uma secao.`);
      if (!Array.isArray(section?.productItems) || section.productItems.length === 0) errors.push(`A secao de produtos ${sectionIndex + 1} precisa ter ao menos um produto.`);

      (section?.productItems || []).forEach((productItem, productIndex) => {
        if (!String(productItem?.productRetailerId || '').trim()) errors.push(`Preencha o productRetailerId do produto ${productIndex + 1} da secao ${sectionIndex + 1}.`);
        if (textLength(productItem?.productRetailerId) > INTERACTIVE_LIMITS.productRetailerId) errors.push(`O productRetailerId do produto ${productIndex + 1} da secao ${sectionIndex + 1} excede ${INTERACTIVE_LIMITS.productRetailerId} caracteres.`);
      });
    });
  }

  return Array.from(new Set(errors));
};

const FieldCounter = ({ value, limit, hint }) => (
  <div className="mt-1 flex items-center justify-between gap-3">
    <span className="text-[11px] text-gray-400 dark:text-gray-500">{hint || '\u00A0'}</span>
    <span className={`text-[11px] font-medium ${counterTone(value, limit)}`}>{textLength(value)}/{limit}</span>
  </div>
);

const StatusPill = ({ status }) => {
  const value = String(status || 'UNKNOWN').toUpperCase();
  const Icon = value === 'APPROVED' || value === 'ACTIVE' ? CheckCircle2 : value === 'REJECTED' ? XCircle : value === 'PENDING' || value === 'IN_REVIEW' || value === 'PAUSED' ? Clock3 : AlertCircle;
  return <span className="inline-flex items-center gap-1 border-l border-blue-300 px-2 text-xs font-semibold text-gray-600 dark:border-blue-800 dark:text-gray-300"><Icon size={14} className="text-blue-500" /> {value}</span>;
};

const TemplateManager = () => {
  const { tenant, tenants, fetchTenants, isSuperAdmin } = useTenant();
  const { confirm } = useDialog();
  const [showInteractiveExport, setShowInteractiveExport] = useState(false);
  // { bundle, targetTenant }: bundle nulo abre na escolha de arquivo; targetTenant nulo e o tenant atual.
  const [interactiveImport, setInteractiveImport] = useState(null);
  const [tab, setTab] = useState('internal');
  const [waTab, setWaTab] = useState('official');
  const [templates, setTemplates] = useState([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [buttons, setButtons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [waLoading, setWaLoading] = useState(true);
  const [waSyncing, setWaSyncing] = useState(false);
  const [waTemplates, setWaTemplates] = useState([]);
  const [waMeta, setWaMeta] = useState({ lastSyncedAt: null, channelConfig: { ready: false, wabaId: null } });
  const [interactiveLoading, setInteractiveLoading] = useState(true);
  const [interactiveSaving, setInteractiveSaving] = useState(false);
  const [interactiveItems, setInteractiveItems] = useState([]);
  const [interactiveForm, setInteractiveForm] = useState(mkInteractiveForm());
  const [metaCatalog, setMetaCatalog] = useState(null);
  const [metaCatalogItems, setMetaCatalogItems] = useState([]);
  const [showInternalCreate, setShowInternalCreate] = useState(false);
  const [showWaCreate, setShowWaCreate] = useState(false);
  const [waSubmitting, setWaSubmitting] = useState(false);
  const [waForm, setWaForm] = useState({
    name: '', category: 'UTILITY', language: 'pt_BR',
    headerText: '', body: '', footer: '', buttons: '',
    headerExample: [], bodyExample: []
  });

  const channelsPath = tenant && tenant.id !== 'super_admin' ? `/tenant/${tenant.id}/channels` : '/channels';
  const approvedCount = useMemo(() => waTemplates.filter((item) => ['APPROVED', 'ACTIVE'].includes(String(item.status || '').toUpperCase())).length, [waTemplates]);
  const totalInteractiveRows = useMemo(() => interactiveForm.sections.reduce((sum, section) => sum + section.rows.length, 0), [interactiveForm.sections]);
  const totalInteractiveProductItems = useMemo(() => interactiveForm.productSections.reduce((sum, section) => sum + section.productItems.length, 0), [interactiveForm.productSections]);
  const interactiveValidationErrors = useMemo(() => buildInteractiveValidationErrors(interactiveForm), [interactiveForm]);

  const loadInternalTemplates = async () => {
    try {
      setLoading(true);
      const res = await apiRequest('/templates');
      if (res?.ok) {
        const data = await res.json();
        setTemplates(Array.isArray(data) ? data : []);
      }
    } catch {
      toast.error('Falha ao carregar templates internos');
    } finally {
      setLoading(false);
    }
  };

  const loadWhatsAppTemplates = async (showLoader = true) => {
    try {
      if (showLoader) setWaLoading(true);
      const res = await apiRequest('/templates/whatsapp');
      if (res?.ok) {
        const data = await res.json();
        setWaTemplates(Array.isArray(data?.items) ? data.items : []);
        setWaMeta({ lastSyncedAt: data?.lastSyncedAt || null, channelConfig: { ready: Boolean(data?.channelConfig?.ready), wabaId: data?.channelConfig?.wabaId || null } });
      }
    } catch {
      toast.error('Falha ao carregar templates WhatsApp');
    } finally {
      setWaLoading(false);
    }
  };

  const loadInteractiveTemplates = async () => {
    try {
      setInteractiveLoading(true);
      const res = await apiRequest('/templates/whatsapp/interactive');
      if (res?.ok) {
        const data = await res.json();
        setInteractiveItems(Array.isArray(data?.items) ? data.items : []);
      }
    } catch {
      toast.error('Falha ao carregar interactive messages');
    } finally {
      setInteractiveLoading(false);
    }
  };

  const loadMetaCatalogProducts = async () => {
    try {
      const [integrationRes, itemsRes] = await Promise.all([
        apiRequest('/catalog/meta'),
        apiRequest('/catalog/items?active=true&meta=ready&limit=500')
      ]);
      const integrationData = integrationRes?.ok ? await integrationRes.json() : {};
      const itemsData = itemsRes?.ok ? await itemsRes.json() : {};
      setMetaCatalog(integrationData?.integration || null);
      setMetaCatalogItems(Array.isArray(itemsData?.items) ? itemsData.items : []);
    } catch {
      setMetaCatalog(null);
      setMetaCatalogItems([]);
    }
  };

  useEffect(() => {
    loadInternalTemplates();
    loadWhatsAppTemplates();
    loadInteractiveTemplates();
    loadMetaCatalogProducts();
  }, []);

  const saveInternalTemplate = async () => {
    if (!name.trim() || !text.trim()) return toast.error('Preencha o nome e a mensagem.');
    if (buttons.some((button) => !button.label.trim())) return toast.error('Preencha o texto de todos os botoes.');
    try {
      const res = await apiRequest('/templates', { method: 'POST', body: JSON.stringify({ name, text, buttons, scope: 'flow', tenantId: tenant && tenant.id !== 'super_admin' ? tenant.id : undefined }) });
      if (res?.ok) {
        setName('');
        setText('');
        setButtons([]);
        await loadInternalTemplates();
        setShowInternalCreate(false);
        toast.success('Template interno salvo');
      }
    } catch {
      toast.error('Erro ao salvar template interno');
    }
  };

  const deleteInternalTemplate = async (id) => {
    const ok = await confirm({
      title: 'Excluir template',
      message: 'Tem certeza que deseja excluir este template interno?',
      confirmText: 'Excluir',
      type: 'danger',
    });
    if (!ok) return;
    const previous = templates;
    setTemplates((prev) => prev.filter((item) => item.id !== id));
    try {
      await apiRequest(`/templates/${id}`, { method: 'DELETE' });
      toast.success('Template removido');
    } catch {
      setTemplates(previous);
      toast.error('Erro ao excluir');
    }
  };

  const syncWhatsApp = async () => {
    try {
      setWaSyncing(true);
      const res = await apiRequest('/templates/whatsapp/sync', { method: 'POST' });
      if (!res?.ok) throw new Error(await readError(res, 'Falha ao sincronizar'));
      const payload = await res.json().catch(() => ({}));
      await loadWhatsAppTemplates(false);
      toast.success(`Sync concluido: ${payload?.total || 0} template(s).`);
    } catch (error) {
      toast.error(error.message || 'Falha ao sincronizar templates WhatsApp');
    } finally {
      setWaSyncing(false);
    }
  };
  // A Meta exige um exemplo por variavel {{n}}. Contamos os placeholders para
  // pedir exatamente os exemplos necessarios e evitar rejeicao na revisao.
  const countVars = (text) => new Set(String(text || '').match(/\{\{\s*\d+\s*\}\}/g) || []).size;
  const waBodyVars = countVars(waForm.body);
  const waHeaderVars = countVars(waForm.headerText);

  const setWaExample = (field, index, value) => {
    setWaForm((prev) => {
      const next = [...(prev[field] || [])];
      next[index] = value;
      return { ...prev, [field]: next };
    });
  };

  const submitWhatsAppTemplate = async () => {
    if (!waForm.name.trim() || !waForm.body.trim()) {
      toast.error('Informe nome e corpo do template.');
      return;
    }
    if ((waForm.bodyExample.filter(Boolean).length) !== waBodyVars
      || (waForm.headerExample.filter(Boolean).length) !== waHeaderVars) {
      toast.error('Preencha um exemplo para cada variavel.');
      return;
    }
    try {
      setWaSubmitting(true);
      const res = await apiRequest('/templates/whatsapp/submit', {
        method: 'POST',
        body: JSON.stringify({
          ...waForm,
          buttons: String(waForm.buttons || '').split(',').map((s) => s.trim()).filter(Boolean),
          headerExample: waForm.headerExample.slice(0, waHeaderVars),
          bodyExample: waForm.bodyExample.slice(0, waBodyVars)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Falha ao criar template');
      toast.success(`Template "${data.template.name}" enviado. Status: ${data.template.status}`);
      setShowWaCreate(false);
      setWaForm({ name: '', category: 'UTILITY', language: 'pt_BR', headerText: '', body: '', footer: '', buttons: '', headerExample: [], bodyExample: [] });
      await loadWhatsAppTemplates(false);
    } catch (error) {
      toast.error(error.message || 'Falha ao criar template');
    } finally {
      setWaSubmitting(false);
    }
  };

  const copyTemplateId = async (value, label) => {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      toast.success(`${label} copiado`);
    } catch {
      toast.error(`Nao foi possivel copiar ${label.toLowerCase()}`);
    }
  };
  const resetInteractiveForm = () => setInteractiveForm(mkInteractiveForm());
  const updateInteractiveForm = (patch) => setInteractiveForm((prev) => ({ ...prev, ...patch }));
  const changeInteractiveKind = (kind) => setInteractiveForm((prev) => ({
    ...prev,
    kind,
    headerText: kind === 'product' ? '' : prev.headerText,
    actionTitle: kind === 'list' ? (prev.actionTitle || 'Ver opcoes') : '',
    sections: kind === 'list' ? (prev.sections.length ? prev.sections : [mkSection()]) : prev.sections,
    buttons: kind === 'button' ? (prev.buttons.length ? prev.buttons.slice(0, 3) : [mkReplyButton()]) : prev.buttons,
    catalogId: kind === 'product' || kind === 'product_list' ? (metaCatalog?.catalogId || prev.catalogId) : '',
    productRetailerId: kind === 'product' ? prev.productRetailerId : '',
    productSections: kind === 'product_list' ? (prev.productSections.length ? prev.productSections : [mkProductSection()]) : prev.productSections
  }));
  const addInteractiveSection = () => setInteractiveForm((prev) => ({ ...prev, sections: [...prev.sections, mkSection()] }));
  const updateInteractiveSection = (sectionId, patch) => setInteractiveForm((prev) => ({ ...prev, sections: prev.sections.map((section) => section.id === sectionId ? { ...section, ...patch } : section) }));
  const removeInteractiveSection = (sectionId) => setInteractiveForm((prev) => ({ ...prev, sections: prev.sections.filter((section) => section.id !== sectionId) }));
  const addInteractiveRow = (sectionId) => setInteractiveForm((prev) => ({ ...prev, sections: prev.sections.map((section) => section.id === sectionId ? { ...section, rows: [...section.rows, mkRow()] } : section) }));
  const updateInteractiveRow = (sectionId, rowId, patch) => setInteractiveForm((prev) => ({ ...prev, sections: prev.sections.map((section) => section.id === sectionId ? { ...section, rows: section.rows.map((row) => row.id === rowId ? { ...row, ...patch } : row) } : section) }));
  const removeInteractiveRow = (sectionId, rowId) => setInteractiveForm((prev) => ({ ...prev, sections: prev.sections.map((section) => section.id === sectionId ? { ...section, rows: section.rows.filter((row) => row.id !== rowId) } : section) }));
  const addReplyButton = () => setInteractiveForm((prev) => ({ ...prev, buttons: [...prev.buttons, mkReplyButton()].slice(0, 3) }));
  const updateReplyButton = (buttonId, patch) => setInteractiveForm((prev) => ({ ...prev, buttons: prev.buttons.map((button) => button.id === buttonId ? { ...button, ...patch } : button) }));
  const removeReplyButton = (buttonId) => setInteractiveForm((prev) => ({ ...prev, buttons: prev.buttons.filter((button) => button.id !== buttonId) }));
  const addProductSection = () => setInteractiveForm((prev) => ({ ...prev, productSections: [...prev.productSections, mkProductSection()] }));
  const updateProductSection = (sectionId, patch) => setInteractiveForm((prev) => ({ ...prev, productSections: prev.productSections.map((section) => section.id === sectionId ? { ...section, ...patch } : section) }));
  const removeProductSection = (sectionId) => setInteractiveForm((prev) => ({ ...prev, productSections: prev.productSections.filter((section) => section.id !== sectionId) }));
  const addProductItem = (sectionId) => setInteractiveForm((prev) => ({ ...prev, productSections: prev.productSections.map((section) => section.id === sectionId ? { ...section, productItems: [...section.productItems, mkProductItem()] } : section) }));
  const updateProductItem = (sectionId, productItemId, patch) => setInteractiveForm((prev) => ({ ...prev, productSections: prev.productSections.map((section) => section.id === sectionId ? { ...section, productItems: section.productItems.map((productItem) => productItem.id === productItemId ? { ...productItem, ...patch } : productItem) } : section) }));
  const removeProductItem = (sectionId, productItemId) => setInteractiveForm((prev) => ({ ...prev, productSections: prev.productSections.map((section) => section.id === sectionId ? { ...section, productItems: section.productItems.filter((productItem) => productItem.id !== productItemId) } : section) }));

  const editInteractiveTemplate = (item) => {
    const normalized = normalizeInteractive(item);
    setInteractiveForm({
      ...normalized,
      catalogId: normalized.catalogId || ((normalized.kind === 'product' || normalized.kind === 'product_list') ? metaCatalog?.catalogId || '' : '')
    });
    setWaTab('interactive');
  };

  const saveInteractiveTemplate = async () => {
    if (!interactiveForm.name.trim() || !interactiveForm.bodyText.trim()) return toast.error('Preencha nome e corpo da mensagem.');
    if (interactiveValidationErrors.length) return toast.error(interactiveValidationErrors[0]);
    const payload = {
      name: interactiveForm.name.trim(),
      kind: interactiveForm.kind,
      headerText: interactiveForm.headerText.trim(),
      bodyText: interactiveForm.bodyText.trim(),
      footerText: interactiveForm.footerText.trim(),
      actionTitle: interactiveForm.kind === 'list' ? interactiveForm.actionTitle.trim() : '',
      sections: interactiveForm.kind === 'list' ? interactiveForm.sections.map((section) => ({
        title: section.title.trim(),
        rows: section.rows.map((row) => ({
          id: row.id.trim(),
          title: row.title.trim(),
          description: row.description.trim(),
          sku: String(row.sku || '').trim(),
          unitPrice: row.unitPrice === '' || row.unitPrice === null || row.unitPrice === undefined ? undefined : Number(row.unitPrice)
        }))
      })) : [],
      buttons: interactiveForm.kind === 'button' ? interactiveForm.buttons.map((button) => ({ id: button.id.trim(), title: button.title.trim() })) : [],
      catalogId: interactiveForm.kind === 'product' || interactiveForm.kind === 'product_list' ? interactiveForm.catalogId.trim() : '',
      productRetailerId: interactiveForm.kind === 'product' ? interactiveForm.productRetailerId.trim() : '',
      productSections: interactiveForm.kind === 'product_list' ? interactiveForm.productSections.map((section) => ({ title: section.title.trim(), productItems: section.productItems.map((productItem) => ({ productRetailerId: productItem.productRetailerId.trim() })) })) : []
    };
    try {
      setInteractiveSaving(true);
      const endpoint = interactiveForm.id ? `/templates/whatsapp/interactive/${interactiveForm.id}` : '/templates/whatsapp/interactive';
      const method = interactiveForm.id ? 'PUT' : 'POST';
      const res = await apiRequest(endpoint, { method, body: JSON.stringify(payload) });
      if (!res?.ok) throw new Error(await readError(res, 'Falha ao salvar interactive message'));
      await loadInteractiveTemplates();
      resetInteractiveForm();
      toast.success(interactiveForm.id ? 'Interactive message atualizada' : 'Interactive message salva');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar interactive message');
    } finally {
      setInteractiveSaving(false);
    }
  };

  const deleteInteractiveTemplate = async (id) => {
    const ok = await confirm({
      title: 'Excluir interactive message',
      message: 'Tem certeza que deseja excluir esta interactive message?',
      confirmText: 'Excluir',
      type: 'danger',
    });
    if (!ok) return;
    try {
      const res = await apiRequest(`/templates/whatsapp/interactive/${id}`, { method: 'DELETE' });
      if (!res?.ok) throw new Error(await readError(res, 'Falha ao excluir'));
      await loadInteractiveTemplates();
      if (interactiveForm.id === id) resetInteractiveForm();
      toast.success('Interactive message removida');
    } catch (error) {
      toast.error(error.message || 'Falha ao excluir');
    }
  };

  return (
    <main className="content min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1440px]">
      <header className="mb-7 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Templates</h1>
        {tab === 'internal' && <button type="button" onClick={() => setShowInternalCreate(true)} className="inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-blue-300"><Plus size={14} /> Novo template</button>}
      </header>

      <section className="mb-7 border-y border-gray-200 dark:border-gray-800">
        <div className="grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800 lg:grid-cols-5">
          {[
            ['Templates de fluxo', templates.filter((item) => item.scope !== 'root').length],
            ['Meta sincronizados', waTemplates.length],
            ['Meta aprovados', approvedCount],
            ['Interativos', interactiveItems.length],
            ['Ultima sincronizacao', fmtDate(waMeta.lastSyncedAt)]
          ].map(([label, value], index) => <div key={label} className={`px-4 py-4 first:pl-0 lg:py-5 ${index === 4 ? 'col-span-2 border-t border-gray-200 dark:border-gray-800 lg:col-span-1 lg:border-t-0' : ''}`}><div className="text-xs text-gray-500 dark:text-gray-400">{label}</div><div className={`${index === 4 ? 'text-sm' : 'text-xl'} mt-2 font-semibold text-gray-950 dark:text-white`}>{value}</div></div>)}
        </div>
      </section>

      <nav className="mb-6 flex border-b border-gray-200 dark:border-gray-800">
        <button type="button" onClick={() => setTab('internal')} className={`border-b-2 px-3 pb-3 pt-1 text-sm font-medium transition ${tab === 'internal' ? 'border-blue-500 text-gray-950 dark:text-white' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>Internos</button>
        <button type="button" onClick={() => setTab('whatsapp')} className={`border-b-2 px-3 pb-3 pt-1 text-sm font-medium transition ${tab === 'whatsapp' ? 'border-blue-500 text-gray-950 dark:text-white' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>WhatsApp</button>
      </nav>

      {tab === 'internal' ? (
        <div>
          <OperationalModal open={showInternalCreate} onClose={() => setShowInternalCreate(false)} size="md" title="Novo template interno">
            <div className="space-y-5 p-5 sm:p-6">
                <div><label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Identificador interno</label><input className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex: menu_principal" /></div>
                <div><label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Corpo da mensagem</label><textarea className="h-32 w-full resize-none border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" value={text} onChange={(event) => setText(event.target.value)} placeholder="Ola {nome}, como podemos ajudar hoje?" /></div>
                <div className="border border-gray-200 p-4 dark:border-gray-700">
                  <div className="flex items-center justify-between gap-2 mb-3"><label className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Botoes ({buttons.length})</label><button type="button" onClick={() => setButtons((prev) => [...prev, mkInternalButton()])} className="text-xs flex items-center gap-1 text-blue-600 font-medium px-2 py-1 rounded"><Plus size={14} /> Adicionar</button></div>
                  <div className="space-y-2">
                    {buttons.map((button, index) => <div key={button.id} className="flex items-center gap-2"><input className="h-10 flex-1 border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" value={button.label} onChange={(event) => setButtons((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder={`Opcao ${index + 1}`} /><button type="button" onClick={() => setButtons((prev) => prev.filter((item) => item.id !== button.id))} className="grid h-10 w-10 place-items-center border border-gray-300 text-gray-500 hover:border-blue-500 hover:text-blue-700 dark:border-gray-700"><Trash2 size={16} /></button></div>)}
                    {buttons.length === 0 && <div className="border border-dashed border-gray-300 py-5 text-center text-xs text-gray-400 dark:border-gray-600">Nenhum botao configurado</div>}
                  </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800"><button type="button" onClick={() => setShowInternalCreate(false)} className="h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button><button type="button" onClick={saveInternalTemplate} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"><Save size={15} /> Salvar</button></div>
            </div>
          </OperationalModal>

          <div className="min-h-0 overflow-hidden border-y border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 py-3 dark:border-gray-800"><h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Templates de fluxo</h3><span className="text-xs text-gray-500">{templates.filter((item) => item.scope !== 'root').length} total</span></div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {loading ? <div className="space-y-3 py-4">{Array.from({ length: 4 }).map((_, index) => <SkeletonBox key={`template_skel_${index}`} className="h-14 w-full" />)}</div> : templates.filter((item) => item.scope !== 'root').length === 0 ? <div className="py-10"><div className="text-sm font-medium text-gray-700 dark:text-gray-200">Nenhum template de fluxo configurado.</div><button type="button" onClick={() => setShowInternalCreate(true)} className="mt-4 h-9 bg-blue-600 px-4 text-xs font-semibold text-white">Criar template</button></div> : <div className="divide-y divide-gray-200 dark:divide-gray-800">{templates.filter((item) => item.scope !== 'root').map((template) => <div key={template.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(160px,0.8fr)_minmax(260px,1.5fr)_90px_auto] sm:items-center"><div className="min-w-0"><strong className="block truncate text-sm font-semibold text-gray-900 dark:text-white">{template.name}</strong><span className="mt-1 block truncate font-mono text-[10px] text-gray-400">{template.id}</span></div><div className="truncate text-sm text-gray-600 dark:text-gray-300">{template.text}</div><div className="text-xs text-gray-500">{template.buttons?.length || 0} botoes</div><button type="button" onClick={() => deleteInternalTemplate(template.id)} className="grid h-8 w-8 place-items-center border border-gray-300 text-gray-500 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700" aria-label={`Excluir ${template.name}`}><Trash2 size={14} /></button></div>)}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-6 overflow-y-auto pr-1 custom-scrollbar">
          <div className="space-y-4 border-y border-gray-200 py-4 dark:border-gray-800">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="text-sm font-semibold text-gray-900 dark:text-white">Operacao WhatsApp</div><div className="flex flex-wrap gap-2"><Link to={channelsPath} className="h-9 border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-300">Configurar canal</Link><button type="button" onClick={() => setShowWaCreate(true)} className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-300"><Plus size={14} /> Criar na Meta</button><button type="button" onClick={syncWhatsApp} disabled={waSyncing} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"><RefreshCcw size={15} className={waSyncing ? 'animate-spin' : ''} />{waSyncing ? 'Sincronizando...' : 'Sincronizar com Meta'}</button></div></div>

            <OperationalModal open={showWaCreate} onClose={() => setShowWaCreate(false)} size="md" title="Criar template na Meta">
              <div className="space-y-5 p-5 sm:p-6">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Nome</label>
                    <input className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={waForm.name} onChange={(e) => setWaForm({ ...waForm, name: e.target.value })} placeholder="confirmacao de horario" />
                    <p className="mt-1 text-[11px] text-gray-400">Acentos e espacos viram underscore automaticamente.</p>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Categoria</label>
                    <select className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={waForm.category} onChange={(e) => setWaForm({ ...waForm, category: e.target.value })}>
                      <option value="UTILITY">Utilidade</option>
                      <option value="MARKETING">Marketing</option>
                      <option value="AUTHENTICATION">Autenticacao</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Cabecalho (opcional)</label>
                  <input className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    value={waForm.headerText} onChange={(e) => setWaForm({ ...waForm, headerText: e.target.value })} placeholder="Ola {{1}}" />
                  {waHeaderVars > 0 && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {Array.from({ length: waHeaderVars }).map((_, i) => (
                        <input key={`h_${i}`} className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                          value={waForm.headerExample[i] || ''} onChange={(e) => setWaExample('headerExample', i, e.target.value)}
                          placeholder={`Exemplo para {{${i + 1}}}`} />
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Corpo</label>
                  <textarea className="h-28 w-full resize-none border border-gray-300 bg-white px-4 py-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    value={waForm.body} onChange={(e) => setWaForm({ ...waForm, body: e.target.value })}
                    placeholder="Seu horario esta marcado para {{1}} as {{2}}." />
                  {waBodyVars > 0 && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {Array.from({ length: waBodyVars }).map((_, i) => (
                        <input key={`b_${i}`} className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                          value={waForm.bodyExample[i] || ''} onChange={(e) => setWaExample('bodyExample', i, e.target.value)}
                          placeholder={`Exemplo para {{${i + 1}}}`} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Rodape (opcional)</label>
                    <input className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={waForm.footer} onChange={(e) => setWaForm({ ...waForm, footer: e.target.value })} placeholder="Nome do negocio" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Botoes (ate 3, por virgula)</label>
                    <input className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={waForm.buttons} onChange={(e) => setWaForm({ ...waForm, buttons: e.target.value })} placeholder="Confirmar, Remarcar" />
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
                  <button type="button" onClick={() => setShowWaCreate(false)} className="h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button>
                  <button type="button" onClick={submitWhatsAppTemplate} disabled={waSubmitting}
                    className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                    <Save size={15} /> {waSubmitting ? 'Enviando...' : 'Enviar para revisao'}
                  </button>
                </div>
              </div>
            </OperationalModal>
            {!waMeta.channelConfig.ready && <div className="flex items-center gap-3 border border-gray-300 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"><AlertCircle size={17} className="shrink-0 text-blue-500" />Configure Access Token e WABA ID antes de sincronizar.</div>}
            <div className="flex border-b border-gray-200 dark:border-gray-800"><button type="button" onClick={() => setWaTab('official')} className={`border-b-2 px-3 pb-3 text-sm font-medium ${waTab === 'official' ? 'border-blue-500 text-gray-950 dark:text-white' : 'border-transparent text-gray-400'}`}>Meta aprovados</button><button type="button" onClick={() => setWaTab('interactive')} className={`border-b-2 px-3 pb-3 text-sm font-medium ${waTab === 'interactive' ? 'border-blue-500 text-gray-950 dark:text-white' : 'border-transparent text-gray-400'}`}>Interactive WhatsApp</button></div>
          </div>

          {waTab === 'official' ? (
            <div className="min-h-[480px] bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide">Catalogo Meta</h3><span className="text-xs text-gray-500 bg-white dark:bg-gray-700 px-2 py-1 rounded border border-gray-200 dark:border-gray-600">{approvedCount} aprovados / {waTemplates.length} total</span></div>
              <div className="overflow-y-auto p-4 custom-scrollbar min-h-[420px]">
                {waLoading ? <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">{Array.from({ length: 4 }).map((_, index) => <div key={`wa_skel_${index}`} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/20 p-4"><SkeletonBox className="h-5 w-40" /><SkeletonBox className="h-12 w-full mt-4" /></div>)}</div> : waTemplates.length === 0 ? <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 opacity-80"><ShieldCheck size={48} /><p>Nenhum template WhatsApp sincronizado ainda.</p></div> : <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">{waTemplates.map((template) => <div key={template.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/20 overflow-hidden"><div className="px-4 py-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div className="min-w-0"><h4 className="text-base font-semibold text-gray-900 dark:text-white truncate">{template.name}</h4><div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400"><span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700"><Languages size={12} /> {template.language || 'sem idioma'}</span><span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700">Categoria: {template.category || 'sem categoria'}</span>{template.qualityScore && <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700">Qualidade: {template.qualityScore}</span>}</div></div><StatusPill status={template.status} /></div><div className="p-4 space-y-4"><div className="divide-y divide-gray-200 border-y border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800"><div className="flex items-center gap-3 py-2"><div className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400">ID Onion</div><code className="min-w-0 flex-1 break-all text-xs text-gray-700 dark:text-gray-200">{template.id}</code><button type="button" onClick={() => copyTemplateId(template.id, 'ID Onion')} className="shrink-0 p-1.5 text-gray-400 transition hover:text-blue-600" aria-label="Copiar ID Onion" title="Usar em campanhas e integracoes"><Copy size={14} /></button></div><div className="flex items-center gap-3 py-2"><div className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400">ID Meta</div><code className="min-w-0 flex-1 break-all text-xs text-gray-700 dark:text-gray-200">{template.metaTemplateId || '-'}</code>{template.metaTemplateId && <button type="button" onClick={() => copyTemplateId(template.metaTemplateId, 'ID Meta')} className="shrink-0 p-1.5 text-gray-400 transition hover:text-blue-600" aria-label="Copiar ID Meta"><Copy size={14} /></button>}</div></div>{template.headerText && <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Header</div><p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{template.headerText}</p></div>}<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Body</div><p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{template.bodyText || 'Sem corpo informado pela Meta.'}</p></div>{template.footerText && <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Footer</div><p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{template.footerText}</p></div>}{template.buttons?.length > 0 && <div className="flex flex-wrap gap-2">{template.buttons.map((button) => <span key={`${template.id}_${button.index}`} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white dark:bg-gray-800 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-medium"><MousePointer2 size={12} />{button.text || button.type}</span>)}</div>}{template.rejectedReason && <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/30 dark:bg-red-900/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"><span className="font-semibold">Motivo:</span> {template.rejectedReason}</div>}</div></div>)}</div>}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 min-h-[720px]">
              <div className="lg:col-span-5 flex flex-col gap-6 overflow-y-auto lg:pr-2">
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-6 shadow-sm">
                  <div className="flex items-center justify-between gap-3 mb-6 pb-4 border-b border-gray-100 dark:border-gray-700"><div><h2 className="text-lg font-semibold text-gray-900 dark:text-white">Nova interactive message</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Monte list messages, reply buttons e mensagens de catalogo reutilizaveis.</p></div>{interactiveForm.id && <button type="button" onClick={resetInteractiveForm} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300">Novo</button>}</div>
                  <div className="space-y-5">
                    {interactiveValidationErrors.length > 0 && (
                      <div className="rounded-xl border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10 px-4 py-3">
                        <div className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
                          <AlertCircle size={16} />
                          Ajuste os campos antes de salvar
                        </div>
                        <ul className="mt-2 space-y-1 text-xs text-red-700 dark:text-red-300 list-disc pl-4">
                          {interactiveValidationErrors.slice(0, 6).map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Nome interno</label>
                        <input
                          className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none dark:text-white"
                          value={interactiveForm.name}
                          onChange={(event) => updateInteractiveForm({ name: event.target.value })}
                          placeholder="Ex: menu_atendimento_whatsapp"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Tipo</label>
                        <select
                          value={interactiveForm.kind}
                          onChange={(event) => changeInteractiveKind(event.target.value)}
                          className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none dark:text-white"
                        >
                          <option value="list">Interactive list</option>
                          <option value="button">Reply buttons</option>
                          <option value="product">Single product</option>
                          <option value="product_list">Multi product</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">
                        Header {interactiveForm.kind === 'product' ? '(desativado no single product)' : interactiveForm.kind === 'product_list' ? '(obrigatorio no multi product)' : '(opcional)'}
                      </label>
                      <input
                        className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none dark:text-white disabled:opacity-50"
                        value={interactiveForm.headerText}
                        onChange={(event) => updateInteractiveForm({ headerText: event.target.value })}
                        placeholder={interactiveForm.kind === 'product' ? 'Nao utilizado pelo single product' : 'Resumo rapido'}
                        maxLength={INTERACTIVE_LIMITS.headerText}
                        disabled={interactiveForm.kind === 'product'}
                      />
                      <FieldCounter value={interactiveForm.headerText} limit={INTERACTIVE_LIMITS.headerText} hint={interactiveForm.kind === 'product' ? 'A Meta nao aceita header em single product.' : interactiveForm.kind === 'product_list' ? 'Obrigatorio no multi product.' : 'Limite do WhatsApp para header em texto.'} />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Body</label>
                      <textarea
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none resize-none h-28 dark:text-white"
                        value={interactiveForm.bodyText}
                        onChange={(event) => updateInteractiveForm({ bodyText: event.target.value })}
                        placeholder="Escolha uma opcao abaixo para continuar."
                        maxLength={INTERACTIVE_LIMITS.bodyText}
                      />
                      <FieldCounter value={interactiveForm.bodyText} limit={INTERACTIVE_LIMITS.bodyText} hint="O body e obrigatorio." />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Footer (opcional)</label>
                      <input
                        className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none dark:text-white"
                        value={interactiveForm.footerText}
                        onChange={(event) => updateInteractiveForm({ footerText: event.target.value })}
                        placeholder="Atendimento da empresa"
                        maxLength={INTERACTIVE_LIMITS.footerText}
                      />
                      <FieldCounter value={interactiveForm.footerText} limit={INTERACTIVE_LIMITS.footerText} />
                    </div>

                    {interactiveForm.kind === 'list' ? (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Texto do botao</label>
                          <input
                            className="w-full px-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm outline-none dark:text-white"
                            value={interactiveForm.actionTitle}
                            onChange={(event) => updateInteractiveForm({ actionTitle: event.target.value })}
                            placeholder="Ver opcoes"
                            maxLength={INTERACTIVE_LIMITS.actionTitle}
                          />
                          <FieldCounter value={interactiveForm.actionTitle} limit={INTERACTIVE_LIMITS.actionTitle} hint="Texto do botao que abre a lista." />
                        </div>

                        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-700/20 space-y-4">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Secoes e linhas</div>
                              <div className={`text-[11px] ${totalInteractiveRows > INTERACTIVE_LIMITS.maxRows ? 'text-red-500 dark:text-red-400' : 'text-gray-400'}`}>
                                Secoes: {interactiveForm.sections.length} / {INTERACTIVE_LIMITS.maxSections} · Linhas: {totalInteractiveRows} / {INTERACTIVE_LIMITS.maxRows}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={addInteractiveSection}
                              disabled={interactiveForm.sections.length >= INTERACTIVE_LIMITS.maxSections || totalInteractiveRows >= INTERACTIVE_LIMITS.maxRows}
                              className="text-xs flex items-center gap-1 text-blue-600 font-medium px-2 py-1 rounded disabled:opacity-40"
                            >
                              <Plus size={14} /> Add secao
                            </button>
                          </div>

                          {interactiveForm.sections.map((section, sectionIndex) => (
                            <div key={section.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-3">
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <input
                                    className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                    value={section.title}
                                    onChange={(event) => updateInteractiveSection(section.id, { title: event.target.value })}
                                    placeholder={`Titulo da secao ${sectionIndex + 1}`}
                                    maxLength={INTERACTIVE_LIMITS.sectionTitle}
                                  />
                                  <FieldCounter
                                    value={section.title}
                                    limit={INTERACTIVE_LIMITS.sectionTitle}
                                    hint={interactiveForm.sections.length > 1 ? 'Obrigatorio quando houver mais de uma secao.' : 'Opcional com uma unica secao.'}
                                  />
                                </div>
                                <button type="button" onClick={() => removeInteractiveSection(section.id)} className="p-2 text-gray-400 hover:text-red-500 rounded-md self-start">
                                  <Trash2 size={16} />
                                </button>
                              </div>

                              <div className="space-y-2">
                                {section.rows.map((row, rowIndex) => (
                                  <div key={row.id} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                                    <div>
                                      <input
                                        className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                        value={row.id}
                                        onChange={(event) => updateInteractiveRow(section.id, row.id, { id: event.target.value })}
                                        placeholder="ID estavel da linha"
                                        maxLength={INTERACTIVE_LIMITS.rowId}
                                      />
                                      <FieldCounter value={row.id} limit={INTERACTIVE_LIMITS.rowId} hint="Use um ID curto e estavel para condicoes no fluxo." />
                                    </div>
                                    <div>
                                      <input
                                        className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                        value={row.title}
                                        onChange={(event) => updateInteractiveRow(section.id, row.id, { title: event.target.value })}
                                        placeholder={`Titulo da linha ${rowIndex + 1}`}
                                        maxLength={INTERACTIVE_LIMITS.rowTitle}
                                      />
                                      <FieldCounter value={row.title} limit={INTERACTIVE_LIMITS.rowTitle} />
                                    </div>
                                    <div>
                                      <input
                                        className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                        value={row.description}
                                        onChange={(event) => updateInteractiveRow(section.id, row.id, { description: event.target.value })}
                                        placeholder="Descricao opcional"
                                        maxLength={INTERACTIVE_LIMITS.rowDescription}
                                      />
                                      <FieldCounter value={row.description} limit={INTERACTIVE_LIMITS.rowDescription} />
                                    </div>
                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                      <input
                                        className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                        value={row.sku || ''}
                                        onChange={(event) => updateInteractiveRow(section.id, row.id, { sku: event.target.value })}
                                        placeholder="SKU interno opcional"
                                      />
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                        value={row.unitPrice ?? ''}
                                        onChange={(event) => updateInteractiveRow(section.id, row.id, { unitPrice: event.target.value })}
                                        placeholder="Preco interno opcional"
                                      />
                                    </div>
                                    <p className="text-[10px] text-gray-400">SKU e preco nao sao enviados ao WhatsApp; servem para importar produtos no Carrinho Node.</p>
                                    <div className="flex justify-end">
                                      <button type="button" onClick={() => removeInteractiveRow(section.id, row.id)} className="text-xs text-red-500">Remover linha</button>
                                    </div>
                                  </div>
                                ))}
                              </div>

                              <button
                                type="button"
                                onClick={() => addInteractiveRow(section.id)}
                                disabled={totalInteractiveRows >= INTERACTIVE_LIMITS.maxRows}
                                className="text-xs flex items-center gap-1 text-blue-600 font-medium px-2 py-1 rounded disabled:opacity-40"
                              >
                                <Plus size={14} /> Add linha
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : interactiveForm.kind === 'product' ? (
                      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-amber-50 dark:bg-amber-900/10 space-y-4">
                        <div>
                          <div className="text-xs font-bold text-amber-700 dark:text-amber-300 uppercase">Single product</div>
                          <div className="text-[11px] text-amber-700/80 dark:text-amber-300/80 mt-1">
                            Selecione um produto sincronizado pelo Catalogo.
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Catalog ID (Meta)</label>
                          <input
                            className="w-full px-4 py-2 bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 rounded-lg text-sm outline-none dark:text-white"
                            value={interactiveForm.catalogId}
                            onChange={(event) => updateInteractiveForm({ catalogId: event.target.value })}
                            readOnly={Boolean(metaCatalog?.catalogId)}
                            placeholder="Ex: 123456789012345"
                            maxLength={INTERACTIVE_LIMITS.catalogId}
                          />
                          <FieldCounter value={interactiveForm.catalogId} limit={INTERACTIVE_LIMITS.catalogId} hint={metaCatalog?.remoteName ? `Vinculado a ${metaCatalog.remoteName}.` : 'Configure a integracao na pagina Catalogo.'} />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Product retailer ID</label>
                          {metaCatalogItems.length ? <select
                            className="w-full px-4 py-2 bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 rounded-lg text-sm outline-none dark:text-white"
                            value={interactiveForm.productRetailerId}
                            onChange={(event) => updateInteractiveForm({ productRetailerId: event.target.value, catalogId: metaCatalog?.catalogId || interactiveForm.catalogId })}
                          >
                            <option value="">Selecione um produto sincronizado</option>
                            {interactiveForm.productRetailerId && !metaCatalogItems.some((item) => item.metaProductRetailerId === interactiveForm.productRetailerId) && <option value={interactiveForm.productRetailerId}>{interactiveForm.productRetailerId} (legado)</option>}
                            {metaCatalogItems.map((item) => <option key={item.id} value={item.metaProductRetailerId}>{item.name} · {item.sku || item.metaProductRetailerId}</option>)}
                          </select> : <input
                            className="w-full px-4 py-2 bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 rounded-lg text-sm outline-none dark:text-white"
                            value={interactiveForm.productRetailerId}
                            onChange={(event) => updateInteractiveForm({ productRetailerId: event.target.value })}
                            placeholder="Nenhum produto sincronizado; informe o retailer ID"
                            maxLength={INTERACTIVE_LIMITS.productRetailerId}
                          />}
                          <FieldCounter value={interactiveForm.productRetailerId} limit={INTERACTIVE_LIMITS.productRetailerId} hint="Retailer ID do produto sincronizado na Meta." />
                        </div>
                      </div>
                    ) : interactiveForm.kind === 'product_list' ? (
                      <div className="rounded-xl border border-orange-200 dark:border-orange-900/40 p-4 bg-orange-50 dark:bg-orange-900/10 space-y-4">
                        <div>
                          <div className="text-xs font-bold text-orange-700 dark:text-orange-300 uppercase">Multi product</div>
                          <div className="text-[11px] text-orange-700/80 dark:text-orange-300/80 mt-1">
                            Monte secoes usando os produtos sincronizados pelo Catalogo.
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1.5">Catalog ID (Meta)</label>
                          <input
                            className="w-full px-4 py-2 bg-white dark:bg-gray-800 border border-orange-200 dark:border-orange-800 rounded-lg text-sm outline-none dark:text-white"
                            value={interactiveForm.catalogId}
                            onChange={(event) => updateInteractiveForm({ catalogId: event.target.value })}
                            readOnly={Boolean(metaCatalog?.catalogId)}
                            placeholder="Ex: 123456789012345"
                            maxLength={INTERACTIVE_LIMITS.catalogId}
                          />
                          <FieldCounter value={interactiveForm.catalogId} limit={INTERACTIVE_LIMITS.catalogId} hint={metaCatalog?.remoteName ? `Vinculado a ${metaCatalog.remoteName}.` : 'Configure a integracao na pagina Catalogo.'} />
                        </div>
                        <div className="rounded-xl border border-orange-200 dark:border-orange-900/40 p-4 bg-white/70 dark:bg-gray-800/40 space-y-4">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Secoes e produtos</div>
                              <div className={`text-[11px] ${totalInteractiveProductItems > INTERACTIVE_LIMITS.maxProductItems ? 'text-red-500 dark:text-red-400' : 'text-gray-400'}`}>
                                Secoes: {interactiveForm.productSections.length} / {INTERACTIVE_LIMITS.maxProductSections} · Produtos: {totalInteractiveProductItems} / {INTERACTIVE_LIMITS.maxProductItems}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={addProductSection}
                              disabled={interactiveForm.productSections.length >= INTERACTIVE_LIMITS.maxProductSections || totalInteractiveProductItems >= INTERACTIVE_LIMITS.maxProductItems}
                              className="text-xs flex items-center gap-1 text-orange-600 font-medium px-2 py-1 rounded disabled:opacity-40"
                            >
                              <Plus size={14} /> Add secao
                            </button>
                          </div>
                          {interactiveForm.productSections.map((section, sectionIndex) => (
                            <div key={section.id} className="rounded-xl border border-orange-200 dark:border-orange-900/40 bg-white dark:bg-gray-800 p-3 space-y-3">
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <input
                                    className="w-full px-3 py-2 bg-orange-50/50 dark:bg-gray-700 border border-orange-200 dark:border-orange-900/40 rounded-md text-sm outline-none dark:text-white"
                                    value={section.title}
                                    onChange={(event) => updateProductSection(section.id, { title: event.target.value })}
                                    placeholder={`Titulo da secao ${sectionIndex + 1}`}
                                    maxLength={INTERACTIVE_LIMITS.productSectionTitle}
                                  />
                                  <FieldCounter value={section.title} limit={INTERACTIVE_LIMITS.productSectionTitle} hint="Obrigatorio se houver mais de uma secao." />
                                </div>
                                <button type="button" onClick={() => removeProductSection(section.id)} className="p-2 text-gray-400 hover:text-red-500 rounded-md self-start">
                                  <Trash2 size={16} />
                                </button>
                              </div>
                              <div className="space-y-2">
                                {section.productItems.map((productItem, productIndex) => (
                                  <div key={productItem.id} className="rounded-lg border border-orange-200 dark:border-orange-900/40 p-3 space-y-2">
                                    <div className="flex gap-2">
                                      <div className="flex-1">
                                        {metaCatalogItems.length ? <select
                                          className="w-full px-3 py-2 bg-orange-50/50 dark:bg-gray-700 border border-orange-200 dark:border-orange-900/40 rounded-md text-sm outline-none dark:text-white"
                                          value={productItem.productRetailerId}
                                          onChange={(event) => {
                                            updateProductItem(section.id, productItem.id, { productRetailerId: event.target.value });
                                            updateInteractiveForm({ catalogId: metaCatalog?.catalogId || interactiveForm.catalogId });
                                          }}
                                        >
                                          <option value="">Selecione o produto {productIndex + 1}</option>
                                          {productItem.productRetailerId && !metaCatalogItems.some((item) => item.metaProductRetailerId === productItem.productRetailerId) && <option value={productItem.productRetailerId}>{productItem.productRetailerId} (legado)</option>}
                                          {metaCatalogItems.map((item) => <option key={item.id} value={item.metaProductRetailerId}>{item.name} · {item.sku || item.metaProductRetailerId}</option>)}
                                        </select> : <input
                                          className="w-full px-3 py-2 bg-orange-50/50 dark:bg-gray-700 border border-orange-200 dark:border-orange-900/40 rounded-md text-sm outline-none dark:text-white"
                                          value={productItem.productRetailerId}
                                          onChange={(event) => updateProductItem(section.id, productItem.id, { productRetailerId: event.target.value })}
                                          placeholder={`Product retailer ID ${productIndex + 1}`}
                                          maxLength={INTERACTIVE_LIMITS.productRetailerId}
                                        />}
                                        <FieldCounter value={productItem.productRetailerId} limit={INTERACTIVE_LIMITS.productRetailerId} hint="ID do produto na Meta." />
                                      </div>
                                      <button type="button" onClick={() => removeProductItem(section.id, productItem.id)} className="p-2 text-gray-400 hover:text-red-500 rounded-md self-start">
                                        <Trash2 size={16} />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <button
                                type="button"
                                onClick={() => addProductItem(section.id)}
                                disabled={totalInteractiveProductItems >= INTERACTIVE_LIMITS.maxProductItems}
                                className="text-xs flex items-center gap-1 text-orange-600 font-medium px-2 py-1 rounded disabled:opacity-40"
                              >
                                <Plus size={14} /> Add produto
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-700/20 space-y-4">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">Reply buttons</div>
                            <div className="text-[11px] text-gray-400">Maximo de {INTERACTIVE_LIMITS.maxButtons} botoes.</div>
                          </div>
                          <button
                            type="button"
                            onClick={addReplyButton}
                            disabled={interactiveForm.buttons.length >= INTERACTIVE_LIMITS.maxButtons}
                            className="text-xs flex items-center gap-1 text-blue-600 font-medium px-2 py-1 rounded disabled:opacity-40"
                          >
                            <Plus size={14} /> Add botao
                          </button>
                        </div>

                        <div className="space-y-2">
                          {interactiveForm.buttons.map((button, index) => (
                            <div key={button.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-2">
                              <div>
                                <input
                                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                  value={button.id}
                                  onChange={(event) => updateReplyButton(button.id, { id: event.target.value })}
                                  placeholder="ID estavel do botao"
                                  maxLength={INTERACTIVE_LIMITS.buttonId}
                                />
                                <FieldCounter value={button.id} limit={INTERACTIVE_LIMITS.buttonId} hint="Use esse ID para ramificar pelo payload." />
                              </div>
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <input
                                    className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md text-sm outline-none dark:text-white"
                                    value={button.title}
                                    onChange={(event) => updateReplyButton(button.id, { title: event.target.value })}
                                    placeholder={`Texto do botao ${index + 1}`}
                                    maxLength={INTERACTIVE_LIMITS.buttonTitle}
                                  />
                                  <FieldCounter value={button.title} limit={INTERACTIVE_LIMITS.buttonTitle} />
                                </div>
                                <button type="button" onClick={() => removeReplyButton(button.id)} className="p-2 text-gray-400 hover:text-red-500 rounded-md self-start">
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={saveInteractiveTemplate}
                      disabled={interactiveSaving || interactiveValidationErrors.length > 0}
                      className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium rounded-lg transition-colors shadow-sm"
                    >
                      <Save size={18} />
                      {interactiveSaving ? 'Salvando...' : interactiveForm.id ? 'Atualizar interactive message' : 'Salvar interactive message'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 flex flex-col gap-6 min-h-0">
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <MessageSquare size={18} className="text-blue-500" />
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide">Preview</h3>
                  </div>
                  <div className="max-w-md rounded-3xl rounded-tl-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden shadow-sm">
                    {interactiveForm.headerText && interactiveForm.kind !== 'product' && (
                      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-100">
                        {interactiveForm.headerText}
                      </div>
                    )}
                    <div className="px-4 py-4 space-y-3">
                      <p className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                        {interactiveForm.bodyText || 'Corpo da mensagem interativa'}
                      </p>
                      {interactiveForm.footerText && (
                        <p className="text-xs text-gray-400 dark:text-gray-500">{interactiveForm.footerText}</p>
                      )}
                    </div>
                    <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                      {interactiveForm.kind === 'list' ? (
                        <>
                          <div className="px-4 py-3 text-center text-sm font-semibold text-blue-600 dark:text-blue-400 border-b border-gray-200 dark:border-gray-700">
                            {interactiveForm.actionTitle || 'Ver opcoes'}
                          </div>
                          <div className="p-4 space-y-3">
                            {interactiveForm.sections.map((section) => (
                              <div key={section.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 space-y-2">
                                {section.title && <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">{section.title}</div>}
                                {section.rows.map((row) => (
                                  <div key={row.id} className="rounded-md bg-gray-50 dark:bg-gray-800 px-3 py-2">
                                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{row.title || 'Linha sem titulo'}</div>
                                    {row.description && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{row.description}</div>}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </>
                      ) : interactiveForm.kind === 'product' ? (
                        <div className="p-4">
                          <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-900 p-4 space-y-3">
                            <div className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Single product</div>
                            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Catalog ID</div>
                              <div className="mt-1 text-xs font-mono break-all text-amber-900 dark:text-amber-100">{interactiveForm.catalogId || 'nao definido'}</div>
                            </div>
                            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Product retailer ID</div>
                              <div className="mt-1 text-xs font-mono break-all text-amber-900 dark:text-amber-100">{interactiveForm.productRetailerId || 'nao definido'}</div>
                            </div>
                          </div>
                        </div>
                      ) : interactiveForm.kind === 'product_list' ? (
                        <div className="p-4 space-y-3">
                          <div className="rounded-2xl border border-orange-200 dark:border-orange-800 bg-white dark:bg-gray-900 p-4 space-y-3">
                            <div className="text-xs font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">Multi product</div>
                            <div className="rounded-lg bg-orange-50 dark:bg-orange-900/20 px-3 py-2">
                              <div className="text-[10px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">Catalog ID</div>
                              <div className="mt-1 text-xs font-mono break-all text-orange-900 dark:text-orange-100">{interactiveForm.catalogId || 'nao definido'}</div>
                            </div>
                            {interactiveForm.productSections.map((section, sectionIndex) => (
                              <div key={section.id} className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-900/10 p-3 space-y-2">
                                <div className="text-[11px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">{section.title || `Secao ${sectionIndex + 1}`}</div>
                                {section.productItems.map((productItem) => (
                                  <div key={productItem.id} className="rounded-md bg-white dark:bg-gray-900 px-3 py-2">
                                    <div className="text-xs font-mono break-all text-orange-900 dark:text-orange-100">{productItem.productRetailerId || 'produto_sem_id'}</div>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="p-3 flex flex-wrap gap-2">
                          {interactiveForm.buttons.map((button) => (
                            <span key={button.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-300 text-xs font-medium">
                              <MousePointer2 size={12} />
                              {button.title || 'Botao'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="min-h-[420px] bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
                  <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide">Interactive salvas</h3>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span className="text-xs text-gray-500 bg-white dark:bg-gray-700 px-2 py-1 rounded border border-gray-200 dark:border-gray-600">Total: {interactiveItems.length}</span>
                      <button type="button" onClick={() => setInteractiveImport({ bundle: null, targetTenant: null })} className="inline-flex h-8 items-center gap-1.5 border border-gray-300 bg-white px-2.5 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-blue-300">
                        <Upload size={13} aria-hidden="true" /> Importar
                      </button>
                      <button type="button" onClick={() => setShowInteractiveExport(true)} disabled={interactiveLoading || interactiveItems.length === 0} className="inline-flex h-8 items-center gap-1.5 border border-gray-300 bg-white px-2.5 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-blue-300">
                        <Download size={13} aria-hidden="true" /> Exportar
                      </button>
                    </div>
                  </div>
                  <InteractiveExportModal
                    open={showInteractiveExport}
                    onClose={() => setShowInteractiveExport(false)}
                    items={interactiveItems}
                    tenant={tenant}
                    isSuperAdmin={isSuperAdmin}
                    tenants={tenants}
                    fetchTenants={fetchTenants}
                    onCopyToTenant={(bundle, targetTenant) => {
                      setShowInteractiveExport(false);
                      setInteractiveImport({ bundle, targetTenant });
                    }}
                  />
                  <InteractiveImportModal
                    open={Boolean(interactiveImport)}
                    onClose={() => setInteractiveImport(null)}
                    initialBundle={interactiveImport?.bundle || null}
                    targetTenant={interactiveImport?.targetTenant || null}
                    currentTenantName={tenant?.name || ''}
                    onImported={() => {
                      if (!interactiveImport?.targetTenant || interactiveImport.targetTenant.id === tenant?.id) loadInteractiveTemplates();
                    }}
                  />
                  <div className="overflow-y-auto p-4 custom-scrollbar min-h-[360px]">
                    {interactiveLoading ? (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {Array.from({ length: 4 }).map((_, index) => (
                          <div key={`int_skel_${index}`} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/20 p-4">
                            <SkeletonBox className="h-5 w-40" />
                            <SkeletonBox className="h-12 w-full mt-4" />
                          </div>
                        ))}
                      </div>
                    ) : interactiveItems.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 opacity-80">
                        <MessageSquare size={48} />
                        <p>Nenhuma interactive message cadastrada ainda.</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {interactiveItems.map((item) => (
                          <div key={item.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/20 overflow-hidden">
                            <div className="px-4 py-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h4 className="text-base font-semibold text-gray-900 dark:text-white truncate">{item.name}</h4>
                                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full ${item.kind === 'list' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : item.kind === 'product' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : item.kind === 'product_list' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' : 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300'}`}>
                                    {getInteractiveKindLabel(item.kind)}
                                  </span>
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700">
                                    {item.kind === 'list'
                                      ? `Linhas: ${Array.isArray(item.sections) ? item.sections.reduce((sum, section) => sum + (Array.isArray(section.rows) ? section.rows.length : 0), 0) : 0}`
                                      : item.kind === 'product'
                                        ? '1 produto'
                                        : item.kind === 'product_list'
                                          ? `Produtos: ${Array.isArray(item.productSections) ? item.productSections.reduce((sum, section) => sum + (Array.isArray(section.productItems) ? section.productItems.length : 0), 0) : 0}`
                                        : `Botoes: ${Array.isArray(item.buttons) ? item.buttons.length : 0}`}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => editInteractiveTemplate(item)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold">Editar</button>
                                <button type="button" onClick={() => deleteInteractiveTemplate(item.id)} className="p-2 text-gray-400 hover:text-red-500 rounded-md">
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </div>
                            <div className="p-4 space-y-3">
                              {item.headerText && item.kind !== 'product' && (
                                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2">
                                  <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Header</div>
                                  <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{item.headerText}</p>
                                </div>
                              )}
                              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Body</div>
                                <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{item.bodyText}</p>
                              </div>
                              {item.footerText && (
                                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2">
                                  <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Footer</div>
                                  <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{item.footerText}</p>
                                </div>
                              )}
                              {item.kind === 'list' ? (
                                <div className="space-y-2">
                                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-blue-600 dark:text-blue-300 font-semibold text-center">
                                    {item.actionTitle || 'Ver opcoes'}
                                  </div>
                                  {Array.isArray(item.sections) && item.sections.map((section, sectionIndex) => (
                                    <div key={`${item.id}_section_${sectionIndex}`} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 space-y-2">
                                      {section.title && <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{section.title}</div>}
                                      {Array.isArray(section.rows) && section.rows.map((row) => (
                                        <div key={row.id} className="rounded-md bg-gray-50 dark:bg-gray-700/30 px-3 py-2">
                                          <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{row.title}</div>
                                          {row.description && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{row.description}</div>}
                                        </div>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              ) : item.kind === 'product' ? (
                                <div className="space-y-2">
                                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">Catalog ID</div>
                                    <div className="text-xs font-mono break-all text-amber-900 dark:text-amber-100">{item.catalogId || 'nao definido'}</div>
                                  </div>
                                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">Product retailer ID</div>
                                    <div className="text-xs font-mono break-all text-amber-900 dark:text-amber-100">{item.productRetailerId || 'nao definido'}</div>
                                  </div>
                                </div>
                              ) : item.kind === 'product_list' ? (
                                <div className="space-y-2">
                                  <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300 mb-1">Catalog ID</div>
                                    <div className="text-xs font-mono break-all text-orange-900 dark:text-orange-100">{item.catalogId || 'nao definido'}</div>
                                  </div>
                                  {Array.isArray(item.productSections) && item.productSections.map((section, sectionIndex) => (
                                    <div key={`${item.id}_product_section_${sectionIndex}`} className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-900/10 p-3 space-y-2">
                                      <div className="text-[10px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">{section.title || `Secao ${sectionIndex + 1}`}</div>
                                      {Array.isArray(section.productItems) && section.productItems.map((productItem, productIndex) => (
                                        <div key={`${item.id}_product_item_${sectionIndex}_${productIndex}`} className="rounded-md bg-white dark:bg-gray-800 px-3 py-2">
                                          <div className="text-xs font-mono break-all text-orange-900 dark:text-orange-100">{productItem.productRetailerId || 'produto_sem_id'}</div>
                                        </div>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {Array.isArray(item.buttons) && item.buttons.map((button) => (
                                    <span key={button.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white dark:bg-gray-800 border border-fuchsia-200 dark:border-fuchsia-800 text-fuchsia-700 dark:text-fuchsia-300 text-xs font-medium">
                                      <MousePointer2 size={12} />
                                      {button.title}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </main>
  );
};

export default TemplateManager;
