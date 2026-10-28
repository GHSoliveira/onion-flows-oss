import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Ban,
  Bot,
  Building2,
  CheckSquare,
  Clock3,
  Filter,
  Layers3,
  Loader2,
  Mail,
  MessageCircleMore,
  Phone,
  Plus,
  Radio,
  Rocket,
  Search,
  SendHorizontal,
  ShieldCheck,
  ChevronDown,
  Square,
  Tags,
  UserRound,
  Users,
  X
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { useDialog } from '../context/DialogContext';
import { useAuth } from '../context/AuthContext';
import { socketService } from '../services/socket';
import { SkeletonBox } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';
import { can } from '../utils/managerPermissions';

const createPhoneDraft = (overrides = {}) => ({
  id: `draft_phone_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
  label: 'Principal',
  channel: 'whatsapp',
  number: '',
  waId: '',
  ...overrides
});

const createEmptyForm = () => ({ id: null, name: '', company: '', email: '', notes: '', tagsInput: '', phones: [createPhoneDraft()] });
const createEmptyHistoryState = () => ({ loading: false, items: [] });
const createEmptyValues = () => ({ header: [], body: [], buttons: {}, headerMediaUrl: '' });
const createEmptyOutreachState = () => ({ open: false, loading: false, sending: false, contact: null, templates: [], senderOptions: [], channelReady: false, senderPhoneNumberId: '', phoneEntryId: '', templateId: '', values: createEmptyValues() });
const createEmptyCampaignState = () => ({ open: false, loading: false, submitting: false, templates: [], senderOptions: [], channelReady: false, senderPhoneNumberId: '', templateId: '', values: createEmptyValues() });
const createEmptyModerationState = () => ({ open: false, loading: false, submitting: false, contact: null, senderOptions: [], senderPhoneNumberId: '', phoneEntryId: '', blocked: false, waId: null, statusChecked: false, statusComplete: true });
const createEmptyErasureState = () => ({ open: false, phone: '', cpf: '', reason: '', acknowledged: false, loading: false, submitting: false, preview: null, result: null });
const defaultFilters = { channel: '', outreachStatus: '', tag: '' };
const TEMPLATE_TOKEN_REGEX = /\{\{\s*[^{}]+\s*\}\}/g;

const sanitizePhones = (phones) => (Array.isArray(phones) ? phones : [])
  .map((phone) => ({
    id: phone.id || `draft_phone_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    label: String(phone.label || '').trim(),
    channel: String(phone.channel || 'whatsapp').trim().toLowerCase() || 'whatsapp',
    number: String(phone.number || '').trim(),
    waId: String(phone.waId || '').trim()
  }))
  .filter((phone) => phone.number);

const countPlaceholders = (value) => (String(value || '').match(TEMPLATE_TOKEN_REGEX) || []).length;
const getContactWhatsAppPhones = (contact) => (Array.isArray(contact?.phones) ? contact.phones : []).filter((phone) => String(phone?.channel || '').toLowerCase() === 'whatsapp' && phone?.number);
const getPhoneEntryKey = (phone) => String(phone?.id || phone?.waId || phone?.normalizedNumber || phone?.number || '');

const describeTemplateInputs = (template) => {
  const components = Array.isArray(template?.components) ? template.components : [];
  const header = components.find((component) => String(component?.type || '').toUpperCase() === 'HEADER') || null;
  const body = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY') || null;
  const buttons = Array.isArray(template?.buttons) ? template.buttons : [];
  const headerText = String(header?.text || template?.headerText || '');
  const bodyText = String(body?.text || template?.bodyText || '');
  const headerFormat = String(header?.format || template?.headerFormat || '').toUpperCase();
  return {
    header: { format: headerFormat || null, text: headerText, placeholderCount: countPlaceholders(headerText), requiresMedia: ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) },
    body: { text: bodyText, placeholderCount: countPlaceholders(bodyText) },
    buttons: buttons.map((button) => ({ index: String(button.index), text: String(button.text || ''), type: String(button.type || 'UNKNOWN').toUpperCase(), placeholderCount: countPlaceholders(button.url || button.text || '') })).filter((button) => button.placeholderCount > 0)
  };
};

const createValuesForTemplate = (template) => {
  const inputDef = describeTemplateInputs(template);
  return {
    header: Array.from({ length: inputDef.header.placeholderCount }, () => ''),
    body: Array.from({ length: inputDef.body.placeholderCount }, () => ''),
    buttons: inputDef.buttons.reduce((acc, button) => ({ ...acc, [button.index]: Array.from({ length: button.placeholderCount }, () => '') }), {}),
    headerMediaUrl: ''
  };
};

const replaceTemplateTokens = (text, values = []) => {
  let cursor = 0;
  return String(text || '').replace(TEMPLATE_TOKEN_REGEX, () => {
    const nextValue = values[cursor];
    cursor += 1;
    return nextValue ? String(nextValue) : '{{...}}';
  });
};

const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR');
};

const formatStatusLabel = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'sem status';
  if (normalized === 'sent') return 'enviado';
  if (normalized === 'delivered') return 'entregue';
  if (normalized === 'read') return 'lido';
  if (normalized === 'failed') return 'falhou';
  if (normalized === 'pending') return 'pendente';
  if (normalized === 'processing') return 'processando';
  if (normalized === 'completed') return 'concluida';
  if (normalized === 'completed_with_errors') return 'concluida com erros';
  return normalized;
};

const statusTone = {
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  delivered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  read: 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300',
  processing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
  completed_with_errors: 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300'
};

const buildWhatsAppSetup = (data) => {
  const templates = (Array.isArray(data?.items) ? data.items : []).filter((template) => ['APPROVED', 'ACTIVE'].includes(String(template.status || '').toUpperCase()));
  const senderOptions = Array.isArray(data?.channelConfig?.senderNumbers) && data.channelConfig.senderNumbers.length > 0
    ? data.channelConfig.senderNumbers
    : (data?.channelConfig?.phoneNumberId ? [{ id: `sender_${data.channelConfig.phoneNumberId}`, label: 'Principal', displayNumber: null, phoneNumberId: data.channelConfig.phoneNumberId }] : []);
  const defaultTemplate = templates[0] || null;
  const defaultSender = senderOptions.find((item) => item.isDefault) || senderOptions[0] || null;
  return { templates, senderOptions, defaultTemplate, defaultSender, channelReady: Boolean(data?.channelConfig?.ready) };
};

