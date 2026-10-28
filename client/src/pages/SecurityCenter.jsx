import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Shield,
  ShieldCheck,
  ShieldOff,
  Plus,
  Trash2,
  Pencil,
  Clock,
  Lock,
  KeyRound,
  Copy,
  AlertTriangle,
  CheckCircle2,
  RefreshCcw,
  Activity
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { useAuth } from '../context/AuthContext';
import { SkeletonBox } from '../components/LoadingSkeleton';
import { motion } from 'framer-motion';
import { Chip, CopyId } from '../components/admin/OpsKit';
import { reveal } from '../components/admin/opsTones';

import TablePagination, { usePagination } from '../components/TablePagination';
const TABS = [
  { id: 'allowlist', label: 'Allowlist de IPs', icon: Shield },
  { id: 'totp', label: 'Autenticação em 2 fatores', icon: KeyRound },
  { id: 'audit', label: 'Auditoria', icon: Activity }
];

const formatDate = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('pt-BR');
  } catch {
    return String(value);
  }
};

const sourceBadge = (source) => {
  const map = {
    bootstrap: { label: 'env', tone: 'warn' },
    manual: { label: 'manual', tone: 'neutral' },
    temporary: { label: 'temporário', tone: 'info' }
  };
  const meta = map[source] || map.manual;
  return <Chip tone={meta.tone}>{meta.label}</Chip>;
};

const outcomeBadge = (outcome) => {
  const map = {
    denied: { label: 'negado', tone: 'bad' },
    monitor_passthrough: { label: 'monitor', tone: 'warn' },
    allowed_mfa: { label: 'permitido (MFA)', tone: 'ok' },
    login_new_ip: { label: 'login de IP novo', tone: 'info' }
  };
  const meta = map[outcome] || { label: outcome, tone: 'neutral' };
  return <Chip tone={meta.tone}>{meta.label}</Chip>;
};

const REASON_LABEL = {
  ip_not_allowed: 'IP fora da allowlist',
  mfa_elevation: 'liberado pelo 2º fator',
  first_time_ip: 'primeiro acesso deste IP'
};

