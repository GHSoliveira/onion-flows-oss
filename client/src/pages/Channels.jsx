import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiRequest } from '../services/api';
import { motion } from 'framer-motion';
import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, Clock3, Copy, Globe2, KeyRound, LockKeyhole, MessageSquare, Plus, Save, Settings2, ShieldCheck, Trash2, Workflow } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import OperationalModal from '../components/OperationalModal';
import { TableSkeleton } from '../components/LoadingSkeleton';

const defaultTelegram = {
  enabled: false,
  botToken: '',
  flowId: '',
  usePolling: true,
  webhookUrl: '',
  webhookSecret: ''
};

const defaultWhatsApp = {
  enabled: false,
  accessToken: '',
  phoneNumberId: '',
  senderNumbers: [],
  wabaId: '',
  flowId: '',
  webhookVerifyToken: '',
  appSecret: ''
};

const createSenderNumberDraft = (overrides = {}) => ({
  id: `wa_sender_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
  label: '',
  displayNumber: '',
  phoneNumberId: '',
  isDefault: false,
  enabled: true,
  ...overrides
});

const normalizeSenderNumbers = (items = [], legacyPhoneNumberId = '') => {
  const list = Array.isArray(items) ? items : [];
  const next = list
    .map((item, index) => ({
      id: item.id || `wa_sender_${Date.now()}_${index}`,
      label: item.label || '',
      displayNumber: item.displayNumber || '',
      phoneNumberId: item.phoneNumberId || '',
      flowId: item.flowId || '',
      routeUpdatedAt: item.routeUpdatedAt || null,
      routeUpdatedBy: item.routeUpdatedBy || null,
      isDefault: Boolean(item.isDefault),
      enabled: item.enabled !== false
    }))
    .filter((item) => item.phoneNumberId);

  if (legacyPhoneNumberId && !next.some((item) => item.phoneNumberId === legacyPhoneNumberId)) {
    next.unshift(createSenderNumberDraft({
      label: 'Principal',
      phoneNumberId: legacyPhoneNumberId,
      isDefault: true
    }));
  }

  if (next.length > 0 && !next.some((item) => item.isDefault)) {
    next[0].isDefault = true;
  }

  return next.map((item, index, array) => ({
    ...item,
    isDefault: item.isDefault || (index === 0 && !array.some((entry) => entry.isDefault))
  }));
};

const normalizeChannelPlatform = (value) => {
  const platform = String(value || '').trim().toLowerCase();
  if (platform.includes('whatsapp')) return 'whatsapp';
  if (platform.includes('telegram')) return 'telegram';
  if (platform === 'web') return 'web';
  return null;
};

const Channels = () => {
  const { tenant, loading: tenantLoading } = useTenant();
  const { confirm, prompt } = useDialog();
  const { tenantId: routeTenantId } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [telegram, setTelegram] = useState(defaultTelegram);
  const [whatsapp, setWhatsapp] = useState(defaultWhatsApp);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [webhookResult, setWebhookResult] = useState(null);
  const [flows, setFlows] = useState([]);
  const [savingRoute, setSavingRoute] = useState(null);
  const [showChannelConfig, setShowChannelConfig] = useState(false);
  const [channelPlatform, setChannelPlatform] = useState(null);
  const [technicalChannelEntry, setTechnicalChannelEntry] = useState(null);
  const [activeTab, setActiveTab] = useState('operation');
  const [channelEntries, setChannelEntries] = useState([]);
  const [channelSurface, setChannelSurface] = useState(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [createdChannelToken, setCreatedChannelToken] = useState(null);
  const [channelDraft, setChannelDraft] = useState({ name: '', seed: '', modificationPassword: '', platform: 'whatsapp' });
  const [detailFlowId, setDetailFlowId] = useState('');
  const [detailPassword, setDetailPassword] = useState('');
  const [deletingChannel, setDeletingChannel] = useState(false);
  const [wabaNumbers, setWabaNumbers] = useState([]);
  const [loadingNumbers, setLoadingNumbers] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [registerPin, setRegisterPin] = useState('');
  const [registeringNumber, setRegisteringNumber] = useState(false);
  const [businessProfile, setBusinessProfile] = useState(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const channelManagerTimerRef = useRef(null);

  const tenantId = routeTenantId || (tenant && tenant.id !== 'super_admin' ? tenant.id : null);
  const baseEndpoint = tenantId ? `/channels?tenantId=${tenantId}` : '/channels';
  const saveEndpoint = tenantId ? `/channels/telegram?tenantId=${tenantId}` : '/channels/telegram';
  const saveWhatsAppEndpoint = tenantId ? `/channels/whatsapp?tenantId=${tenantId}` : '/channels/whatsapp';
  const flowRoutingEndpoint = tenantId ? `/channels/flow-routing?tenantId=${tenantId}` : '/channels/flow-routing';
  const webhookEndpoint = tenantId ? `/channels/telegram/webhook?tenantId=${tenantId}` : '/channels/telegram/webhook';
  const phoneNumbersEndpoint = tenantId ? `/channels/whatsapp/phone-numbers?tenantId=${tenantId}` : '/channels/whatsapp/phone-numbers';
  const diagnosticsEndpoint = tenantId ? `/channels/whatsapp/diagnostics?tenantId=${tenantId}` : '/channels/whatsapp/diagnostics';
  const subscribeWebhookEndpoint = tenantId ? `/channels/whatsapp/subscribe-webhook?tenantId=${tenantId}` : '/channels/whatsapp/subscribe-webhook';
  const registerNumberEndpoint = tenantId ? `/channels/whatsapp/register-number?tenantId=${tenantId}` : '/channels/whatsapp/register-number';
  const businessProfileEndpoint = tenantId ? `/channels/whatsapp/business-profile?tenantId=${tenantId}` : '/channels/whatsapp/business-profile';

  const applyChannelConfig = (data = {}) => {
    setChannelEntries(Array.isArray(data.entries) ? data.entries : []);
    setTelegram({
      ...defaultTelegram,
      ...(data.telegram || {})
    });
    setWhatsapp({
      ...defaultWhatsApp,
      ...(data.whatsapp || {}),
      senderNumbers: normalizeSenderNumbers(data?.whatsapp?.senderNumbers, data?.whatsapp?.phoneNumberId || '')
    });
    const telegramUpdated = data?.telegram?.updatedAt ? new Date(data.telegram.updatedAt) : null;
    const whatsappUpdated = data?.whatsapp?.updatedAt ? new Date(data.whatsapp.updatedAt) : null;
    const latest = telegramUpdated && whatsappUpdated
      ? new Date(Math.max(telegramUpdated.getTime(), whatsappUpdated.getTime()))
      : (telegramUpdated || whatsappUpdated);
    setLastSavedAt(latest ? latest.toISOString() : null);
  };

  const loadConfig = async () => {
    try {
      setLoading(true);
      const res = await apiRequest(baseEndpoint);
      if (res && res.ok) {
        const data = await res.json();
        applyChannelConfig(data);
      }
      const flowsEndpoint = tenantId ? `/flows?limit=200&page=1&tenantId=${tenantId}` : '/flows?limit=200&page=1';
      const flowsRes = await apiRequest(flowsEndpoint);
      if (flowsRes && flowsRes.ok) {
        const flowsData = await flowsRes.json();
        setFlows(Array.isArray(flowsData) ? flowsData : (flowsData?.items || []));
      }
    } catch (error) {
      console.error('Erro ao carregar canais:', error);
      toast.error('Falha ao carregar canais');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveFlowRoute = async ({ channel, flowId, sender = null, entry = null, modificationPassword = '' }) => {
    if (!tenantId) {
      toast.error('Selecione um tenant antes de salvar.');
      return;
    }
    const routeKey = sender?.id ? `${channel}:${sender.id}` : channel;
    try {
      setSavingRoute(routeKey);
      const payload = {
        channel,
        flowId: flowId || ''
      };
      if (sender) {
        payload.senderId = sender.id;
        payload.senderPhoneNumberId = sender.phoneNumberId;
      }
      if (entry) payload.entryId = entry.id;
      if (modificationPassword) payload.modificationPassword = modificationPassword;
      const res = await apiRequest(flowRoutingEndpoint, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      if (res && res.ok) {
        const data = await res.json();
        applyChannelConfig(data);
        toast.success('Roteamento atualizado');
      } else {
        const data = res ? await res.json().catch(() => ({})) : {};
        toast.error(data?.error || 'Falha ao salvar roteamento');
      }
    } catch (error) {
      console.error('Erro ao salvar roteamento:', error);
      toast.error('Falha ao salvar roteamento');
    } finally {
      setSavingRoute(null);
    }
  };

  useEffect(() => {
    if (tenantLoading && !routeTenantId) return;
    if (!tenantId) return;
    loadConfig();
  }, [tenantId, tenantLoading, routeTenantId]);

  useEffect(() => () => {
    if (channelManagerTimerRef.current) clearTimeout(channelManagerTimerRef.current);
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      if (!tenantId) {
        toast.error('Selecione um tenant antes de salvar.');
        return;
      }
      const res = await apiRequest(saveEndpoint, {
        method: 'PUT',
        body: JSON.stringify({ ...telegram, entryId: technicalChannelEntry?.id || null })
      });
      if (res && res.ok) {
        const data = await res.json();
        applyChannelConfig(data);
        setLastSavedAt(data?.telegram?.updatedAt || null);
        toast.success('Canal Telegram atualizado');
      } else {
        toast.error('Falha ao salvar');
      }
    } catch (error) {
      console.error('Erro ao salvar canais:', error);
      toast.error('Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWhatsApp = async () => {
    try {
      setSaving(true);
      if (!tenantId) {
        toast.error('Selecione um tenant antes de salvar.');
        return;
      }
      const res = await apiRequest(saveWhatsAppEndpoint, {
        method: 'PUT',
        body: JSON.stringify({
          ...whatsapp,
          entryId: technicalChannelEntry?.id || null,
          senderNumbers: normalizeSenderNumbers(whatsapp.senderNumbers, whatsapp.phoneNumberId)
        })
      });
      if (res && res.ok) {
        const data = await res.json();
        applyChannelConfig(data);
        setLastSavedAt(data?.whatsapp?.updatedAt || null);
        toast.success('Canal WhatsApp atualizado');
      } else {
        toast.error('Falha ao salvar');
      }
    } catch (error) {
      console.error('Erro ao salvar WhatsApp:', error);
      toast.error('Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleAddSenderNumber = () => {
    setWhatsapp((prev) => ({
      ...prev,
      senderNumbers: [...normalizeSenderNumbers(prev.senderNumbers, prev.phoneNumberId), createSenderNumberDraft({
        label: `Remetente ${normalizeSenderNumbers(prev.senderNumbers, prev.phoneNumberId).length + 1}`
      })]
    }));
  };

  const handleUpdateSenderNumber = (id, key, value) => {
    setWhatsapp((prev) => ({
      ...prev,
      phoneNumberId: (() => {
        const current = (Array.isArray(prev.senderNumbers) ? prev.senderNumbers : []).find((item) => item.id === id) || null;
        if (key === 'isDefault' && value) {
          return current?.phoneNumberId || prev.phoneNumberId;
        }
        if (key === 'phoneNumberId' && current?.isDefault) {
          return value;
        }
        return prev.phoneNumberId;
      })(),
      senderNumbers: (Array.isArray(prev.senderNumbers) ? prev.senderNumbers : []).map((item) => {
        if (item.id !== id) return item;
        if (key === 'isDefault' && value) {
          return { ...item, [key]: true };
        }
        return { ...item, [key]: value };
      }).map((item) => (
        key === 'isDefault' && value ? { ...item, isDefault: item.id === id } : item
      ))
    }));
  };

  const handleRemoveSenderNumber = (id) => {
    setWhatsapp((prev) => {
      const current = (Array.isArray(prev.senderNumbers) ? prev.senderNumbers : []);
      const removed = current.find((item) => item.id === id) || null;
      const next = current.filter((item) => item.id !== id);
      const fallbackPhoneNumberId = removed?.phoneNumberId === prev.phoneNumberId
        ? (next.find((item) => item.isDefault)?.phoneNumberId || next[0]?.phoneNumberId || '')
        : prev.phoneNumberId;
      return {
        ...prev,
        phoneNumberId: fallbackPhoneNumberId,
        senderNumbers: normalizeSenderNumbers(next, fallbackPhoneNumberId)
      };
    });
  };

  // O numero padrao tambem precisa refletir no remetente marcado como default.
  const applyPhoneNumberId = (nextValue) => {
    setWhatsapp((prev) => ({
      ...prev,
      phoneNumberId: nextValue,
      senderNumbers: (Array.isArray(prev.senderNumbers) ? prev.senderNumbers : []).map((item) => (
        item.isDefault ? { ...item, phoneNumberId: nextValue } : item
      ))
    }));
  };

  const handleLoadNumbers = async () => {
    if (!whatsapp.wabaId) {
      toast.error('Informe o WABA ID para buscar os numeros.');
      return;
    }
    try {
      setLoadingNumbers(true);
      const res = await apiRequest(phoneNumbersEndpoint, {
        method: 'POST',
        body: JSON.stringify({ accessToken: whatsapp.accessToken, wabaId: whatsapp.wabaId })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao buscar numeros');
      const numbers = Array.isArray(data.numbers) ? data.numbers : [];
      setWabaNumbers(numbers);
      if (!numbers.length) toast.error('Nenhum numero encontrado nesta WABA.');
      else toast.success(`${numbers.length} numero(s) encontrado(s)`);
    } catch (error) {
      toast.error(error.message || 'Falha ao buscar numeros');
    } finally {
      setLoadingNumbers(false);
    }
  };

  const handleDiagnostics = async () => {
    try {
      setRunningDiagnostics(true);
      const res = await apiRequest(diagnosticsEndpoint);
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao diagnosticar canal');
      setDiagnostics(data);
    } catch (error) {
      toast.error(error.message || 'Falha ao diagnosticar canal');
    } finally {
      setRunningDiagnostics(false);
    }
  };

  const handleSubscribeWebhook = async () => {
    try {
      setRunningDiagnostics(true);
      const res = await apiRequest(subscribeWebhookEndpoint, { method: 'POST' });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao assinar webhook');
      toast.success('Webhook assinado na WABA');
      await handleDiagnostics();
    } catch (error) {
      toast.error(error.message || 'Falha ao assinar webhook');
    } finally {
      setRunningDiagnostics(false);
    }
  };

  const handleRegisterNumber = async () => {
    if (!/^\d{6}$/.test(registerPin)) {
      toast.error('O PIN precisa ter 6 digitos.');
      return;
    }
    try {
      setRegisteringNumber(true);
      const res = await apiRequest(registerNumberEndpoint, {
        method: 'POST',
        body: JSON.stringify({ pin: registerPin })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao registrar numero');
      toast.success('Numero registrado na Cloud API');
      setRegisterPin('');
      await handleDiagnostics();
    } catch (error) {
      toast.error(error.message || 'Falha ao registrar numero');
    } finally {
      setRegisteringNumber(false);
    }
  };

  const handleLoadProfile = async () => {
    try {
      setProfileBusy(true);
      const res = await apiRequest(businessProfileEndpoint);
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao carregar perfil');
      setBusinessProfile({ ...data, websites: (data.websites || []).join(', ') });
    } catch (error) {
      toast.error(error.message || 'Falha ao carregar perfil');
    } finally {
      setProfileBusy(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!businessProfile) return;
    try {
      setProfileBusy(true);
      const res = await apiRequest(businessProfileEndpoint, {
        method: 'PUT',
        body: JSON.stringify({
          about: businessProfile.about,
          description: businessProfile.description,
          email: businessProfile.email,
          address: businessProfile.address,
          websites: String(businessProfile.websites || '').split(',').map((s) => s.trim()).filter(Boolean)
        })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao salvar perfil');
      setBusinessProfile({ ...data.profile, websites: (data.profile?.websites || []).join(', ') });
      toast.success('Perfil atualizado no WhatsApp');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar perfil');
    } finally {
      setProfileBusy(false);
    }
  };

  const handleWebhook = async () => {
    if (!telegram.webhookUrl) {
      toast.error('Informe a Webhook URL.');
      return;
    }
    try {
      setSaving(true);
      const res = await apiRequest(webhookEndpoint, { method: 'POST' });
      if (res && res.ok) {
        const data = await res.json();
        setWebhookResult(data);
        toast.success('Webhook configurado');
      } else {
        toast.error('Falha ao configurar webhook');
      }
    } catch (error) {
      console.error(error);
      toast.error('Falha ao configurar webhook');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateChannel = async () => {
    if (!channelDraft.name.trim() || channelDraft.seed.trim().length < 8) {
      toast.error('Informe um nome e uma seed com ao menos 8 caracteres');
      return;
    }
    try {
      setCreatingChannel(true);
      const endpoint = tenantId ? `/channels/entries?tenantId=${tenantId}` : '/channels/entries';
      const res = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(channelDraft) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao criar canal');
      setChannelEntries((current) => [...current, data.channel]);
      setCreatedChannelToken(data);
      toast.success('Canal criado');
    } catch (error) {
      toast.error(error.message || 'Falha ao criar canal');
    } finally {
      setCreatingChannel(false);
    }
  };

  const openCreateChannel = () => {
    setChannelDraft({ name: '', seed: '', modificationPassword: '', platform: 'whatsapp' });
    setCreatedChannelToken(null);
    setChannelSurface({ type: 'create' });
  };

  const openChannelDetail = (item) => {
    setDetailFlowId(item?.flowId || '');
    setDetailPassword('');
    setChannelSurface({ type: 'detail', item });
  };

  const handleDeleteChannel = async (item, entry = null) => {
    const accepted = await confirm({
      title: 'Excluir canal',
      message: `Excluir ${item?.label || item?.name || 'este canal'} e remover seu roteamento?`,
      confirmText: 'Excluir canal',
      type: 'danger'
    });
    if (!accepted) return;

    let modificationPassword = detailPassword;
    if (entry?.modificationPasswordConfigured && !modificationPassword) {
      modificationPassword = await prompt({
        title: 'Senha de modificacao',
        message: 'Informe a senha configurada para excluir este canal.',
        placeholder: 'Senha',
        confirmText: 'Continuar'
      });
      if (!modificationPassword) return;
    }

    const channelId = entry?.id || item?.id;
    const endpoint = tenantId
      ? `/channels/entries/${encodeURIComponent(channelId)}?tenantId=${tenantId}`
      : `/channels/entries/${encodeURIComponent(channelId)}`;
    try {
      setDeletingChannel(true);
      const response = await apiRequest(endpoint, {
        method: 'DELETE',
        body: JSON.stringify({ modificationPassword })
      });
      const data = response ? await response.json().catch(() => ({})) : {};
      if (!response?.ok) {
        toast.error(data?.error || 'Falha ao excluir canal');
        return;
      }
      applyChannelConfig(data);
      setChannelSurface(null);
      setDetailPassword('');
      toast.success('Canal excluido');
    } catch (error) {
      console.error('Erro ao excluir canal:', error);
      toast.error('Falha ao excluir canal');
    } finally {
      setDeletingChannel(false);
    }
  };

  const channelRows = useMemo(() => {
    const generic = channelEntries.map((entry) => ({
      ...entry,
      detail: entry.platform === 'web' ? 'Integracao web' : `Canal ${entry.platform}`,
      configured: Boolean(entry.tokenConfigured),
      icon: entry.platform === 'web' ? Globe2 : (entry.platform === 'telegram' ? Bot : MessageSquare)
    }));
    const represented = new Set(generic.map((entry) => entry.platform));
    const legacy = [{
      id: 'whatsapp',
      platform: 'whatsapp',
      name: 'WhatsApp',
      detail: whatsapp.senderNumbers?.find((item) => item.isDefault)?.label || 'Canal principal',
      enabled: Boolean(whatsapp.enabled),
      configured: Boolean(whatsapp.accessToken && (whatsapp.phoneNumberId || whatsapp.senderNumbers?.length)),
      flowId: whatsapp.flowId,
      icon: MessageSquare
    },
    {
      id: 'telegram',
      platform: 'telegram',
      name: 'Telegram',
      detail: telegram.usePolling ? 'Recebimento por polling' : 'Recebimento por webhook',
      enabled: Boolean(telegram.enabled),
      configured: Boolean(telegram.botToken),
      flowId: telegram.flowId,
      icon: Bot
    }].filter((entry) => {
      if (represented.has(entry.platform)) return false;
      if (entry.platform === 'whatsapp') {
        return Boolean(whatsapp.accessToken || whatsapp.phoneNumberId || whatsapp.flowId || whatsapp.enabled || whatsapp.senderNumbers?.length);
      }
      return Boolean(telegram.botToken || telegram.flowId || telegram.enabled || telegram.webhookUrl);
    });
    return [...generic, ...legacy];
  }, [channelEntries, telegram, whatsapp]);

  const activeChannels = channelRows.filter((channel) => channel.enabled).length;
  const attentionCount = channelRows.filter((channel) => channel.enabled && !channel.configured).length;
  const routeCount = (telegram.flowId ? 1 : 0)
    + (whatsapp.flowId ? 1 : 0)
    + (whatsapp.senderNumbers || []).filter((item) => item.flowId).length
    + channelEntries.filter((entry) => entry.flowId).length;
  const flowName = (flowId, fallback = 'Fluxo publicado padrao') => (
    flows.find((flow) => flow.id === flowId)?.name || flowId || fallback
  );
  const routingRows = useMemo(() => {
    const rows = [];
    const represented = new Set(channelEntries.map((entry) => entry.platform));
    channelEntries.forEach((entry) => rows.push({
      id: `entry:${entry.id}`,
      channel: entry.platform,
      platform: entry.platform === 'web' ? 'Web' : (entry.platform === 'telegram' ? 'Telegram' : 'WhatsApp'),
      label: entry.name,
      identifier: entry.tokenHint || entry.id,
      flowId: entry.flowId || '',
      selectedFlowId: entry.flowId || '',
      enabled: entry.enabled,
      updatedAt: entry.routeUpdatedAt || entry.updatedAt || entry.createdAt,
      updatedBy: entry.routeUpdatedBy || entry.updatedBy || entry.createdBy,
      entry,
      activity: entry.activity || []
    }));
    const senders = Array.isArray(whatsapp.senderNumbers) ? whatsapp.senderNumbers : [];

    const hasLegacyWhatsapp = Boolean(whatsapp.accessToken || whatsapp.phoneNumberId || whatsapp.flowId || whatsapp.enabled || senders.length);
    const hasLegacyTelegram = Boolean(telegram.botToken || telegram.flowId || telegram.enabled || telegram.webhookUrl);

    if (!represented.has('whatsapp') && senders.length) {
      senders.forEach((sender) => rows.push({
        id: `whatsapp:${sender.id}`,
        channel: 'whatsapp',
        platform: 'WhatsApp',
        label: sender.label || sender.displayNumber || 'Canal WhatsApp',
        identifier: sender.displayNumber || sender.phoneNumberId || 'Identificador nao informado',
        flowId: sender.flowId || whatsapp.flowId || '',
        selectedFlowId: sender.flowId || '',
        inherited: !sender.flowId,
        enabled: whatsapp.enabled && sender.enabled !== false,
        updatedAt: sender.routeUpdatedAt || whatsapp.routeUpdatedAt || whatsapp.updatedAt || lastSavedAt,
        updatedBy: sender.routeUpdatedBy || whatsapp.routeUpdatedBy || null,
        sender
      }));
    } else if (!represented.has('whatsapp') && hasLegacyWhatsapp) {
      rows.push({
        id: 'whatsapp:default',
        channel: 'whatsapp',
        platform: 'WhatsApp',
        label: 'Canal principal',
        identifier: whatsapp.phoneNumberId || 'Numero nao configurado',
        flowId: whatsapp.flowId || '',
        selectedFlowId: whatsapp.flowId || '',
        enabled: whatsapp.enabled,
        updatedAt: whatsapp.routeUpdatedAt || whatsapp.updatedAt || lastSavedAt,
        updatedBy: whatsapp.routeUpdatedBy || null
      });
    }

    if (!represented.has('telegram') && hasLegacyTelegram) rows.push({
      id: 'telegram:default',
      channel: 'telegram',
      platform: 'Telegram',
      label: 'Bot Telegram',
      identifier: telegram.usePolling ? 'Polling ativo' : 'Webhook ativo',
      flowId: telegram.flowId || '',
      selectedFlowId: telegram.flowId || '',
      enabled: telegram.enabled,
      updatedAt: telegram.routeUpdatedAt || telegram.updatedAt || lastSavedAt,
      updatedBy: telegram.routeUpdatedBy || null
    });

    return rows;
  }, [channelEntries, lastSavedAt, telegram, whatsapp]);
  const formatRouteDate = (value) => value
    ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : 'sem registro';
  const routeActorLabel = (actor) => {
    if (!actor) return 'administracao';
    const role = actor.role === 'SUPER_ADMIN' ? 'super-admin' : actor.role?.toLowerCase();
    return actor.name ? `${actor.name}${role ? ` (${role})` : ''}` : (role || 'administracao');
  };
  const openChannelManager = (platform, entry = null) => {
    const normalizedPlatform = normalizeChannelPlatform(platform);
    if (!normalizedPlatform || normalizedPlatform === 'web') {
      toast.error('Configuracao tecnica indisponivel para este canal');
      return;
    }

    if (channelManagerTimerRef.current) clearTimeout(channelManagerTimerRef.current);
    setChannelSurface(null);
    setShowChannelConfig(false);
    channelManagerTimerRef.current = setTimeout(() => {
      setChannelPlatform(normalizedPlatform);
      setTechnicalChannelEntry(entry?.id ? entry : null);
      setShowChannelConfig(true);
      channelManagerTimerRef.current = null;
    }, 180);
  };

  return (
    <main className="content min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1440px]">
        <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Canais</h1>
        </header>

        <section className="mb-6 border-y border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800 lg:grid-cols-4">
            {[
              { label: 'Canais ativos', value: activeChannels, detail: `${channelRows.length} configurados`, icon: CheckCircle2, tone: 'text-blue-500' },
              { label: 'Rotas definidas', value: routeCount, detail: routeCount === 1 ? 'fluxo em operacao' : 'fluxos em operacao', icon: Workflow, tone: 'text-blue-500' },
              { label: 'Saude', value: attentionCount ? 'Atencao' : 'Estavel', detail: attentionCount ? `${attentionCount} pendencia(s)` : 'nenhuma pendencia', icon: attentionCount ? AlertTriangle : Activity, tone: attentionCount ? 'text-gray-500' : 'text-blue-500' },
              { label: 'Ultima alteracao', value: lastSavedAt ? new Date(lastSavedAt).toLocaleDateString('pt-BR') : '-', detail: lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'sem registro', icon: Settings2, tone: 'text-gray-400' }
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="min-w-0 px-3 py-4 first:pl-0 sm:px-5 lg:py-5">
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Icon size={14} className={item.tone} /> {item.label}</div>
                  <div className="mt-2 truncate text-xl font-semibold text-gray-950 dark:text-white">{item.value}</div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">{item.detail}</div>
                </div>
              );
            })}
          </div>
        </section>

        <nav className="mb-6 flex w-full gap-1 border-b border-gray-200 dark:border-gray-800" aria-label="Secoes de canais">
          {[
            { id: 'operation', label: 'Operacao' },
            { id: 'channels', label: 'Canais configurados' }
          ].map((tab) => (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={`relative px-3 pb-3 pt-1 text-sm font-medium transition-colors ${activeTab === tab.id ? 'text-gray-950 dark:text-white' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              {tab.label}
              {activeTab === tab.id && <motion.span layoutId="channel-active-tab" className="absolute inset-x-2 bottom-[-1px] h-0.5 bg-blue-500" />}
            </button>
          ))}
        </nav>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 flex-1 min-h-0">
        <div className="lg:col-span-12 flex flex-col gap-6">
          <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: activeTab === 'operation' ? 1 : 0, y: activeTab === 'operation' ? 0 : 6 }} className={activeTab === 'operation' ? 'block' : 'hidden'}>
            <h2 className="mb-4 text-base font-semibold text-gray-950 dark:text-white">Roteamento</h2>

            {loading ? (
              <div className="border-y border-gray-200 dark:border-gray-800"><TableSkeleton rows={4} cols={3} /></div>
            ) : routingRows.length === 0 ? (
              <div className="border-y border-gray-200 py-10 dark:border-gray-800">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Nenhum canal configurado.</div>
                <button type="button" onClick={openCreateChannel} className="mt-4 h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700">
                  Adicionar canal
                </button>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {routingRows.map((route, index) => {
                  return (
                    <div key={route.id} className={index ? 'border-t border-gray-100 dark:border-gray-700' : ''}>
                      <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(210px,1fr)_minmax(240px,1.2fr)_auto] sm:items-center sm:px-5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 shrink-0 ${route.enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                            <strong className="truncate text-sm font-semibold text-gray-950 dark:text-white">{route.label}</strong>
                          </div>
                          <div className="mt-1 truncate pl-3.5 text-xs text-gray-400">{route.identifier} · {route.platform}</div>
                        </div>

                        <div className="min-w-0 sm:border-l sm:border-gray-100 sm:pl-5 dark:sm:border-gray-700">
                          <div className="flex min-w-0 items-center gap-2 text-xs text-gray-400">
                            <span>Conectado a</span>
                            <ChevronRight size={12} className="shrink-0" />
                            <span className="truncate font-semibold text-gray-700 dark:text-gray-200">{flowName(route.flowId)}</span>
                            {route.inherited && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-400 dark:bg-gray-700">padrao</span>}
                          </div>
                          <div className="mt-1 text-[11px] text-gray-400">Alterado em {formatRouteDate(route.updatedAt)} por {routeActorLabel(route.updatedBy)}</div>
                        </div>

                        <button type="button" onClick={() => openChannelDetail(route)} className="inline-flex h-8 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-gray-200 px-3 text-xs font-semibold text-gray-500 transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white sm:justify-self-end">
                          Detalhes <ChevronRight size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.section>

          <OperationalModal
            open={showChannelConfig}
            onClose={() => {
              setShowChannelConfig(false);
              setChannelPlatform(null);
              setTechnicalChannelEntry(null);
            }}
            size="lg"
            title={channelPlatform === 'whatsapp' ? 'WhatsApp Cloud API' : 'Telegram Bot'}
          >
                {channelPlatform && (
                  <div className="overflow-y-auto p-4 sm:p-6">
                    {channelPlatform === 'telegram' && (
          <div className="bg-white p-4 dark:bg-gray-800 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6 pb-4 border-b border-gray-100 dark:border-gray-700">
              <div className="border border-blue-200 bg-blue-50 p-2 text-blue-600 dark:border-blue-900 dark:bg-blue-900/30 dark:text-blue-400">
                <Bot size={18} />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Telegram</h2>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-blue-600"
                  checked={telegram.enabled}
                  onChange={(e) => setTelegram({ ...telegram, enabled: e.target.checked })}
                />
                Ativo
              </label>
            </div>

            {loading ? (
              <div className="text-sm text-gray-400">Carregando...</div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Bot Token</label>
                  <input
                    type="password"
                    className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                    value={telegram.botToken || ''}
                    onChange={(e) => setTelegram({ ...telegram, botToken: e.target.value })}
                    placeholder="123456:ABC..."
                  />
                </div>

                <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-blue-600"
                        checked={telegram.usePolling}
                        onChange={(e) => setTelegram({ ...telegram, usePolling: e.target.checked })}
                      />
                      Usar Polling
                    </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                      Webhook URL (opcional)
                    </label>
                    <input
                      className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                      value={telegram.webhookUrl || ''}
                      onChange={(e) => setTelegram({ ...telegram, webhookUrl: e.target.value })}
                      placeholder="https://..."
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                      Webhook Secret
                    </label>
                    <input
                      className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                      value={telegram.webhookSecret || ''}
                      onChange={(e) => setTelegram({ ...telegram, webhookSecret: e.target.value })}
                      placeholder="segredo opcional"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <span className="text-[10px] text-gray-400">Webhook aplica no bot configurado acima.</span>
                  <button
                    type="button"
                    onClick={handleWebhook}
                    className="border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    Ativar Webhook
                  </button>
                </div>
                {webhookResult && (
                  <div className="text-[11px] text-gray-500">
                    {webhookResult.ok ? 'Webhook configurado.' : 'Falha ao configurar webhook.'}
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
              >
                <Save size={16} />
                {saving ? 'Salvando...' : 'Salvar Telegram'}
              </button>
            </div>
          </div>

                    )}
                    {channelPlatform === 'whatsapp' && (
          <div className="bg-white p-4 dark:bg-gray-800 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6 pb-4 border-b border-gray-100 dark:border-gray-700">
              <div className="border border-blue-200 bg-blue-50 p-2 text-blue-600 dark:border-blue-900 dark:bg-blue-900/30 dark:text-blue-400">
                <MessageSquare size={18} />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">WhatsApp</h2>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-blue-600"
                  checked={whatsapp.enabled}
                  onChange={(e) => setWhatsapp({ ...whatsapp, enabled: e.target.checked })}
                />
                Ativo
              </label>
            </div>

            {loading ? (
              <div className="text-sm text-gray-400">Carregando...</div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Access Token</label>
                  <input
                    type="password"
                    className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                    value={whatsapp.accessToken || ''}
                    onChange={(e) => setWhatsapp({ ...whatsapp, accessToken: e.target.value })}
                    placeholder="EAAG..."
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Phone Number ID padrao</label>
                      <button
                        type="button"
                        onClick={handleLoadNumbers}
                        disabled={loadingNumbers}
                        className="text-[11px] font-semibold text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                      >
                        {loadingNumbers ? 'Buscando...' : 'Buscar da WABA'}
                      </button>
                    </div>
                    {wabaNumbers.length ? (
                      <select
                        className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                        value={whatsapp.phoneNumberId || ''}
                        onChange={(e) => applyPhoneNumberId(e.target.value)}
                      >
                        <option value="">Selecione um numero...</option>
                        {wabaNumbers.map((item) => (
                          <option key={item.phoneNumberId} value={item.phoneNumberId}>
                            {[item.displayPhoneNumber, item.verifiedName].filter(Boolean).join(' - ') || item.phoneNumberId}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                        value={whatsapp.phoneNumberId || ''}
                        onChange={(e) => applyPhoneNumberId(e.target.value)}
                        placeholder="1234567890"
                      />
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">WABA ID (obrigatorio para templates)</label>
                    <input
                      className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                      value={whatsapp.wabaId || ''}
                      onChange={(e) => setWhatsapp({ ...whatsapp, wabaId: e.target.value })}
                      placeholder="9876543210"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Webhook Verify Token</label>
                    <input
                      className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                      value={whatsapp.webhookVerifyToken || ''}
                      onChange={(e) => setWhatsapp({ ...whatsapp, webhookVerifyToken: e.target.value })}
                      placeholder="defina_no_meta"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">App Secret (opcional)</label>
                    <input
                      type="password"
                      className="mt-2 w-full border border-gray-300 bg-gray-50 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-600 dark:bg-gray-700"
                      value={whatsapp.appSecret || ''}
                      onChange={(e) => setWhatsapp({ ...whatsapp, appSecret: e.target.value })}
                      placeholder="app_secret"
                    />
                  </div>
                </div>

                <div className="space-y-3 border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Diagnostico do canal</h3>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Confere token, assinatura do webhook, qualidade e limite de envio direto na Meta.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDiagnostics}
                      disabled={runningDiagnostics}
                      className="shrink-0 border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
                    >
                      {runningDiagnostics ? 'Verificando...' : 'Verificar'}
                    </button>
                  </div>

                  {diagnostics ? (
                    <ul className="space-y-1.5">
                      {(diagnostics.checks || []).map((check) => (
                        <li key={check.key} className="flex items-start gap-2 text-xs">
                          <span
                            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                              check.status === 'ok' ? 'bg-emerald-500'
                                : check.status === 'warn' ? 'bg-amber-500'
                                  : check.status === 'missing' ? 'bg-gray-400' : 'bg-red-500'
                            }`}
                          />
                          <span className="min-w-0">
                            <span className="font-semibold text-gray-800 dark:text-gray-100">{check.label}: </span>
                            <span className="text-gray-600 dark:text-gray-400">{check.detail}</span>
                            {check.action === 'subscribe' ? (
                              <button
                                type="button"
                                onClick={handleSubscribeWebhook}
                                disabled={runningDiagnostics}
                                className="ml-2 font-semibold text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                              >
                                assinar agora
                              </button>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="space-y-3 border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Registrar numero na Cloud API</h3>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Passo unico por numero. Use o PIN de verificacao em duas etapas definido na Meta.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      inputMode="numeric"
                      maxLength={6}
                      className="w-32 border border-gray-300 bg-white px-3 py-2 text-sm tracking-widest outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700"
                      value={registerPin}
                      onChange={(e) => setRegisterPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                    />
                    <button
                      type="button"
                      onClick={handleRegisterNumber}
                      disabled={registeringNumber || registerPin.length !== 6}
                      className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
                    >
                      {registeringNumber ? 'Registrando...' : 'Registrar'}
                    </button>
                  </div>
                </div>

                <div className="space-y-3 border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Perfil do negocio</h3>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        O que o cliente ve ao abrir o contato no WhatsApp.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleLoadProfile}
                      disabled={profileBusy}
                      className="shrink-0 border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
                    >
                      {profileBusy ? 'Carregando...' : (businessProfile ? 'Recarregar' : 'Carregar')}
                    </button>
                  </div>

                  {businessProfile ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {[
                          ['about', 'Recado (about)', 'Atendimento 24h'],
                          ['email', 'Email', 'contato@empresa.com'],
                          ['address', 'Endereco', 'Rua, numero, cidade'],
                          ['websites', 'Sites (separe por virgula)', 'https://site.com']
                        ].map(([key, label, placeholder]) => (
                          <div key={key}>
                            <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">{label}</label>
                            <input
                              className="mt-1 w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700"
                              value={businessProfile[key] || ''}
                              onChange={(e) => setBusinessProfile({ ...businessProfile, [key]: e.target.value })}
                              placeholder={placeholder}
                            />
                          </div>
                        ))}
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Descricao</label>
                        <textarea
                          rows={2}
                          className="mt-1 w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700"
                          value={businessProfile.description || ''}
                          onChange={(e) => setBusinessProfile({ ...businessProfile, description: e.target.value })}
                          placeholder="O que o negocio faz"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={handleSaveProfile}
                          disabled={profileBusy}
                          className="bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                        >
                          {profileBusy ? 'Salvando...' : 'Salvar perfil'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-4 border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Numeros remetentes</h3>
                    </div>
                    <button
                      type="button"
                      onClick={handleAddSenderNumber}
                      className="inline-flex items-center gap-2 border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-600 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-gray-700 dark:text-gray-300 dark:hover:text-blue-300"
                    >
                      <Plus size={14} /> Adicionar
                    </button>
                  </div>

                  <div className="space-y-3">
                    {(Array.isArray(whatsapp.senderNumbers) ? whatsapp.senderNumbers : []).length === 0 ? (
                      <div className="border border-dashed border-gray-300 px-4 py-4 text-xs text-gray-400 dark:border-gray-600">
                        Nenhum remetente adicional configurado. O numero padrao acima ainda sera usado.
                      </div>
                    ) : (
                      (Array.isArray(whatsapp.senderNumbers) ? whatsapp.senderNumbers : []).map((sender) => (
                        <div key={sender.id} className="grid grid-cols-1 items-start gap-3 border-t border-gray-200 bg-white px-3 py-3 first:border-t-0 dark:border-gray-700 dark:bg-gray-800 md:grid-cols-12">
                          <div className="md:col-span-3">
                            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Rotulo</label>
                            <input
                              className="w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                              value={sender.label || ''}
                              onChange={(event) => handleUpdateSenderNumber(sender.id, 'label', event.target.value)}
                              placeholder="Principal"
                            />
                          </div>
                          <div className="md:col-span-3">
                            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Numero exibido</label>
                            <input
                              className="w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                              value={sender.displayNumber || ''}
                              onChange={(event) => handleUpdateSenderNumber(sender.id, 'displayNumber', event.target.value)}
                              placeholder="+55 11 99999-9999"
                            />
                          </div>
                          <div className="md:col-span-3">
                            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Phone Number ID</label>
                            <input
                              className="w-full border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                              value={sender.phoneNumberId || ''}
                              onChange={(event) => handleUpdateSenderNumber(sender.id, 'phoneNumberId', event.target.value)}
                              placeholder="1234567890"
                            />
                          </div>
                          <div className="md:col-span-3">
                            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Acoes</label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleUpdateSenderNumber(sender.id, 'isDefault', true)}
                                className={`flex-1 border px-3 py-2 text-xs font-semibold transition-colors ${
                                  sender.isDefault
                                    ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300'
                                    : 'border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900'
                                }`}
                              >
                                {sender.isDefault ? 'Padrao' : 'Tornar padrao'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveSenderNumber(sender.id)}
                                className="border border-gray-300 px-3 py-2 text-gray-500 transition-colors hover:border-blue-400 hover:text-blue-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-blue-300"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleSaveWhatsApp}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
              >
                <Save size={16} />
                {saving ? 'Salvando...' : 'Salvar WhatsApp'}
              </button>
            </div>
          </div>
                    )}
                  </div>
                )}
          </OperationalModal>
        </div>

        <div className="lg:col-span-12 flex flex-col gap-6">
          <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: activeTab === 'channels' ? 1 : 0, y: activeTab === 'channels' ? 0 : 6 }} className={activeTab === 'channels' ? 'block' : 'hidden'}>
            <div className="mb-3 flex items-end justify-between gap-4">
              <h2 className="text-base font-semibold text-gray-950 dark:text-white">Canais configurados</h2>
              <button type="button" onClick={openCreateChannel} className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-600 shadow-sm transition hover:border-gray-300 hover:text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"><Plus size={14} /> Adicionar canal</button>
            </div>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              {channelRows.map((channel, index) => {
                const Icon = channel.icon;
                return (
                  <button key={channel.id} type="button" onClick={() => openChannelDetail(channel)} className={`group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-900/40 sm:grid-cols-[auto_minmax(180px,1fr)_minmax(190px,1fr)_auto] ${index ? 'border-t border-gray-100 dark:border-gray-700' : ''}`}>
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300"><Icon size={17} /></span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-sm font-semibold text-gray-950 dark:text-white">{channel.name}</strong>
                        <span className={`h-1.5 w-1.5 ${channel.enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                      </span>
                      <span className="mt-1 block truncate text-xs text-gray-400">{channel.detail}</span>
                    </span>
                    <span className="hidden min-w-0 sm:block">
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400">Fluxo atual</span>
                      <span className="mt-1 block truncate text-xs font-medium text-gray-600 dark:text-gray-300">{flowName(channel.flowId)}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className={`hidden border-l px-2 py-1 text-[10px] font-semibold sm:inline-flex ${channel.enabled ? 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300' : 'border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400'}`}>{channel.enabled ? 'Ativo' : 'Inativo'}</span>
                      <ChevronRight size={16} className="text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-600 dark:group-hover:text-gray-200" />
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.section>

          <div className="hidden bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Outros canais</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Estrutura pronta para adicionar Instagram e outros canais.
            </p>
            <div className="mt-4 text-xs text-gray-400">
              Em breve.
            </div>
          </div>
        </div>
      </div>

      <OperationalModal
        open={Boolean(channelSurface)}
        onClose={() => setChannelSurface(null)}
        size="xl"
        title={channelSurface?.type === 'create' ? 'Adicionar canal' : (channelSurface?.item?.label || channelSurface?.item?.name || 'Detalhes do canal')}
        bodyClassName="bg-slate-100 dark:bg-slate-950"
      >
        {channelSurface && (
            channelSurface.type === 'create' ? (
              <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
                {!createdChannelToken ? (
                  <>
                    <div>
                      <div className="space-y-6">
                        <label className="block">
                          <span className="mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300">Nome do canal</span>
                          <input value={channelDraft.name} onChange={(event) => setChannelDraft((current) => ({ ...current, name: event.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="Ex: Atendimento principal" />
                        </label>

                        <div>
                          <span className="mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300">Plataforma</span>
                          <div className="relative">
                            <span className="pointer-events-none absolute inset-y-0 left-0 grid w-11 place-items-center border-r border-gray-100 text-gray-400 dark:border-gray-800">
                              {channelDraft.platform === 'web' ? <Globe2 size={17} /> : channelDraft.platform === 'telegram' ? <Bot size={17} /> : <MessageSquare size={17} />}
                            </span>
                            <select value={channelDraft.platform} onChange={(event) => setChannelDraft((current) => ({ ...current, platform: event.target.value }))} className="h-11 w-full appearance-none border border-gray-200 bg-white pl-14 pr-10 text-sm font-medium text-gray-700 outline-none transition hover:border-gray-300 focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white">
                              <option value="web">Web</option>
                              <option value="whatsapp">WhatsApp</option>
                              <option value="telegram">Telegram</option>
                            </select>
                            <ChevronRight size={15} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rotate-90 text-gray-400" />
                          </div>
                        </div>

                        <label className="block">
                          <span className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300"><KeyRound size={14} /> Seed de geracao</span>
                          <input type="password" value={channelDraft.seed} onChange={(event) => setChannelDraft((current) => ({ ...current, seed: event.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="Minimo de 8 caracteres" />
                        </label>

                        <label className="block">
                          <span className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300"><LockKeyhole size={14} /> Senha para modificacoes <span className="font-normal text-gray-400">opcional</span></span>
                          <input type="password" value={channelDraft.modificationPassword} onChange={(event) => setChannelDraft((current) => ({ ...current, modificationPassword: event.target.value }))} className="h-11 w-full border border-gray-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white" placeholder="Deixe vazio para nao exigir senha adicional" />
                        </label>

                        <button type="button" onClick={handleCreateChannel} disabled={creatingChannel} className="h-11 bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">{creatingChannel ? 'Criando identidade...' : 'Criar canal seguro'}</button>
                      </div>

                    </div>
                  </>
                ) : (
                  <div className="mx-auto max-w-2xl py-10">
                    <div className="grid h-12 w-12 place-items-center border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300"><CheckCircle2 size={22} /></div>
                    <h2 className="mt-6 text-2xl font-semibold text-gray-950 dark:text-white">Canal criado com seguranca</h2>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Copie o token agora. Ele nao sera mostrado novamente.</p>
                    <div className="mt-6 flex items-center gap-3 border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/50 dark:bg-blue-950/40">
                      <code className="min-w-0 flex-1 break-all text-xs text-blue-900 dark:text-blue-200">{createdChannelToken.token}</code>
                      <button type="button" onClick={() => navigator.clipboard.writeText(createdChannelToken.token).then(() => toast.success('Token copiado'))} className="grid h-9 w-9 shrink-0 place-items-center border border-blue-200 bg-white text-blue-700 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-300"><Copy size={15} /></button>
                    </div>
                    <div className="mt-8 flex flex-wrap gap-3">
                      {createdChannelToken.channel.platform !== 'web' && <button type="button" onClick={() => openChannelManager(createdChannelToken.channel.platform, createdChannelToken.channel)} className="h-10 rounded-lg bg-gray-950 px-4 text-sm font-semibold text-white dark:bg-white dark:text-gray-950">Continuar configuracao</button>}
                      <button type="button" onClick={() => setChannelSurface(null)} className="h-10 rounded-lg border border-gray-200 px-4 text-sm font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300">Concluir depois</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (() => {
              const item = channelSurface.item || {};
              const entry = item.entry || (String(item.id || '').startsWith('channel_') ? item : null);
              const platform = normalizeChannelPlatform(entry?.platform || item.channel || item.platform) || 'web';
              const activity = entry?.activity || item.activity || [];
              const saveKey = item.sender?.id ? `whatsapp:${item.sender.id}` : platform;
              return (
                <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
                  <div className="flex flex-col gap-5 border-b border-gray-200 pb-8 dark:border-gray-800 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-400"><span className={`h-2 w-2 ${item.enabled ? 'bg-blue-600' : 'bg-gray-300'}`} /> {item.enabled ? 'Operacional' : (entry?.status === 'draft' ? 'Configuracao pendente' : 'Inativo')}</div>
                      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-gray-950 dark:text-white">{item.label || item.name || entry?.name || 'Canal'}</h2>
                      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{item.identifier || item.tokenHint || entry?.tokenHint || item.detail || 'Identificador nao informado'} · {String(platform).toUpperCase()}</p>
                    </div>
                    {platform !== 'web' && <button type="button" onClick={() => openChannelManager(platform, entry)} className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-500 transition hover:text-gray-950 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-white">Configuracao tecnica</button>}
                  </div>

                  <div className="grid gap-10 py-8 lg:grid-cols-[1.4fr_0.8fr]">
                    <div className="space-y-8">
                      <section>
                        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Conexao atual</h3>
                        <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 dark:border-gray-700 dark:bg-gray-700 sm:grid-cols-3">
                          {[
                            ['Plataforma', String(platform).toUpperCase()],
                            ['Fluxo', flowName(detailFlowId || item.flowId)],
                            ['Token de acesso', entry?.tokenHint || item.tokenHint || 'Canal legado']
                          ].map(([label, value]) => <div key={label} className="bg-white p-4 dark:bg-gray-900"><span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</span><strong className="mt-2 block truncate text-sm text-gray-800 dark:text-gray-100">{value}</strong></div>)}
                        </div>
                      </section>

                      <section>
                        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Movimentacao</h3>
                        <div className="mt-4 border-l border-gray-200 pl-5 dark:border-gray-700">
                          {(activity.length ? [...activity].reverse() : [{ id: 'legacy', label: 'Canal carregado da configuracao legada', at: item.updatedAt, actor: item.updatedBy }]).map((event) => <div key={event.id} className="relative pb-6 last:pb-0"><span className="absolute -left-[24px] top-1 h-2 w-2 bg-blue-500 ring-4 ring-gray-50 dark:ring-gray-950" /><strong className="block text-sm font-medium text-gray-800 dark:text-gray-100">{event.label}</strong><span className="mt-1 block text-xs text-gray-400">{formatRouteDate(event.at)} · {routeActorLabel(event.actor)}</span></div>)}
                        </div>
                      </section>

                      <details className="group rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-sm font-semibold text-gray-700 dark:text-gray-200">Editar roteamento <ChevronRight size={15} className="transition group-open:rotate-90" /></summary>
                        <div className="grid gap-3 border-t border-gray-100 p-4 dark:border-gray-800 sm:grid-cols-[1fr_auto] sm:items-end">
                          <label><span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-400">Fluxo conectado</span><select value={detailFlowId} onChange={(event) => setDetailFlowId(event.target.value)} className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"><option value="">Fluxo publicado padrao</option>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name || flow.id}</option>)}</select></label>
                          {entry?.modificationPasswordConfigured && <label className="sm:col-span-2"><span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-400">Senha de modificacao</span><input type="password" value={detailPassword} onChange={(event) => setDetailPassword(event.target.value)} className="h-10 w-full border border-gray-200 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" placeholder="Exigida para salvar alteracoes" /></label>}
                          <button type="button" onClick={() => handleSaveFlowRoute({ channel: platform, flowId: detailFlowId, sender: item.sender || null, entry, modificationPassword: detailPassword })} disabled={savingRoute === saveKey} className="h-10 rounded-lg bg-gray-950 px-4 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-gray-950">{savingRoute === saveKey ? 'Salvando...' : 'Salvar roteamento'}</button>
                        </div>
                      </details>
                    </div>

                    <aside className="space-y-6">
                      <section className="border-t border-gray-200 pt-5 dark:border-gray-800"><div className="flex items-center gap-2 text-xs font-semibold text-gray-700 dark:text-gray-200"><ShieldCheck size={15} className="text-blue-600 dark:text-blue-400" /> Seguranca</div><dl className="mt-4 space-y-3 text-xs"><div className="flex justify-between gap-4"><dt className="text-gray-400">Token exclusivo</dt><dd className="font-medium text-gray-700 dark:text-gray-200">{entry?.tokenConfigured ? 'Configurado' : 'Legado'}</dd></div><div className="flex justify-between gap-4"><dt className="text-gray-400">Senha de alteracao</dt><dd className="font-medium text-gray-700 dark:text-gray-200">{entry?.modificationPasswordConfigured ? 'Exigida' : 'Nao exigida'}</dd></div></dl></section>
                      <section className="border-t border-gray-200 pt-5 dark:border-gray-800"><div className="flex items-center gap-2 text-xs font-semibold text-gray-700 dark:text-gray-200"><Clock3 size={15} /> Auditoria</div><p className="mt-3 text-xs leading-5 text-gray-400">Criado em {formatRouteDate(entry?.createdAt)} por {routeActorLabel(entry?.createdBy)}.</p></section>
                      <section className="border-t border-gray-200 pt-5 dark:border-gray-800">
                        <button
                          type="button"
                          onClick={() => handleDeleteChannel(item, entry)}
                          disabled={deletingChannel}
                          className="h-9 w-full border border-gray-300 px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:text-blue-300"
                        >
                          {deletingChannel ? 'Excluindo...' : 'Excluir canal'}
                        </button>
                      </section>
                    </aside>
                  </div>
                </div>
              );
            })()
        )}
      </OperationalModal>
      </div>
    </main>
  );
};

export default Channels;