const TemplateInputFields = ({ inputDef, values, onArrayChange, onButtonChange, onMediaChange }) => {
  if (!inputDef) return null;
  const hasAnyInput = (
    Boolean(inputDef.header.requiresMedia) ||
    Number(inputDef.header.placeholderCount || 0) > 0 ||
    Number(inputDef.body.placeholderCount || 0) > 0 ||
    (Array.isArray(inputDef.buttons) && inputDef.buttons.length > 0)
  );
  return (
    <div className="space-y-4">
      {!hasAnyInput && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
          Este template nao possui variaveis dinamicas.
        </div>
      )}
      {inputDef.header.requiresMedia && <div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">URL publica da midia do header</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={values.headerMediaUrl} onChange={(event) => onMediaChange(event.target.value)} placeholder="https://..." /></div>}
      {Array.from({ length: inputDef.header.placeholderCount }).map((_, index) => <div key={`header_param_${index}`}><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Header parametro {index + 1}</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={values.header[index] || ''} onChange={(event) => onArrayChange('header', index, event.target.value)} placeholder={`Valor ${index + 1}`} /></div>)}
      {Array.from({ length: inputDef.body.placeholderCount }).map((_, index) => <div key={`body_param_${index}`}><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Corpo parametro {index + 1}</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={values.body[index] || ''} onChange={(event) => onArrayChange('body', index, event.target.value)} placeholder={`Valor ${index + 1}`} /></div>)}
      {inputDef.buttons.map((button) => <div key={`button_param_${button.index}`} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 space-y-3"><div className="text-sm font-semibold text-gray-900 dark:text-white">Botao {Number(button.index) + 1}: {button.text || button.type}</div>{Array.from({ length: button.placeholderCount }).map((_, valueIndex) => <div key={`button_${button.index}_${valueIndex}`}><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Parametro {valueIndex + 1}</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={values.buttons?.[button.index]?.[valueIndex] || ''} onChange={(event) => onButtonChange(button.index, valueIndex, event.target.value)} placeholder={`Valor ${valueIndex + 1}`} /></div>)}</div>)}
    </div>
  );
};

const TemplatePreview = ({ template, inputDef, values, subtitle }) => (
  <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-4 space-y-4 shadow-sm">
    <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 flex items-center justify-center"><Bot size={18} /></div><div className="min-w-0"><div className="text-sm font-semibold text-gray-900 dark:text-white truncate">{template?.name || 'Template'}</div><div className="text-xs text-gray-500 dark:text-gray-400 truncate">{subtitle}</div></div></div>
    {inputDef?.header?.text && <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 py-3 text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">{replaceTemplateTokens(inputDef.header.text, values.header)}</div>}
    {inputDef?.header?.requiresMedia && values.headerMediaUrl && <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 px-3 py-3 text-xs text-gray-500 dark:text-gray-400 break-all">Midia do header: {values.headerMediaUrl}</div>}
    <div className="rounded-2xl rounded-tl-sm bg-emerald-600 text-white px-4 py-3 text-sm whitespace-pre-wrap break-words shadow-sm">{replaceTemplateTokens(inputDef?.body?.text || 'Corpo do template', values.body)}</div>
    {template?.buttons?.length > 0 && <div className="flex flex-wrap gap-2">{template.buttons.map((button) => <span key={`preview_button_${button.index}`} className="px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-gray-900 text-emerald-700 dark:text-emerald-300 text-xs font-medium">{button.text || button.type}</span>)}</div>}
  </div>
);

const ActiveContacts = () => {
  const navigate = useNavigate();
  const { confirm } = useDialog();
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [campaigns, setCampaigns] = useState({ loading: true, items: [] });
  const [isRecentCampaignsCollapsed, setIsRecentCampaignsCollapsed] = useState(true);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState(defaultFilters);
  const [selectedId, setSelectedId] = useState(null);
  // Selecao por id com o contato guardado: continua valendo ao trocar de pagina.
  const [selectedById, setSelectedById] = useState({});
  const selectedContactIds = useMemo(() => Object.keys(selectedById), [selectedById]);
  const [contactsMeta, setContactsMeta] = useState({ total: 0, withWhatsApp: 0, tags: [], pages: 1 });
  const [form, setForm] = useState(createEmptyForm());
  const [history, setHistory] = useState(createEmptyHistoryState());
  const [outreachState, setOutreachState] = useState(createEmptyOutreachState());
  const [campaignState, setCampaignState] = useState(createEmptyCampaignState());
  const [moderationState, setModerationState] = useState(createEmptyModerationState());
  const [erasureState, setErasureState] = useState(createEmptyErasureState());
  // Atendimento ativo (outreach) é recurso pago. Default false até o backend confirmar.
  const [outreachEnabled, setOutreachEnabled] = useState(false);
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  const CONTACTS_PER_PAGE = 20;
  const canModerateWhatsApp = can(user, 'config.whatsapp');
  const canEraseData = can(user, 'dados.lgpd');

  const selectedContact = useMemo(() => contacts.find((contact) => contact.id === selectedId) || null, [contacts, selectedId]);
  const selectedContacts = useMemo(() => Object.values(selectedById), [selectedById]);
  const selectedContactsWithWhatsApp = useMemo(() => selectedContacts.filter((contact) => getContactWhatsAppPhones(contact).length > 0), [selectedContacts]);
  const contactsWithWhatsApp = contactsMeta.withWhatsApp;
  const activeOutreachTemplate = useMemo(() => outreachState.templates.find((template) => template.id === outreachState.templateId) || null, [outreachState.templates, outreachState.templateId]);
  const activeCampaignTemplate = useMemo(() => campaignState.templates.find((template) => template.id === campaignState.templateId) || null, [campaignState.templates, campaignState.templateId]);
  const activeOutreachTemplateInputs = useMemo(() => describeTemplateInputs(activeOutreachTemplate), [activeOutreachTemplate]);
  const activeCampaignTemplateInputs = useMemo(() => describeTemplateInputs(activeCampaignTemplate), [activeCampaignTemplate]);
  const availableTags = contactsMeta.tags;
  const hasRunningCampaign = useMemo(() => campaigns.items.some((item) => ['pending', 'processing'].includes(String(item.status || '').toLowerCase())), [campaigns.items]);

  // Paginacao no servidor: `contacts` ja e so a pagina atual.
  const totalPages = contactsMeta.pages;
  const currentPage = page;
  const pagedContacts = contacts;

  const buildContactQuery = (nextQuery = query, nextFilters = filters) => {
    const params = new URLSearchParams();
    const trimmedQuery = String(nextQuery || '').trim();
    if (trimmedQuery) params.set('q', trimmedQuery);
    if (nextFilters?.channel) params.set('channel', nextFilters.channel);
    if (nextFilters?.outreachStatus) params.set('outreachStatus', nextFilters.outreachStatus);
    if (nextFilters?.tag) params.set('tag', nextFilters.tag);
    return params.toString();
  };

  // Busca e filtro voltam para a pagina 1; salvar/apagar recarrega a pagina atual.
  const loadContacts = async (nextQuery = query, nextFilters = filters, nextPage = pageRef.current) => {
    try {
      setLoading(true);
      const params = new URLSearchParams(buildContactQuery(nextQuery, nextFilters));
      params.set('page', String(nextPage));
      params.set('limit', String(CONTACTS_PER_PAGE));
      const res = await apiRequest(`/contacts?${params.toString()}`);
      if (!res || !res.ok) throw new Error('Falha ao carregar contatos');
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data?.items) ? data.items : [];
      setContacts(list);
      setContactsMeta({ total: Number(data?.total) || 0, withWhatsApp: Number(data?.withWhatsApp) || 0, tags: Array.isArray(data?.tags) ? data.tags : [], pages: Math.max(1, Number(data?.pages) || 1) });
      pageRef.current = Number(data?.page) || nextPage;
      setPage(pageRef.current);
      if (selectedId && !list.some((contact) => contact.id === selectedId)) {
        setSelectedId(null);
        setForm(createEmptyForm());
      }
    } catch (error) {
      console.error(error);
      toast.error('Falha ao carregar contatos');
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async (contactId) => {
    if (!contactId) {
      setHistory(createEmptyHistoryState());
      return;
    }
    try {
      setHistory((prev) => ({ ...prev, loading: true }));
      const res = await apiRequest(`/contacts/outreach/history?contactId=${encodeURIComponent(contactId)}&limit=20`);
      const data = res ? await res.json().catch(() => []) : [];
      if (!res || !res.ok) throw new Error('Falha ao carregar historico');
      setHistory({ loading: false, items: Array.isArray(data) ? data : [] });
    } catch (error) {
      console.error(error);
      setHistory({ loading: false, items: [] });
    }
  };

  const loadCampaigns = async ({ silent = false } = {}) => {
    try {
      if (!silent) setCampaigns((prev) => ({ ...prev, loading: true }));
      const res = await apiRequest('/contacts/outreach/campaigns?limit=12');
      const data = res ? await res.json().catch(() => []) : [];
      if (!res || !res.ok) throw new Error('Falha ao carregar campanhas');
      setCampaigns({ loading: false, items: Array.isArray(data) ? data : [] });
    } catch (error) {
      console.error(error);
      setCampaigns((prev) => ({ loading: false, items: prev.items }));
    }
  };

  const loadWhatsAppSetup = async () => {
    const res = await apiRequest('/templates/whatsapp');
    const data = res ? await res.json().catch(() => ({})) : null;
    if (!res || !res.ok) throw new Error(data?.error || 'Falha ao carregar templates WhatsApp');
    return buildWhatsAppSetup(data);
  };

  useEffect(() => {
    loadContacts('');
    loadCampaigns();
    (async () => {
      try {
        const res = await apiRequest('/contacts/outreach/capabilities');
        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          setOutreachEnabled(data?.activeOutreach === true && can(user, 'atendimento.ativo'));
        }
      } catch (_) {
        setOutreachEnabled(false);
      }
    })();
  }, []);

  useEffect(() => { loadHistory(selectedId); }, [selectedId]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return undefined;
    socketService.connect(token);
    try {
      const user = JSON.parse(localStorage.getItem('user') || 'null');
      if (user?.tenantId) socketService.subscribeTenant(user.tenantId);
    } catch (_) {}

    let timeoutId = null;
    const refreshCampaigns = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => loadCampaigns({ silent: true }), 750);
    };

    socketService.on('campaign_update', refreshCampaigns);
    return () => {
      clearTimeout(timeoutId);
      socketService.off('campaign_update', refreshCampaigns);
    };
  }, []);

  useEffect(() => {
    if (!hasRunningCampaign) return undefined;
    const intervalId = setInterval(() => { loadCampaigns({ silent: true }); }, 15000);
    return () => clearInterval(intervalId);
  }, [hasRunningCampaign]);

  const fillForm = (contact) => {
    if (!contact) {
      setSelectedId(null);
      setForm(createEmptyForm());
      return;
    }
    setSelectedId(contact.id);
    setForm({ id: contact.id, name: contact.name || '', company: contact.company || '', email: contact.email || '', notes: contact.notes || '', tagsInput: Array.isArray(contact.tags) ? contact.tags.join(', ') : '', phones: Array.isArray(contact.phones) && contact.phones.length > 0 ? contact.phones.map((phone) => ({ id: phone.id || `draft_phone_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, label: phone.label || '', channel: phone.channel || 'whatsapp', number: phone.number || '', waId: phone.waId || '' })) : [createPhoneDraft()] });
  };

  const handleSearch = async () => { setQuery(searchInput); await loadContacts(searchInput, filters, 1); };
  const handleFilterChange = async (key, value) => { const nextFilters = { ...filters, [key]: value }; setFilters(nextFilters); await loadContacts(searchInput, nextFilters, 1); };
  const handleClearFilters = async () => { setFilters(defaultFilters); setSearchInput(''); setQuery(''); await loadContacts('', defaultFilters, 1); };
  const goToPage = (nextPage) => loadContacts(query, filters, Math.min(Math.max(1, nextPage), totalPages));
  const updatePhone = (id, key, value) => setForm((prev) => ({ ...prev, phones: prev.phones.map((phone) => (phone.id === id ? { ...phone, [key]: value } : phone)) }));
  const handleAddPhone = () => setForm((prev) => ({ ...prev, phones: [...prev.phones, createPhoneDraft({ label: `Telefone ${prev.phones.length + 1}` })] }));
  const handleRemovePhone = (id) => setForm((prev) => { const nextPhones = prev.phones.filter((phone) => phone.id !== id); return { ...prev, phones: nextPhones.length > 0 ? nextPhones : [createPhoneDraft()] }; });
  const handleNewContact = () => { setSelectedId(null); setForm(createEmptyForm()); };
  const closeOutreachModal = () => setOutreachState(createEmptyOutreachState());
  const closeCampaignModal = () => setCampaignState(createEmptyCampaignState());
  const closeModerationModal = () => setModerationState(createEmptyModerationState());
  const toggleContactSelection = (contactId) => setSelectedById((prev) => {
    if (prev[contactId]) { const { [contactId]: _removed, ...rest } = prev; return rest; }
    const contact = contacts.find((item) => item.id === contactId);
    return contact ? { ...prev, [contactId]: contact } : prev;
  });
  const handleSelectAllVisible = () => setSelectedById((prev) => ({
    ...prev,
    ...Object.fromEntries(contacts.filter((contact) => getContactWhatsAppPhones(contact).length > 0).map((contact) => [contact.id, contact]))
  }));
  const handleClearSelection = () => setSelectedById({});

  const loadModerationStatus = async ({ contact, phoneEntryId, senderPhoneNumberId }) => {
    if (!contact?.id || !phoneEntryId || !senderPhoneNumberId) return;
    try {
      setModerationState((prev) => ({ ...prev, loading: true, statusChecked: false }));
      const params = new URLSearchParams({ phoneEntryId, senderPhoneNumberId });
      const res = await apiRequest(`/contacts/${contact.id}/whatsapp/block-status?${params.toString()}`);
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao consultar bloqueio na Meta');
      setModerationState((prev) => ({
        ...prev,
        loading: false,
        blocked: data?.blocked === true,
        waId: data?.waId || null,
        statusChecked: true,
        statusComplete: data?.complete !== false
      }));
    } catch (error) {
      setModerationState((prev) => ({ ...prev, loading: false, statusChecked: false }));
      toast.error(error.message || 'Falha ao consultar bloqueio na Meta');
    }
  };

  const handlePrepareModeration = async (contact) => {
    const phones = getContactWhatsAppPhones(contact);
    if (!phones.length) return toast.error('Este contato nao possui numero WhatsApp.');
    setModerationState({ ...createEmptyModerationState(), open: true, loading: true, contact, phoneEntryId: getPhoneEntryKey(phones[0]) });
    try {
      const setup = await loadWhatsAppSetup();
      const senderPhoneNumberId = setup.defaultSender?.phoneNumberId || '';
      if (!setup.channelReady || !senderPhoneNumberId) throw new Error('O canal WhatsApp precisa estar configurado antes do bloqueio.');
      const next = {
        ...createEmptyModerationState(),
        open: true,
        loading: true,
        contact,
        phoneEntryId: getPhoneEntryKey(phones[0]),
        senderOptions: setup.senderOptions,
        senderPhoneNumberId
      };
      setModerationState(next);
      await loadModerationStatus(next);
    } catch (error) {
      closeModerationModal();
      toast.error(error.message || 'Falha ao preparar controle do contato');
    }
  };

  const handleModerationSelection = async (key, value) => {
    const next = { ...moderationState, [key]: value, blocked: false, waId: null, statusChecked: false };
    setModerationState(next);
    await loadModerationStatus(next);
  };

  const handleToggleWhatsAppBlock = async () => {
    if (!moderationState.contact?.id || !moderationState.phoneEntryId || !moderationState.senderPhoneNumberId) return;
    const action = moderationState.blocked ? 'desbloquear' : 'bloquear';
    const ok = await confirm({
      title: moderationState.blocked ? 'Desbloquear contato no WhatsApp' : 'Bloquear contato no WhatsApp',
      message: moderationState.blocked
        ? 'O contato voltara a poder enviar mensagens e receber comunicacoes deste numero empresarial.'
        : 'A Meta impedira mensagens nos dois sentidos entre este contato e o numero empresarial selecionado.',
      confirmText: moderationState.blocked ? 'Desbloquear' : 'Bloquear',
      type: moderationState.blocked ? 'warning' : 'danger'
    });
    if (!ok) return;
    try {
      setModerationState((prev) => ({ ...prev, submitting: true }));
      const res = await apiRequest(`/contacts/${moderationState.contact.id}/whatsapp/block`, {
        method: moderationState.blocked ? 'DELETE' : 'POST',
        body: JSON.stringify({
          phoneEntryId: moderationState.phoneEntryId,
          senderPhoneNumberId: moderationState.senderPhoneNumberId
        })
      });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || `Falha ao ${action} contato`);
      setModerationState((prev) => ({ ...prev, submitting: false, blocked: data?.blocked === true, waId: data?.waId || prev.waId, statusChecked: true }));
      toast.success(data?.blocked ? 'Contato bloqueado oficialmente na Meta' : 'Contato desbloqueado na Meta');
    } catch (error) {
      setModerationState((prev) => ({ ...prev, submitting: false }));
      toast.error(error.message || `Falha ao ${action} contato`);
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    const payload = { name: form.name.trim(), company: form.company.trim(), email: form.email.trim(), notes: form.notes.trim(), tags: form.tagsInput.split(',').map((tag) => tag.trim()).filter(Boolean), phones: sanitizePhones(form.phones) };
    if (!payload.name) return toast.error('Informe o nome do contato.');
    if (!payload.phones.length) return toast.error('Informe pelo menos um telefone.');
    try {
      setSaving(true);
      const endpoint = form.id ? `/contacts/${form.id}` : '/contacts';
      const method = form.id ? 'PUT' : 'POST';
      const res = await apiRequest(endpoint, { method, body: JSON.stringify(payload) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao salvar contato');
      await loadContacts(query, filters);
      fillForm(data);
      toast.success(form.id ? 'Contato atualizado' : 'Contato criado');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar contato');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedContact) return;
    const ok = await confirm({
      title: 'Excluir contato',
      message: `Tem certeza que deseja excluir o contato "${selectedContact.name}"?`,
      confirmText: 'Excluir',
      type: 'danger',
    });
    if (!ok) return;
    try {
      const res = await apiRequest(`/contacts/${selectedContact.id}`, { method: 'DELETE' });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao excluir contato');
      toast.success('Contato removido');
      setSelectedId(null);
      setForm(createEmptyForm());
      await loadContacts(query, filters);
    } catch (error) {
      toast.error(error.message || 'Falha ao excluir contato');
    }
  };

  // LGPD: localiza e apaga de vez os dados de um titular (contato, conversas,
  // mensagens, eventos e historico de disparos) neste tenant.
  const erasureTotal = Object.values(erasureState.preview?.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const closeErasureModal = () => setErasureState(createEmptyErasureState());
  const handleOpenErasure = (contact = null) => {
    const phone = contact?.primaryPhone || getContactWhatsAppPhones(contact)[0]?.number || contact?.phones?.[0]?.number || '';
    setErasureState({ ...createEmptyErasureState(), open: true, phone });
  };
  const updateErasureField = (key, value) => setErasureState((prev) => ({
    ...prev,
    [key]: value,
    // Mudou o titular: a previa anterior deixa de valer.
    ...(key === 'phone' || key === 'cpf' ? { preview: null, result: null, acknowledged: false } : {})
  }));

  const handleErasurePreview = async () => {
    const phone = erasureState.phone.trim();
    const cpf = erasureState.cpf.trim();
    if (!phone && !cpf) return toast.error('Informe o telefone ou o CPF do titular.');
    try {
      setErasureState((prev) => ({ ...prev, loading: true, preview: null, result: null }));
      const res = await apiRequest('/contacts/data-subject/preview', { method: 'POST', body: JSON.stringify({ phone, cpf }) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao localizar os dados');
      setErasureState((prev) => ({ ...prev, loading: false, preview: data }));
    } catch (error) {
      setErasureState((prev) => ({ ...prev, loading: false }));
      toast.error(error.message || 'Falha ao localizar os dados');
    }
  };

  const handleErasureSubmit = async () => {
    const counts = erasureState.preview?.counts || {};
    if (!erasureTotal) return toast.error('Nao ha dados para apagar.');
    if (erasureState.reason.trim().length < 3) return toast.error('Informe o motivo da exclusao.');
    if (!erasureState.acknowledged) return toast.error('Confirme que entende que a exclusao e permanente.');
    const ok = await confirm({
      title: 'Apagar dados do titular',
      message: `Isto apaga de forma permanente ${counts.contacts || 0} contato(s), ${counts.chats || 0} conversa(s) e ${counts.chatMessages || 0} mensagem(ns). Nao da para desfazer.`,
      confirmText: 'Apagar definitivamente',
      type: 'danger'
    });
    if (!ok) return;
    try {
      setErasureState((prev) => ({ ...prev, submitting: true }));
      const res = await apiRequest('/contacts/data-subject/erase', {
        method: 'POST',
        body: JSON.stringify({ phone: erasureState.phone.trim(), cpf: erasureState.cpf.trim(), reason: erasureState.reason.trim(), confirm: true })
      });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao apagar os dados');
      setErasureState((prev) => ({ ...prev, submitting: false, result: data?.deleted || {} }));
      toast.success('Dados do titular apagados');
      if (selectedContact && (erasureState.preview?.contacts || []).some((contact) => contact.id === selectedContact.id)) {
        setSelectedId(null);
        setForm(createEmptyForm());
      }
      await loadContacts(query, filters);
    } catch (error) {
      setErasureState((prev) => ({ ...prev, submitting: false }));
      toast.error(error.message || 'Falha ao apagar os dados');
    }
  };

  const handlePrepareOutreach = async (contact) => {
    fillForm(contact);
    const phones = getContactWhatsAppPhones(contact);
    setOutreachState({ ...createEmptyOutreachState(), open: true, loading: true, contact, phoneEntryId: phones[0]?.id || '' });
    try {
      const setup = await loadWhatsAppSetup();
      setOutreachState((prev) => ({ ...prev, loading: false, templates: setup.templates, senderOptions: setup.senderOptions, channelReady: setup.channelReady, senderPhoneNumberId: setup.defaultSender?.phoneNumberId || '', templateId: setup.defaultTemplate?.id || '', values: setup.defaultTemplate ? createValuesForTemplate(setup.defaultTemplate) : prev.values }));
    } catch (error) {
      console.error(error);
      closeOutreachModal();
      toast.error(error.message || 'Falha ao preparar atendimento ativo');
    }
  };

  const handlePrepareCampaign = async () => {
    if (selectedContactIds.length === 0) return toast.error('Selecione pelo menos um contato.');
    setCampaignState({ ...createEmptyCampaignState(), open: true, loading: true });
    try {
      const setup = await loadWhatsAppSetup();
      setCampaignState((prev) => ({ ...prev, loading: false, templates: setup.templates, senderOptions: setup.senderOptions, channelReady: setup.channelReady, senderPhoneNumberId: setup.defaultSender?.phoneNumberId || '', templateId: setup.defaultTemplate?.id || '', values: setup.defaultTemplate ? createValuesForTemplate(setup.defaultTemplate) : prev.values }));
    } catch (error) {
      console.error(error);
      closeCampaignModal();
      toast.error(error.message || 'Falha ao preparar disparo em massa');
    }
  };

  const handleOutreachTemplateChange = (templateId) => { const template = outreachState.templates.find((item) => item.id === templateId) || null; setOutreachState((prev) => ({ ...prev, templateId, values: template ? createValuesForTemplate(template) : createEmptyValues() })); };
  const handleCampaignTemplateChange = (templateId) => { const template = campaignState.templates.find((item) => item.id === templateId) || null; setCampaignState((prev) => ({ ...prev, templateId, values: template ? createValuesForTemplate(template) : createEmptyValues() })); };
  const updateOutreachArrayValue = (group, index, value) => setOutreachState((prev) => ({ ...prev, values: { ...prev.values, [group]: (Array.isArray(prev.values?.[group]) ? prev.values[group] : []).map((item, itemIndex) => (itemIndex === index ? value : item)) } }));
  const updateOutreachButtonValue = (buttonIndex, valueIndex, value) => setOutreachState((prev) => ({ ...prev, values: { ...prev.values, buttons: { ...(prev.values?.buttons || {}), [buttonIndex]: (Array.isArray(prev.values?.buttons?.[buttonIndex]) ? prev.values.buttons[buttonIndex] : []).map((item, itemIndex) => (itemIndex === valueIndex ? value : item)) } } }));
  const updateCampaignArrayValue = (group, index, value) => setCampaignState((prev) => ({ ...prev, values: { ...prev.values, [group]: (Array.isArray(prev.values?.[group]) ? prev.values[group] : []).map((item, itemIndex) => (itemIndex === index ? value : item)) } }));
  const updateCampaignButtonValue = (buttonIndex, valueIndex, value) => setCampaignState((prev) => ({ ...prev, values: { ...prev.values, buttons: { ...(prev.values?.buttons || {}), [buttonIndex]: (Array.isArray(prev.values?.buttons?.[buttonIndex]) ? prev.values.buttons[buttonIndex] : []).map((item, itemIndex) => (itemIndex === valueIndex ? value : item)) } } }));

  const handleSendOutreach = async () => {
    if (!outreachState.contact?.id) return toast.error('Selecione um contato.');
    if (!outreachState.phoneEntryId || !outreachState.templateId) return toast.error('Selecione numero e template.');
    try {
      setOutreachState((prev) => ({ ...prev, sending: true }));
      const res = await apiRequest(`/contacts/${outreachState.contact.id}/outreach`, { method: 'POST', body: JSON.stringify({ channel: 'whatsapp', phoneEntryId: outreachState.phoneEntryId, senderPhoneNumberId: outreachState.senderPhoneNumberId, templateId: outreachState.templateId, values: outreachState.values }) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao enviar template');
      toast.success('Template enviado. O atendimento ja esta em Meu Atendimento.');
      closeOutreachModal();
      await loadContacts(query, filters);
      await loadHistory(outreachState.contact.id);
      if (data?.chat?.id) {
        localStorage.setItem('pendingActiveChatId', data.chat.id);
        navigate('/agent', { state: { focusChatId: data.chat.id } });
      }
    } catch (error) {
      toast.error(error.message || 'Falha ao enviar template');
      setOutreachState((prev) => ({ ...prev, sending: false }));
    }
  };

  const handleSendCampaign = async () => {
    if (selectedContactIds.length === 0) return toast.error('Selecione pelo menos um contato.');
    if (selectedContactsWithWhatsApp.length === 0) return toast.error('Nenhum dos contatos selecionados possui WhatsApp.');
    if (!campaignState.templateId || !campaignState.senderPhoneNumberId) return toast.error('Selecione remetente e template.');
    try {
      setCampaignState((prev) => ({ ...prev, submitting: true }));
      const res = await apiRequest('/contacts/outreach/campaigns', { method: 'POST', body: JSON.stringify({ channel: 'whatsapp', contactIds: selectedContactIds, senderPhoneNumberId: campaignState.senderPhoneNumberId, templateId: campaignState.templateId, values: campaignState.values }) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao criar campanha');
      toast.success('Campanha criada. O backend vai processar os contatos em sequencia.');
      closeCampaignModal();
      setSelectedById({});
      await loadCampaigns();
      await loadContacts(query, filters);
    } catch (error) {
      toast.error(error.message || 'Falha ao criar campanha');
      setCampaignState((prev) => ({ ...prev, submitting: false }));
    }
  };

  const pageTitle = user?.role === 'AGENT' ? 'Atendimento ativo' : 'Contatos';

  return (
    <main className="agent-operational active-contacts content min-h-screen bg-gray-50 dark:bg-gray-900 p-3 sm:p-4 lg:p-6 flex flex-col gap-5 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-200 pb-4 dark:border-slate-800"><MessageCircleMore size={20} className="text-blue-600 dark:text-blue-400" /><h1 className="text-xl font-semibold text-gray-900 dark:text-white leading-tight">{pageTitle}</h1>{canEraseData && <button type="button" onClick={() => handleOpenErasure()} className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"><ShieldCheck size={14} /> Apagar dados de titular</button>}</div>
      <div className="agent-metric-strip grid grid-cols-1 bg-white dark:bg-gray-800 md:grid-cols-3">
        <div className="agent-metric-cell p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-2">Contatos</div><div className="text-2xl font-semibold text-gray-900 dark:text-white">{contactsMeta.total}</div></div>
        <div className="agent-metric-cell p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-2">Com WhatsApp</div><div className="text-2xl font-semibold text-blue-600 dark:text-blue-400">{contactsWithWhatsApp}</div></div>
        <div className="agent-metric-cell p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-2">Busca atual</div><div className="text-sm font-semibold text-gray-900 dark:text-white truncate">{query || 'Sem filtro'}</div></div>
      </div>
      {selectedContactIds.length > 0 && <section className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"><div><div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">{selectedContactIds.length} contato(s) selecionado(s)</div></div><div className="flex flex-wrap gap-2"><button type="button" onClick={handleSelectAllVisible} className="px-3 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-white/70 dark:bg-gray-900/30 text-sm font-semibold text-emerald-700 dark:text-emerald-300">Selecionar visiveis</button><button type="button" onClick={handleClearSelection} className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-600 dark:text-gray-300">Limpar selecao</button>{outreachEnabled && <button type="button" onClick={handlePrepareCampaign} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-colors"><Rocket size={16} /> Disparo em massa</button>}</div></section>}
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
        <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-200">Campanhas recentes</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Acompanhe o processamento dos disparos em massa em tempo real.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsRecentCampaignsCollapsed((prev) => !prev)}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-900 transition-colors inline-flex items-center gap-1.5"
            >
              <ChevronDown size={14} className={`transition-transform ${isRecentCampaignsCollapsed ? '' : 'rotate-180'}`} />
              {isRecentCampaignsCollapsed ? 'Expandir' : 'Recolher'}
            </button>
            <button
              type="button"
              onClick={() => loadCampaigns()}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-900 transition-colors"
            >
              Atualizar
            </button>
          </div>
        </div>
        {!isRecentCampaignsCollapsed && (
          <div className="p-4">
            {campaigns.loading && campaigns.items.length === 0 ? <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">{Array.from({ length: 3 }).map((_, index) => <SkeletonBox key={`campaign_skel_${index}`} className="h-36 w-full" />)}</div> : campaigns.items.length === 0 ? <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-sm text-gray-400 flex items-center gap-3"><Layers3 size={18} />Nenhuma campanha criada ainda.</div> : <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">{campaigns.items.map((campaign) => <article key={campaign.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-4 space-y-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{campaign.templateName || 'Campanha'}</h3><p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{campaign.senderLabel || campaign.senderPhoneNumberId || 'Remetente principal'}</p></div><span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium ${statusTone[String(campaign.status || '').toLowerCase()] || statusTone.pending}`}><Radio size={11} /> {formatStatusLabel(campaign.status)}</span></div><div className="space-y-2"><div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400"><span>{campaign.successCount || 0} sucesso</span><span>{campaign.failedCount || 0} falha</span><span>{campaign.totalContacts || 0} total</span></div><div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, Number(campaign.progressPercent || 0)))}%` }} /></div></div><div className="grid grid-cols-2 gap-3 text-xs text-gray-500 dark:text-gray-400"><div><div className="font-semibold text-gray-700 dark:text-gray-300">Criada</div><div>{formatDateTime(campaign.createdAt)}</div></div><div><div className="font-semibold text-gray-700 dark:text-gray-300">Atualizada</div><div>{formatDateTime(campaign.updatedAt)}</div></div></div>{Array.isArray(campaign.items) && campaign.items.some((item) => item.status === 'failed') && <div className="rounded-lg border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{campaign.items.filter((item) => item.status === 'failed').slice(0, 2).map((item) => <div key={`${campaign.id}_${item.contactId}`} className="truncate">{item.contactName}: {item.error || 'Falha ao enviar'}</div>)}</div>}</article>)}</div>}
          </div>
        )}
      </section>
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 flex-1 min-h-0">
        <section className="xl:col-span-5 min-h-0 flex flex-col bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3">
            <div className="flex gap-2"><div className="relative flex-1"><Search size={16} className="absolute left-3 top-3 text-gray-400" /><input className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" placeholder="Buscar por nome, telefone ou tag" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') handleSearch(); }} /></div><button type="button" onClick={handleSearch} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition-colors">Buscar</button></div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2"><label className="relative"><Filter size={14} className="absolute left-3 top-3 text-gray-400" /><select className="w-full pl-8 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={filters.channel} onChange={(event) => handleFilterChange('channel', event.target.value)}><option value="">Todos os canais</option><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="phone">Telefone</option></select></label><label className="relative"><Radio size={14} className="absolute left-3 top-3 text-gray-400" /><select className="w-full pl-8 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={filters.outreachStatus} onChange={(event) => handleFilterChange('outreachStatus', event.target.value)}><option value="">Todos os status</option><option value="sent">Enviado</option><option value="delivered">Entregue</option><option value="read">Lido</option><option value="failed">Falhou</option></select></label><button type="button" onClick={handleClearFilters} className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">Limpar filtros</button></div>
            {availableTags.length > 0 && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => handleFilterChange('tag', '')} className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${!filters.tag ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>Todas as tags</button>{availableTags.map((tag) => <button key={`filter_tag_${tag}`} type="button" onClick={() => handleFilterChange('tag', tag)} className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${filters.tag === tag ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>{tag}</button>)}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><button type="button" onClick={handleNewContact} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-sm font-semibold transition-colors"><Plus size={16} /> Novo contato</button><button type="button" onClick={handleSelectAllVisible} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-600 dark:text-gray-300 transition-colors"><CheckSquare size={16} /> Selecionar visiveis</button></div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
            {loading ? Array.from({ length: 6 }).map((_, index) => <div key={`contact_skel_${index}`} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/20 p-4"><SkeletonBox className="h-4 w-32" /><SkeletonBox className="h-3 w-24 mt-3" /><SkeletonBox className="h-3 w-full mt-2" /></div>) : contacts.length === 0 ? <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 py-12"><Users size={52} /><p>Nenhum contato cadastrado ainda.</p></div> : pagedContacts.map((contact) => { const isSelected = selectedId === contact.id; const isChecked = selectedContactIds.includes(contact.id); return <article key={contact.id} className={`rounded-xl border p-4 transition-colors cursor-pointer ${isSelected ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20' : 'border-gray-200 bg-gray-50 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-700/20 dark:hover:border-gray-600'}`} onClick={() => fillForm(contact)}><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex items-start gap-3"><button type="button" onClick={(event) => { event.stopPropagation(); toggleContactSelection(contact.id); }} className="mt-0.5 text-emerald-600 dark:text-emerald-400">{isChecked ? <CheckSquare size={18} /> : <Square size={18} />}</button><div className="min-w-0"><h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{contact.displayName || contact.agentDefinedName || contact.name || 'Sem nome'}</h3>{(() => { const channelName = contact.channelIdentities?.find((id) => id.channelDisplayName)?.channelDisplayName; const userName = contact.agentDefinedName; return channelName && userName && channelName !== userName ? <span className="text-[10px] text-gray-400 dark:text-gray-500 block truncate">Canal: {channelName}</span> : null; })()}<div className="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400">{contact.company && <span className="inline-flex items-center gap-1"><Building2 size={12} /> {contact.company}</span>}{contact.primaryPhone && <span className="inline-flex items-center gap-1"><Phone size={12} /> {contact.primaryPhone}</span>}</div>{(contact.lastTemplateName || contact.lastOutreachStatus) && <div className="mt-2 flex flex-wrap items-center gap-2">{contact.lastTemplateName && <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-[11px] font-medium text-gray-600 dark:text-gray-300"><Bot size={11} /> {contact.lastTemplateName}</span>}{contact.lastOutreachStatus && <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium ${statusTone[String(contact.lastOutreachStatus || '').toLowerCase()] || statusTone.pending}`}><Radio size={11} /> {formatStatusLabel(contact.lastOutreachStatus)}</span>}</div>}</div></div>{outreachEnabled && <button type="button" onClick={(event) => { event.stopPropagation(); handlePrepareOutreach(contact); }} className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors">Entrar em contato</button>}</div>{contact.tags?.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{contact.tags.map((tag) => <span key={`${contact.id}_${tag}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-[11px] font-medium text-gray-600 dark:text-gray-300"><Tags size={11} /> {tag}</span>)}</div>}</article>; })}
          </div>
          {!loading && contactsMeta.total > CONTACTS_PER_PAGE && (
            <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {((currentPage - 1) * CONTACTS_PER_PAGE) + 1}–{Math.min(currentPage * CONTACTS_PER_PAGE, contactsMeta.total)} de {contactsMeta.total}
              </span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Anterior</button>
                <span className="px-2 text-xs font-semibold text-gray-700 dark:text-gray-200">{currentPage} / {totalPages}</span>
                <button type="button" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Próxima</button>
              </div>
            </div>
          )}
        </section>
        <section className="xl:col-span-7 min-h-0 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between gap-3"><div><h2 className="text-sm font-bold uppercase tracking-wide text-gray-700 dark:text-gray-200">{form.id ? 'Editar contato' : 'Novo contato'}</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{form.id ? 'Atualize dados e canais para outreach futuro.' : 'Cadastre o contato para usar no atendimento ativo.'}</p></div>{selectedContact && <div className="flex items-center gap-2">{canModerateWhatsApp && getContactWhatsAppPhones(selectedContact).length > 0 && <button type="button" onClick={() => handlePrepareModeration(selectedContact)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"><Ban size={14} /> Bloqueio Meta</button>}{outreachEnabled && <button type="button" onClick={() => handlePrepareOutreach(selectedContact)} className="px-3 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">Entrar em contato</button>}{canEraseData && <button type="button" onClick={() => handleOpenErasure(selectedContact)} className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/30 text-red-700 dark:text-red-300 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">Apagar dados (LGPD)</button>}<button type="button" onClick={handleDelete} className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-300 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">Excluir</button></div>}</div>
          <div className="p-4 lg:p-6 overflow-y-auto custom-scrollbar h-full">
            <form onSubmit={handleSave} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Nome (definido por você)</label><div className="relative"><UserRound size={16} className="absolute left-3 top-3 text-gray-400" /><input className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Deixe vazio para usar o nome do canal" /></div>{selectedContact?.channelIdentities?.find((id) => id.channelDisplayName) && <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Nome no canal: {selectedContact.channelIdentities.find((id) => id.channelDisplayName).channelDisplayName} ({selectedContact.channelIdentities.find((id) => id.channelDisplayName).channel})</p>}</div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Empresa</label><div className="relative"><Building2 size={16} className="absolute left-3 top-3 text-gray-400" /><input className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={form.company} onChange={(event) => setForm((prev) => ({ ...prev, company: event.target.value }))} placeholder="Opcional" /></div></div></div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Email</label><div className="relative"><Mail size={16} className="absolute left-3 top-3 text-gray-400" /><input className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="Opcional" /></div></div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Tags</label><div className="relative"><Tags size={16} className="absolute left-3 top-3 text-gray-400" /><input className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={form.tagsInput} onChange={(event) => setForm((prev) => ({ ...prev, tagsInput: event.target.value }))} placeholder="vip, orcamento, lead" /></div></div></div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-4 space-y-4"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-gray-900 dark:text-white">Telefones e canais</h3><p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Deixe o WhatsApp principal primeiro para o disparo futuro.</p></div><button type="button" onClick={handleAddPhone} className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 transition-colors"><Plus size={14} className="inline mr-1" /> Adicionar</button></div><div className="space-y-3">{form.phones.map((phone, index) => <div key={phone.id} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start"><div className="md:col-span-3"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Rotulo</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={phone.label} onChange={(event) => updatePhone(phone.id, 'label', event.target.value)} placeholder={index === 0 ? 'Principal' : `Telefone ${index + 1}`} /></div><div className="md:col-span-3"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Canal</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={phone.channel} onChange={(event) => updatePhone(phone.id, 'channel', event.target.value)}><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="phone">Telefone</option></select></div><div className="md:col-span-4"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Numero</label><input className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={phone.number} onChange={(event) => updatePhone(phone.id, 'number', event.target.value)} placeholder="+55 11 99999-9999" /></div><div className="md:col-span-2"><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1 opacity-0">Remover</label><button type="button" onClick={() => handleRemovePhone(phone.id)} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-500 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 transition-colors"><X size={14} /> Remover</button></div></div>)}</div></div>
              <div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Observacoes</label><textarea className="w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none resize-none h-32 dark:text-white" value={form.notes} onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))} placeholder="Preferencias, contexto comercial, historico..." /></div>
              <div className="flex flex-wrap gap-3"><button type="submit" disabled={saving} className="px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors">{saving ? 'Salvando...' : form.id ? 'Salvar alteracoes' : 'Criar contato'}</button><button type="button" onClick={handleNewContact} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Limpar formulario</button></div>
            </form>
            <div className="mt-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-4 space-y-4"><div className="flex items-center gap-2"><Clock3 size={16} className="text-gray-400" /><div><h3 className="text-sm font-semibold text-gray-900 dark:text-white">Historico de disparos</h3><p className="text-xs text-gray-500 dark:text-gray-400">{selectedContact ? 'Ultimos templates enviados para este contato.' : 'Selecione um contato para ver o historico.'}</p></div></div>{!selectedContact ? <div className="text-sm text-gray-400">Nenhum contato selecionado.</div> : history.loading ? <div className="space-y-3">{Array.from({ length: 3 }).map((_, index) => <SkeletonBox key={`history_skel_${index}`} className="h-16 w-full" />)}</div> : history.items.length === 0 ? <div className="text-sm text-gray-400">Ainda nao ha disparos registrados para este contato.</div> : <div className="space-y-3">{history.items.map((item) => <div key={item.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="text-sm font-semibold text-gray-900 dark:text-white truncate">{item.templateName || 'Template enviado'}</div><div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{item.to || '-'}</div></div><span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium ${statusTone[String(item.status || '').toLowerCase()] || statusTone.pending}`}><Radio size={11} /> {formatStatusLabel(item.status)}</span></div><div className="mt-2 text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words">{item.previewText || 'Sem preview registrado.'}</div><div className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">{formatDateTime(item.updatedAt || item.createdAt)}</div></div>)}</div>}</div>
          </div>
        </section>
      </div>
      <OperationalModal
        open={moderationState.open}
        title="Controle de contato no WhatsApp"
        context="Meta"
        onClose={closeModerationModal}
        size="md"
        footer={(
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={closeModerationModal} className="border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-500 dark:border-slate-700 dark:text-slate-300">Fechar</button>
            <button type="button" onClick={handleToggleWhatsAppBlock} disabled={moderationState.loading || moderationState.submitting || !moderationState.statusChecked} className={`inline-flex items-center gap-2 border px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${moderationState.blocked ? 'border-blue-700 bg-blue-700 hover:bg-blue-800' : 'border-slate-900 bg-slate-900 hover:bg-slate-800 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950'}`}>
              {moderationState.submitting ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
              {moderationState.blocked ? 'Desbloquear na Meta' : 'Bloquear na Meta'}
            </button>
          </div>
        )}
      >
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          <div className="grid gap-5 p-5 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Numero do contato</span>
              <select value={moderationState.phoneEntryId} onChange={(event) => handleModerationSelection('phoneEntryId', event.target.value)} disabled={moderationState.loading || moderationState.submitting} className="w-full border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                {getContactWhatsAppPhones(moderationState.contact).map((phone) => <option key={getPhoneEntryKey(phone)} value={getPhoneEntryKey(phone)}>{phone.label || 'WhatsApp'} - {phone.number}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Numero empresarial</span>
              <select value={moderationState.senderPhoneNumberId} onChange={(event) => handleModerationSelection('senderPhoneNumberId', event.target.value)} disabled={moderationState.loading || moderationState.submitting} className="w-full border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                {moderationState.senderOptions.map((sender) => <option key={sender.phoneNumberId} value={sender.phoneNumberId}>{[sender.label, sender.displayNumber, sender.phoneNumberId].filter(Boolean).join(' - ')}</option>)}
              </select>
            </label>
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-[160px_1fr] sm:items-start">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Estado oficial</div>
            <div>
              {moderationState.loading ? <div className="inline-flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Consultando a Meta...</div> : moderationState.statusChecked ? <div className="space-y-2"><div className={`text-sm font-semibold ${moderationState.blocked ? 'text-slate-950 dark:text-white' : 'text-blue-700 dark:text-blue-400'}`}>{moderationState.blocked ? 'Contato bloqueado' : 'Contato liberado'}</div>{moderationState.waId && <div className="font-mono text-xs text-slate-500">WA ID {moderationState.waId}</div>}{!moderationState.statusComplete && <div className="text-xs text-slate-500">A lista da Meta e extensa; a acao continua disponivel e sera validada no envio.</div>}</div> : <div className="text-sm text-slate-500">Nao foi possivel confirmar o estado.</div>}
            </div>
          </div>
          <div className="grid gap-4 bg-slate-50 p-5 text-sm leading-6 text-slate-600 dark:bg-slate-950 dark:text-slate-400 sm:grid-cols-[160px_1fr]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Efeito</div>
            <p>O bloqueio e aplicado no numero empresarial selecionado. O contato deixa de enviar mensagens e a empresa tambem nao consegue iniciar mensagens para ele enquanto estiver bloqueado.</p>
          </div>
        </div>
      </OperationalModal>
      <OperationalModal
        open={erasureState.open}
        title="Apagar dados do titular"
        context="LGPD"
        onClose={closeErasureModal}
        size="md"
        footer={(
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={closeErasureModal} className="border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-500 dark:border-slate-700 dark:text-slate-300">{erasureState.result ? 'Fechar' : 'Cancelar'}</button>
            {!erasureState.result && (
              <button type="button" onClick={handleErasureSubmit} disabled={erasureState.submitting || !erasureTotal || erasureState.reason.trim().length < 3 || !erasureState.acknowledged} className="inline-flex items-center gap-2 border border-red-700 bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50">
                {erasureState.submitting ? <Loader2 size={15} className="animate-spin" /> : <AlertCircle size={15} />}
                Apagar definitivamente
              </button>
            )}
          </div>
        )}
      >
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          <div className="bg-red-50 p-5 text-sm leading-6 text-red-800 dark:bg-red-950/30 dark:text-red-200">
            Apaga de forma permanente, neste tenant, o contato, as conversas, as mensagens, os eventos e o historico de disparos do titular. Use para atender pedidos de eliminacao da LGPD. Nao da para desfazer.
          </div>
          <div className="grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Telefone</span>
              <input value={erasureState.phone} onChange={(event) => updateErasureField('phone', event.target.value)} disabled={erasureState.submitting || Boolean(erasureState.result)} placeholder="+55 11 99999-9999" className="w-full border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
            </label>
            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">CPF (opcional)</span>
              <input value={erasureState.cpf} onChange={(event) => updateErasureField('cpf', event.target.value)} disabled={erasureState.submitting || Boolean(erasureState.result)} placeholder="000.000.000-00" className="w-full border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
            </label>
            <button type="button" onClick={handleErasurePreview} disabled={erasureState.loading || erasureState.submitting || Boolean(erasureState.result)} className="inline-flex items-center justify-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">
              {erasureState.loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              Localizar
            </button>
          </div>
          {erasureState.preview && !erasureState.result && (
            <div className="space-y-4 p-5">
              {erasureTotal === 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">Nenhum dado encontrado para esse telefone ou CPF neste tenant.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[['contacts', 'Contatos'], ['chats', 'Conversas'], ['chatMessages', 'Mensagens'], ['chatEvents', 'Eventos']].map(([key, label]) => (
                      <div key={key} className="border border-slate-200 px-3 py-2 dark:border-slate-800">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
                        <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{erasureState.preview.counts?.[key] || 0}</div>
                      </div>
                    ))}
                  </div>
                  {erasureState.preview.contacts?.length > 0 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">Contato(s): {erasureState.preview.contacts.map((contact) => contact.name || 'Sem nome').join(', ')}</p>
                  )}
                  <label className="block">
                    <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Motivo (fica registrado na auditoria)</span>
                    <textarea value={erasureState.reason} onChange={(event) => updateErasureField('reason', event.target.value)} disabled={erasureState.submitting} rows={2} placeholder="Ex.: pedido do titular por e-mail em 14/09/2026" className="w-full resize-none border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                  </label>
                  <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input type="checkbox" checked={erasureState.acknowledged} onChange={(event) => updateErasureField('acknowledged', event.target.checked)} disabled={erasureState.submitting} className="mt-1" />
                    Entendo que a exclusao e permanente e nao pode ser desfeita.
                  </label>
                </>
              )}
            </div>
          )}
          {erasureState.result && (
            <div className="space-y-2 p-5 text-sm text-slate-700 dark:text-slate-300">
              <p className="font-semibold text-slate-900 dark:text-white">Dados apagados.</p>
              <p>{erasureState.result.contacts || 0} contato(s), {erasureState.result.chats || 0} conversa(s), {erasureState.result.chatMessages || 0} mensagem(ns), {erasureState.result.chatEvents || 0} evento(s) e {erasureState.result.outreachHistory || 0} registro(s) de disparo.</p>
            </div>
          )}
        </div>
      </OperationalModal>
      {outreachState.open && <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"><div className="w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl"><div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-gray-900 dark:text-white">Iniciar atendimento ativo</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{outreachState.contact?.name || 'Contato selecionado'} via template aprovado do WhatsApp.</p></div><button type="button" onClick={closeOutreachModal} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white dark:hover:bg-gray-800 transition-colors"><X size={18} /></button></div><div className="grid grid-cols-1 xl:grid-cols-12 gap-0 min-h-0 max-h-[calc(92vh-72px)]"><div className="xl:col-span-7 p-5 overflow-y-auto custom-scrollbar space-y-5"><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Canal</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value="whatsapp" disabled><option value="whatsapp">WhatsApp</option></select></div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Numero remetente</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={outreachState.senderPhoneNumberId} onChange={(event) => setOutreachState((prev) => ({ ...prev, senderPhoneNumberId: event.target.value }))}>{outreachState.senderOptions.length === 0 && <option value="">Nao configurado</option>}{outreachState.senderOptions.map((sender) => <option key={sender.id || sender.phoneNumberId} value={sender.phoneNumberId}>{[sender.label, sender.displayNumber, sender.phoneNumberId].filter(Boolean).join(' - ')}</option>)}</select></div></div><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Numero do contato</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={outreachState.phoneEntryId} onChange={(event) => setOutreachState((prev) => ({ ...prev, phoneEntryId: event.target.value }))}>{getContactWhatsAppPhones(outreachState.contact).map((phone) => <option key={phone.id} value={phone.id}>{(phone.label || 'Numero')} - {phone.number}</option>)}</select></div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Template aprovado</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={outreachState.templateId} onChange={(event) => handleOutreachTemplateChange(event.target.value)} disabled={outreachState.loading}>{outreachState.templates.length === 0 && <option value="">Nenhum template aprovado</option>}{outreachState.templates.map((template) => <option key={template.id} value={template.id}>{template.name} - {template.language}</option>)}</select></div></div>{!outreachState.channelReady && <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-3"><AlertCircle size={18} className="mt-0.5 shrink-0" /><div>Configure o canal WhatsApp com token, WABA e numero antes de enviar templates.</div></div>}{outreachState.loading ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, index) => <SkeletonBox key={`outreach_skel_${index}`} className="h-14 w-full" />)}</div> : !activeOutreachTemplate ? <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-4 py-6 text-sm text-gray-500 dark:text-gray-400">Nenhum template aprovado disponivel para este tenant.</div> : <TemplateInputFields inputDef={activeOutreachTemplateInputs} values={outreachState.values} onArrayChange={updateOutreachArrayValue} onButtonChange={updateOutreachButtonValue} onMediaChange={(value) => setOutreachState((prev) => ({ ...prev, values: { ...prev.values, headerMediaUrl: value } }))} />}</div><div className="xl:col-span-5 border-t xl:border-t-0 xl:border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-5 overflow-y-auto custom-scrollbar"><div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white mb-4"><ShieldCheck size={16} className="text-emerald-500" />Preview do envio</div><TemplatePreview template={activeOutreachTemplate} inputDef={activeOutreachTemplateInputs} values={outreachState.values} subtitle={`${outreachState.contact?.name || 'Contato'} • WhatsApp`} /><div className="mt-5 flex flex-wrap gap-3"><button type="button" onClick={handleSendOutreach} disabled={outreachState.sending || outreachState.loading || !outreachState.channelReady || !outreachState.senderPhoneNumberId || !outreachState.phoneEntryId || !activeOutreachTemplate} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors">{outreachState.sending ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}{outreachState.sending ? 'Enviando...' : 'Enviar template'}</button><button type="button" onClick={closeOutreachModal} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-900 transition-colors">Cancelar</button></div></div></div></div></div>}
      {campaignState.open && <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"><div className="w-full max-w-5xl max-h-[92vh] overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl"><div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/70 flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-gray-900 dark:text-white">Disparo em massa</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{selectedContactIds.length} contato(s) selecionado(s), {selectedContactsWithWhatsApp.length} elegivel(is) para WhatsApp.</p></div><button type="button" onClick={closeCampaignModal} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white dark:hover:bg-gray-800 transition-colors"><X size={18} /></button></div><div className="grid grid-cols-1 xl:grid-cols-12 gap-0 min-h-0 max-h-[calc(92vh-72px)]"><div className="xl:col-span-7 p-5 overflow-y-auto custom-scrollbar space-y-5"><div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-4 py-4 space-y-2"><div className="text-sm font-semibold text-gray-900 dark:text-white">Escopo da campanha</div><p className="text-xs text-gray-500 dark:text-gray-400">O sistema vai usar o primeiro numero de WhatsApp disponivel em cada contato. Contatos sem WhatsApp entram como falha e ficam registrados na campanha.</p><div className="flex flex-wrap gap-2 pt-1">{selectedContacts.slice(0, 8).map((contact) => <span key={`selected_contact_${contact.id}`} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-300">{contact.name}</span>)}{selectedContacts.length > 8 && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-300">+{selectedContacts.length - 8} restantes</span>}</div></div><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Canal</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value="whatsapp" disabled><option value="whatsapp">WhatsApp</option></select></div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Numero remetente</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={campaignState.senderPhoneNumberId} onChange={(event) => setCampaignState((prev) => ({ ...prev, senderPhoneNumberId: event.target.value }))}>{campaignState.senderOptions.length === 0 && <option value="">Nao configurado</option>}{campaignState.senderOptions.map((sender) => <option key={sender.id || sender.phoneNumberId} value={sender.phoneNumberId}>{[sender.label, sender.displayNumber, sender.phoneNumberId].filter(Boolean).join(' - ')}</option>)}</select></div></div><div><label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">Template aprovado</label><select className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm outline-none dark:text-white" value={campaignState.templateId} onChange={(event) => handleCampaignTemplateChange(event.target.value)} disabled={campaignState.loading}>{campaignState.templates.length === 0 && <option value="">Nenhum template aprovado</option>}{campaignState.templates.map((template) => <option key={template.id} value={template.id}>{template.name} - {template.language}</option>)}</select></div>{!campaignState.channelReady && <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-3"><AlertCircle size={18} className="mt-0.5 shrink-0" /><div>Configure o canal WhatsApp com token, WABA e numero antes de enviar templates.</div></div>}{campaignState.loading ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, index) => <SkeletonBox key={`campaign_modal_skel_${index}`} className="h-14 w-full" />)}</div> : !activeCampaignTemplate ? <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-4 py-6 text-sm text-gray-500 dark:text-gray-400">Nenhum template aprovado disponivel para este tenant.</div> : <TemplateInputFields inputDef={activeCampaignTemplateInputs} values={campaignState.values} onArrayChange={updateCampaignArrayValue} onButtonChange={updateCampaignButtonValue} onMediaChange={(value) => setCampaignState((prev) => ({ ...prev, values: { ...prev.values, headerMediaUrl: value } }))} />}</div><div className="xl:col-span-5 border-t xl:border-t-0 xl:border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-5 overflow-y-auto custom-scrollbar"><div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white mb-4"><ShieldCheck size={16} className="text-emerald-500" />Preview da campanha</div><TemplatePreview template={activeCampaignTemplate} inputDef={activeCampaignTemplateInputs} values={campaignState.values} subtitle={`${selectedContactsWithWhatsApp.length} contato(s) elegivel(is) via WhatsApp`} /><div className="mt-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-4 space-y-3"><div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"><Layers3 size={16} className="text-gray-400" />Resumo da execucao</div><div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-3"><div className="text-xs text-gray-500 dark:text-gray-400">Selecionados</div><div className="text-lg font-semibold text-gray-900 dark:text-white">{selectedContactIds.length}</div></div><div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-3"><div className="text-xs text-gray-500 dark:text-gray-400">Elegiveis</div><div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{selectedContactsWithWhatsApp.length}</div></div></div></div><div className="mt-5 flex flex-wrap gap-3"><button type="button" onClick={handleSendCampaign} disabled={campaignState.submitting || campaignState.loading || !campaignState.channelReady || !campaignState.senderPhoneNumberId || !activeCampaignTemplate || selectedContactsWithWhatsApp.length === 0} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors">{campaignState.submitting ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}{campaignState.submitting ? 'Criando campanha...' : 'Criar campanha'}</button><button type="button" onClick={closeCampaignModal} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-900 transition-colors">Cancelar</button></div></div></div></div></div>}
    </main>
  );
};

export default ActiveContacts;