const copyToClipboard = async (value, label = 'Texto') => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copiado`);
  } catch {
    toast.error('Falha ao copiar');
  }
};

// --------------- Allowlist tab ---------------

const AllowlistTab = () => {
  const [items, setItems] = useState([]);
  const itemsPage = usePagination(items);
  const [requestIp, setRequestIp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ip: '', label: '', expiresAt: '' });
  const [tempHours, setTempHours] = useState(4);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest('/super-admin/ip-allowlist');
      if (!res.ok) throw new Error('Falha ao carregar');
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setRequestIp(data.requestIp || null);
    } catch (err) {
      toast.error(err?.message || 'Falha ao carregar allowlist');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const ip = form.ip.trim();
    if (!ip) {
      toast.error('IP obrigatório');
      return;
    }
    try {
      const res = await apiRequest('/super-admin/ip-allowlist', {
        method: 'POST',
        body: JSON.stringify({
          ip,
          label: form.label.trim(),
          expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao criar entrada');
      }
      toast.success('Entrada criada');
      setForm({ ip: '', label: '', expiresAt: '' });
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleRemove = async (entry) => {
    if (entry.source === 'bootstrap') {
      toast.error('Entrada de bootstrap não pode ser removida pela API');
      return;
    }
    if (!window.confirm(`Remover ${entry.ip}?`)) return;
    try {
      const res = await apiRequest(`/super-admin/ip-allowlist/${entry.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao remover');
      }
      toast.success('Entrada removida');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleEditLabel = async (entry) => {
    const next = window.prompt('Novo rótulo', entry.label || '');
    if (next === null) return;
    try {
      const res = await apiRequest(`/super-admin/ip-allowlist/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: next })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao atualizar');
      }
      toast.success('Atualizado');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleClearExpiration = async (entry) => {
    if (!window.confirm(`Remover a expiração de ${entry.ip}?`)) return;
    try {
      const res = await apiRequest(`/super-admin/ip-allowlist/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expiresAt: null })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao atualizar');
      }
      toast.success('Expiração removida');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleTemporary = async () => {
    const hours = Number(tempHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast.error('Informe uma quantidade de horas válida');
      return;
    }
    try {
      const res = await apiRequest('/super-admin/ip-allowlist/temporary', {
        method: 'POST',
        body: JSON.stringify({ hours, ip: requestIp })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao liberar IP');
      }
      const data = await res.json();
      toast.success(`Liberado até ${formatDate(data.expiresAt)}`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          IP atual da requisição:
          {requestIp ? <CopyId value={requestIp} strong /> : <span className="font-mono">—</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg pl-2 pr-1 py-1">
            <Clock size={14} className="text-slate-500" />
            <input
              type="number"
              min={1}
              max={168}
              className="w-14 bg-transparent text-sm outline-none"
              value={tempHours}
              onChange={(e) => setTempHours(e.target.value)}
            />
            <span className="text-xs text-slate-500 pr-1">h</span>
            <button
              onClick={handleTemporary}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-md font-medium"
            >
              Liberar meu IP
            </button>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="text-xs bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5"
          >
            <Plus size={14} /> Adicionar IP
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="sa-icon-btn"
            title="Recarregar"
            aria-label="Recarregar"
          >
            <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {showForm && (
        <div className="sa-reveal bg-slate-50 dark:bg-slate-900/40 rounded-lg p-4 border border-slate-200 dark:border-slate-700 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase text-slate-500">IP ou CIDR</label>
              <input
                className="w-full mt-1 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
                placeholder="203.0.113.42 ou 198.51.100.0/24"
                value={form.ip}
                onChange={(e) => setForm((prev) => ({ ...prev, ip: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase text-slate-500">Rótulo</label>
              <input
                className="w-full mt-1 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
                placeholder="Ex: escritório SP"
                value={form.label}
                onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase text-slate-500">Expira em (opcional)</label>
              <input
                type="datetime-local"
                className="w-full mt-1 px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
                value={form.expiresAt}
                onChange={(e) => setForm((prev) => ({ ...prev, expiresAt: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setForm({ ip: '', label: '', expiresAt: '' }); }}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
            >
              Cancelar
            </button>
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md"
            >
              Adicionar
            </button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2 font-semibold">IP / CIDR</th>
              <th className="px-4 py-2 font-semibold">Rótulo</th>
              <th className="px-4 py-2 font-semibold">Origem</th>
              <th className="px-4 py-2 font-semibold">Expira</th>
              <th className="px-4 py-2 font-semibold w-1">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              Array.from({ length: 4 }).map((_, index) => (
                <tr key={`sec_skel_${index}`} className="border-t border-slate-100 dark:border-slate-700">
                  {Array.from({ length: 5 }).map((__, col) => (
                    <td key={`sec_skel_${index}_${col}`} className="px-4 py-3"><SkeletonBox className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <Shield size={28} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" />
                  <div className="text-sm font-medium text-slate-600 dark:text-slate-300">Nenhuma entrada cadastrada</div>
                  <div className="mt-1 text-xs text-slate-400">Use “Liberar meu IP” para liberar este computador por algumas horas.</div>
                </td>
              </tr>
            )}
            {itemsPage.pageItems.map((entry, index) => (
              <tr key={entry.id} className="sa-row sa-reveal border-t border-slate-100 dark:border-slate-700" style={reveal(index)}>
                <td className="px-4 py-2 font-mono text-xs text-slate-800 dark:text-slate-100">{entry.ip}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{entry.label || '—'}</td>
                <td className="px-4 py-2">{sourceBadge(entry.source)}</td>
                <td className="px-4 py-2 text-xs text-slate-600 dark:text-slate-300">
                  {entry.expiresAt ? formatDate(entry.expiresAt) : 'permanente'}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    {entry.source !== 'bootstrap' && (
                      <>
                        <button
                          onClick={() => handleEditLabel(entry)}
                          className="p-1 text-slate-500 hover:text-blue-600"
                          title="Editar rótulo"
                        >
                          <Pencil size={14} />
                        </button>
                        {entry.expiresAt && (
                          <button
                            onClick={() => handleClearExpiration(entry)}
                            className="p-1 text-slate-500 hover:text-amber-600"
                            title="Tornar permanente"
                          >
                            <Clock size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => handleRemove(entry)}
                          className="p-1 text-slate-500 hover:text-rose-600"
                          title="Remover"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePagination {...itemsPage} label="entradas" />
      </div>
    </div>
  );
};

// --------------- TOTP tab ---------------

const TotpTab = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState(null);
  const [setupCode, setSetupCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [elevateCode, setElevateCode] = useState('');
  const [elevatedUntil, setElevatedUntil] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest('/auth/totp/status');
      if (!res.ok) throw new Error('Falha ao carregar status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      toast.error(err?.message || 'Falha ao carregar status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSetup = async () => {
    try {
      const res = await apiRequest('/auth/totp/setup', { method: 'POST' });
      if (!res.ok) throw new Error('Falha ao iniciar setup');
      const data = await res.json();
      setSetup(data);
      setSetupCode('');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleConfirm = async () => {
    if (!setup?.secret || !setupCode) return;
    try {
      const res = await apiRequest('/auth/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ secret: setup.secret, code: setupCode.trim() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha na confirmação');
      }
      toast.success('TOTP ativado');
      setSetup(null);
      setSetupCode('');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleDisable = async () => {
    if (!disablePassword || !disableCode) {
      toast.error('Senha e código são obrigatórios');
      return;
    }
    try {
      const res = await apiRequest('/auth/totp/disable', {
        method: 'POST',
        body: JSON.stringify({ password: disablePassword, code: disableCode.trim() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao desativar');
      }
      toast.success('TOTP desativado');
      setDisablePassword('');
      setDisableCode('');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleElevate = async () => {
    if (!elevateCode) {
      toast.error('Informe o código atual');
      return;
    }
    try {
      const res = await apiRequest('/auth/totp/elevate', {
        method: 'POST',
        body: JSON.stringify({ code: elevateCode.trim() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha na elevação');
      }
      const data = await res.json();
      toast.success(`Acesso elevado até ${formatDate(data.expiresAt)}`);
      setElevatedUntil(data.expiresAt);
      setElevateCode('');
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading) {
    return <div className="text-sm text-slate-500">Carregando…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 shadow-sm">
        <div className="flex items-center gap-3">
          {status?.enabled ? (
            <ShieldCheck size={28} className="text-emerald-500" />
          ) : (
            <ShieldOff size={28} className="text-amber-500" />
          )}
          <div>
            <div className="font-semibold text-slate-800 dark:text-slate-100">
              {status?.enabled ? 'TOTP ativo' : 'TOTP não configurado'}
            </div>
            <div className="text-xs text-slate-500">
              {status?.enabled
                ? `Cadastrado em ${formatDate(status.enrolledAt)} · sessão de elevação: ${status.ttlMinutes}min`
                : 'Necessário para SUPER_ADMIN acessar de IPs fora da allowlist.'}
            </div>
          </div>
        </div>
      </div>

      {!status?.enabled && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 shadow-sm space-y-4">
          <div className="font-semibold text-slate-800 dark:text-slate-100">Configurar TOTP</div>
          {!setup ? (
            <button
              onClick={handleSetup}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md"
            >
              Gerar segredo
            </button>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="text-[11px] uppercase font-semibold text-slate-500 mb-1">Segredo (digite no app autenticador)</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-slate-100 dark:bg-slate-900 rounded-md font-mono text-sm break-all">
                    {setup.secret}
                  </code>
                  <button
                    onClick={() => copyToClipboard(setup.secret, 'Segredo')}
                    className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md"
                    title="Copiar"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase font-semibold text-slate-500 mb-1">URL otpauth (cole no app)</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-slate-100 dark:bg-slate-900 rounded-md font-mono text-xs break-all">
                    {setup.otpauthUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(setup.otpauthUrl, 'URL')}
                    className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md"
                    title="Copiar"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <div className="text-[11px] uppercase font-semibold text-slate-500 mb-1">Primeiro código gerado</div>
                  <input
                    className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 font-mono"
                    placeholder="000000"
                    value={setupCode}
                    onChange={(e) => setSetupCode(e.target.value)}
                    maxLength={6}
                  />
                </div>
                <button
                  onClick={handleConfirm}
                  className="sa-btn sa-press h-[38px] px-4"
                  data-tone="ok"
                  data-solid=""
                >
                  <CheckCircle2 size={14} /> Confirmar
                </button>
                <button
                  onClick={() => { setSetup(null); setSetupCode(''); }}
                  className="px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {status?.enabled && (
        <>
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-5 shadow-sm space-y-3">
            <div className="font-semibold text-slate-800 dark:text-slate-100">Elevar acesso (MFA)</div>
            <p className="text-xs text-slate-500">
              Use quando estiver acessando de um IP fora da allowlist. Cria uma sessão MFA de {status.ttlMinutes} min ligada ao IP atual.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <div className="text-[11px] uppercase font-semibold text-slate-500 mb-1">Código atual</div>
                <input
                  className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 font-mono"
                  placeholder="000000"
                  value={elevateCode}
                  onChange={(e) => setElevateCode(e.target.value)}
                  maxLength={6}
                />
              </div>
              <button
                onClick={handleElevate}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md inline-flex items-center gap-1.5"
              >
                <Lock size={14} /> Elevar
              </button>
            </div>
            {elevatedUntil && (
              <div className="text-xs text-emerald-600 dark:text-emerald-300">
                Acesso elevado até {formatDate(elevatedUntil)}.
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-900/40 rounded-lg p-5 shadow-sm space-y-3">
            <div className="font-semibold text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
              <AlertTriangle size={16} /> Desativar TOTP
            </div>
            <p className="text-xs text-slate-500">
              Remove o segundo fator e invalida todas as sessões MFA ativas. SUPER_ADMIN ficará bloqueado fora da allowlist.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <input
                type="password"
                className="px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
                placeholder="Senha"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
              />
              <input
                className="px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 font-mono"
                placeholder="Código atual"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                maxLength={6}
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleDisable}
                className="px-3 py-2 text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white rounded-md"
              >
                Desativar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// --------------- Audit tab ---------------

const AuditTab = () => {
  const [items, setItems] = useState([]);
  const eventsPage = usePagination(items);
  const [loading, setLoading] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef(null);
  // Eventos que acabaram de chegar pelo socket piscam na tabela por um instante.
  const [freshIds, setFreshIds] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (outcomeFilter) qs.set('outcome', outcomeFilter);
      qs.set('limit', '200');
      const res = await apiRequest(`/super-admin/ip-allowlist/audit?${qs.toString()}`);
      if (!res.ok) throw new Error('Falha ao carregar auditoria');
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      toast.error(err?.message || 'Falha ao carregar auditoria');
    } finally {
      setLoading(false);
    }
  }, [outcomeFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = (event) => {
      setItems((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [event, ...current].slice(0, 500);
      });
      setPulse(true);
      if (event?.id) {
        setFreshIds((current) => new Set(current).add(event.id));
        setTimeout(() => setFreshIds((current) => {
          const next = new Set(current);
          next.delete(event.id);
          return next;
        }), 2000);
      }
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(() => setPulse(false), 1500);
    };
    socketService.on('admin_ip_alert', handler);
    return () => {
      socketService.off('admin_ip_alert', handler);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            className="px-2 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
          >
            <option value="">Todos os desfechos</option>
            <option value="denied">Negados</option>
            <option value="monitor_passthrough">Monitor</option>
            <option value="allowed_mfa">Permitidos via MFA</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="sa-icon-btn"
            title="Recarregar"
            aria-label="Recarregar"
          >
            <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {pulse && <Chip tone="info" className="sa-reveal">novo evento</Chip>}
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Quando</th>
              <th className="px-3 py-2 font-semibold">Resultado</th>
              <th className="px-3 py-2 font-semibold">IP</th>
              <th className="px-3 py-2 font-semibold">Rota</th>
              <th className="px-3 py-2 font-semibold">Usuário</th>
              <th className="px-3 py-2 font-semibold">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Carregando…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Nenhum evento.</td></tr>
            )}
            {eventsPage.pageItems.map((event, index) => (
              <tr key={event.id} className={`sa-row sa-reveal border-t border-slate-100 dark:border-slate-700 ${freshIds.has(event.id) ? 'sa-flash' : ''}`} style={reveal(index)}>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(event.timestamp)}</td>
                <td className="px-3 py-2">{outcomeBadge(event.outcome)}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-800 dark:text-slate-100">{event.clientIp || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                  <span className="font-mono">{event.method}</span> {event.path}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                  {event.userId || '—'}{event.role ? ` (${event.role})` : ''}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500" title={event.reason || undefined}>{REASON_LABEL[event.reason] || event.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <TablePagination {...eventsPage} label="eventos" />
      </div>
    </div>
  );
};

// --------------- Page shell ---------------

const SecurityCenter = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState('allowlist');
  const [enrollmentRequired, setEnrollmentRequired] = useState(false);

  const allowedTabs = useMemo(() => {
    if (user?.role === 'SUPER_ADMIN') return TABS;
    // Non-super-admin pode apenas gerenciar seu próprio TOTP.
    return TABS.filter((t) => t.id === 'totp');
  }, [user?.role]);

  useEffect(() => {
    if (!allowedTabs.some((t) => t.id === tab)) {
      setTab(allowedTabs[0]?.id || 'totp');
    }
  }, [allowedTabs, tab]);

  useEffect(() => {
    if (window.sessionStorage.getItem('totp_enrollment_required') === '1') {
      setEnrollmentRequired(true);
      setTab('totp');
      window.sessionStorage.removeItem('totp_enrollment_required');
    }
  }, []);

  return (
    <div className="super-admin-operational space-y-5 p-3 sm:p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Centro de Segurança</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Gerencie a allowlist de IPs, autenticação em 2 fatores e veja a auditoria de acessos administrativos.
        </p>
      </div>

      {enrollmentRequired && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg p-4 text-sm text-amber-900 dark:text-amber-200">
          <strong>Configure o segundo fator (TOTP)</strong> para continuar usando a plataforma. SUPER_ADMIN precisa de 2FA ativo nesta instalação.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-700">
        {allowedTabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
                active
                  ? 'text-blue-600 dark:text-blue-300'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Icon size={14} /> {t.label}
              {active && (
                <motion.span
                  layoutId="security-tab-underline"
                  className="absolute inset-x-0 -bottom-px h-0.5 bg-blue-600 dark:bg-blue-400"
                  transition={{ type: 'spring', stiffness: 520, damping: 38 }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div key={tab} className="sa-reveal">
        {tab === 'allowlist' && user?.role === 'SUPER_ADMIN' && <AllowlistTab />}
        {tab === 'totp' && <TotpTab />}
        {tab === 'audit' && user?.role === 'SUPER_ADMIN' && <AuditTab />}
      </div>
    </div>
  );
};

export default SecurityCenter;
