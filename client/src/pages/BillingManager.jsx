import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../services/api';
import toast from 'react-hot-toast';
import {
  CreditCard, Lock, Unlock, RefreshCw, Calendar, CheckCircle,
  AlertTriangle, XCircle, Clock, Building2, ShieldCheck, Handshake
} from 'lucide-react';
import OperationalModal from '../components/OperationalModal';
import { Chip, CountUp } from '../components/admin/OpsKit';
import { PLAN_LABEL, TENANT_STATUS_TONE, reveal } from '../components/admin/opsTones';

const PAYMENT_META = {
  paid:    { label: 'Pago',      tone: 'ok',   Icon: CheckCircle },
  open:    { label: 'Em aberto', tone: 'warn', Icon: Clock },
  overdue: { label: 'Vencido',   tone: 'bad',  Icon: AlertTriangle },
};

const GRACE_DAYS = 10;

const fmtDate   = (iso) => iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
const todayISO  = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

const calcDaysOverdue = (overdueAt) => {
  if (!overdueAt) return null;
  return Math.floor((Date.now() - new Date(overdueAt).getTime()) / 86_400_000);
};

const calcNextDueDate = (dueDay) => {
  if (!dueDay) return null;
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), dueDay);
  return candidate < now
    ? new Date(now.getFullYear(), now.getMonth() + 1, dueDay)
    : candidate;
};

// "hoje", "amanha", "em 12 dias": o que importa e quanto falta, a data vem junto.
const dueIn = (date) => {
  if (!date) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - start.getTime()) / 86_400_000);
  if (days <= 0) return { text: 'hoje', tone: 'bad' };
  if (days === 1) return { text: 'amanhã', tone: 'warn' };
  return { text: `em ${days} dias`, tone: days <= 3 ? 'warn' : 'neutral' };
};

const isTrustActive = (billing) => {
  if (!billing?.trustUnblockUntil) return false;
  return Date.now() <= new Date(billing.trustUnblockUntil).getTime();
};

export default function BillingManager() {
  const [tenants, setTenants]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [scanning, setScanning]       = useState(false);
  const [busy, setBusy]               = useState({});
  // trust-unblock picker: { tenantId, untilDate }
  const [trustPicker, setTrustPicker] = useState(null);
  // Agencias: cliente delas e cobrado pela fatura do Parceiro, nao aqui.
  const [agencias, setAgencias]       = useState({});

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const [res, parceiros] = await Promise.all([apiRequest('/tenants'), apiRequest('/partners').catch(() => null)]);
      if (res?.ok) setTenants(await res.json());
      else toast.error('Erro ao carregar tenants');
      if (parceiros?.ok) {
        const dados = await parceiros.json().catch(() => null);
        setAgencias(Object.fromEntries((dados?.items || []).map((p) => [p.id, p.name])));
      }
    } catch { toast.error('Erro ao carregar tenants'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  const setBusyFor = (id, val) => setBusy(prev => ({ ...prev, [id]: val }));

  const handleBlock = async (tenantId) => {
    setBusyFor(tenantId, 'block');
    try {
      const res = await apiRequest(`/tenants/${tenantId}/billing/block`, { method: 'POST' });
      if (res?.ok) { toast.success('Serviço bloqueado'); fetchTenants(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao bloquear'); }
    } catch { toast.error('Erro ao bloquear'); }
    finally { setBusyFor(tenantId, null); }
  };

  const handleUnblock = async (tenantId) => {
    setBusyFor(tenantId, 'unblock');
    try {
      const res = await apiRequest(`/tenants/${tenantId}/billing/unblock`, { method: 'POST' });
      if (res?.ok) { toast.success('Serviço desbloqueado'); fetchTenants(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao desbloquear'); }
    } catch { toast.error('Erro ao desbloquear'); }
    finally { setBusyFor(tenantId, null); }
  };

  const handlePaymentStatus = async (tenantId, tenant, nextStatus) => {
    setBusyFor(tenantId, 'payment');
    try {
      const billing = { ...(tenant.billing || {}), paymentStatus: nextStatus };
      const res = await apiRequest(`/tenants/${tenantId}`, {
        method: 'PUT',
        body: JSON.stringify({ billing }),
      });
      if (res?.ok) { toast.success('Status atualizado'); fetchTenants(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao atualizar'); }
    } catch { toast.error('Erro ao atualizar status'); }
    finally { setBusyFor(tenantId, null); }
  };

  const handleTrustUnblock = async () => {
    if (!trustPicker) return;
    const { tenantId, untilDate } = trustPicker;
    if (!untilDate) { toast.error('Selecione uma data'); return; }
    if (untilDate <= todayISO()) { toast.error('A data deve ser posterior a hoje'); return; }

    setBusyFor(tenantId, 'trust');
    setTrustPicker(null);
    try {
      const res = await apiRequest(`/tenants/${tenantId}/billing/trust-unblock`, {
        method: 'POST',
        body: JSON.stringify({ untilDate }),
      });
      if (res?.ok) {
        toast.success('Desbloqueio de confiança aplicado');
        fetchTenants();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || 'Erro ao aplicar desbloqueio de confiança');
      }
    } catch { toast.error('Erro ao aplicar desbloqueio de confiança'); }
    finally { setBusyFor(tenantId, null); }
  };

  const handleAutoScan = async () => {
    setScanning(true);
    try {
      const res = await apiRequest('/tenants/billing/auto-block-scan', { method: 'POST' });
      if (res?.ok) {
        const data = await res.json();
        const count = data.newlyBlocked?.length || 0;
        toast.success(count > 0 ? `${count} tenant(s) bloqueados automaticamente` : 'Nenhum novo bloqueio');
        fetchTenants();
      } else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro no scan'); }
    } catch { toast.error('Erro no scan'); }
    finally { setScanning(false); }
  };

  const blockedCount = tenants.filter(t => t.billing?.blocked || isTrustActive(t.billing) === false && t.billing?.blocked).length;
  const diretos     = tenants.filter(t => !t.partnerId);
  const overdueCount = diretos.filter(t => t.billing?.paymentStatus === 'overdue').length;
  const paidCount    = diretos.filter(t => t.billing?.paymentStatus === 'paid').length;
  const trustedCount = tenants.filter(t => isTrustActive(t.billing)).length;

  return (
    <div className="super-admin-operational p-3 sm:p-4 lg:p-6 space-y-6">
      {/* Trust unblock picker modal */}
      {trustPicker && (
        <OperationalModal open={Boolean(trustPicker)} onClose={() => setTrustPicker(null)} size="sm" context="Billing" title="Desbloqueio de confianca">
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={20} className="text-blue-500" />
              <h3 className="font-bold text-slate-800 dark:text-white">Desbloqueio de Confiança</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              O serviço ficará desbloqueado até a data escolhida. Esta operação só pode ser usada <strong>uma vez por mês</strong>.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Desbloquear até
              </label>
              <input
                type="date"
                min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                value={trustPicker.untilDate}
                onChange={e => setTrustPicker(prev => ({ ...prev, untilDate: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 dark:text-white text-sm"
              />
            </div>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setTrustPicker(null)}
                className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleTrustUnblock}
                disabled={!trustPicker.untilDate}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </OperationalModal>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <CreditCard size={24} /> Billing
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Ciclos de cobrança, status de pagamento e bloqueio de serviços
          </p>
        </div>
        <button
          onClick={handleAutoScan}
          disabled={scanning}
          className="sa-btn sa-press"
          title="Bloqueia quem passou dos 10 dias de carência"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Verificando…' : 'Scan de auto-bloqueio'}
        </button>
      </div>

      {/* Summary */}
      <div className="sa-metric-strip grid-cols-2 sm:grid-cols-4">
        <SummaryCard index={0} label="Total de tenants" value={tenants.length} />
        <SummaryCard index={1} label="Pagamentos em dia" value={paidCount} tone="ok" />
        <SummaryCard index={2} label="Vencidos" value={overdueCount} tone="bad" />
        <SummaryCard index={3} label="Confiança ativa" value={trustedCount} tone="info" />
      </div>

      {/* Tenant list */}
      {loading && !tenants.length ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-36 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      ) : tenants.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <Building2 size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum tenant cadastrado</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tenants.map((tenant, index) => {
            const b             = tenant.billing || {};
            const isBlocked     = b.blocked === true;
            const trustActive   = isTrustActive(b);
            const canUseTrust   = b.trustUnblockUsedMonth !== thisMonth();
            const payMeta       = PAYMENT_META[b.paymentStatus] || PAYMENT_META.open;
            const status        = TENANT_STATUS_TONE[tenant.status] || { tone: 'neutral', label: tenant.status || '—' };
            const daysOverdue   = calcDaysOverdue(b.overdueAt);
            const nextDue       = calcNextDueDate(b.dueDay);
            const due           = dueIn(nextDue);
            const autoBlockIn   = (!tenant.partnerId && b.paymentStatus === 'overdue' && daysOverdue !== null && !trustActive)
              ? Math.max(0, GRACE_DAYS - daysOverdue)
              : null;
            const isBusy        = !!busy[tenant.id];
            const agencia       = tenant.partnerId ? (agencias[tenant.partnerId] || 'agência') : null;
            const motivoBloqueio = b.blockReason === 'auto_overdue' ? '(auto)' : b.blockReason === 'partner_overdue' ? '(fatura da agência atrasada)' : '(manual)';
            // A marca lateral do cartao mostra o estado mais importante.
            const cardTone = trustActive ? 'info' : isBlocked ? 'bad' : !tenant.partnerId && b.paymentStatus === 'overdue' ? 'warn' : undefined;

            return (
              <div
                key={tenant.id}
                className="sa-card sa-reveal border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800"
                data-tone={cardTone}
                style={reveal(index)}
              >
                {/* Row 1: name + badges */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="font-semibold text-slate-800 dark:text-white">{tenant.name}</span>
                  <Chip>{PLAN_LABEL[tenant.plan] || tenant.plan || 'Basic'}</Chip>
                  {agencia
                    ? <Chip icon={Handshake}>Cobrado pela {agencia}</Chip>
                    : <Chip tone={payMeta.tone} icon={payMeta.Icon}>{payMeta.label}</Chip>}
                  {tenant.status !== 'active' && <Chip tone={status.tone}>{status.label}</Chip>}
                  {trustActive && (
                    <Chip tone="info" icon={ShieldCheck}>Confiança até {fmtDate(b.trustUnblockUntil)}</Chip>
                  )}
                  {isBlocked && !trustActive && (
                    <Chip tone="bad" icon={Lock}>Bloqueado {motivoBloqueio}</Chip>
                  )}
                </div>

                {agencia && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                    Este cliente paga a agência. A Onion cobra a agência pela fatura mensal em Parceiros; se ela atrasar mais de {GRACE_DAYS} dias, os clientes dela são bloqueados e liberados sozinhos quando ela paga.
                  </p>
                )}

                {/* Row 2: info grid */}
                {!agencia && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-slate-500 dark:text-slate-400 mb-4">
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-0.5">Representante</p>
                    <p>{b.representative || '—'}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-0.5">Ativação</p>
                    <p>{fmtDate(b.activatedAt || tenant.createdAt)}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-0.5 flex items-center gap-1">
                      <Calendar size={11} /> Próximo vencimento
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5">
                      {nextDue ? nextDue.toLocaleDateString('pt-BR') : b.dueDay ? `Dia ${b.dueDay}` : '—'}
                      {due && b.paymentStatus !== 'paid' && <Chip tone={due.tone}>{due.text}</Chip>}
                      {due && b.paymentStatus === 'paid' && <span className="text-slate-400">({due.text})</span>}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-slate-300 mb-0.5">Contato</p>
                    <p>{b.phone || b.email || '—'}</p>
                  </div>
                </div>}

                {/* Trust unblock info */}
                {!agencia && !canUseTrust && !trustActive && (
                  <div className="sa-note mb-3" data-tone="info">
                    <ShieldCheck size={13} />
                    Desbloqueio de confiança já utilizado este mês. Disponível em {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString('pt-BR')}.
                  </div>
                )}

                {/* Auto-block warning */}
                {autoBlockIn !== null && !isBlocked && (
                  <div className="sa-note mb-3" data-tone={autoBlockIn === 0 ? 'bad' : 'warn'}>
                    <AlertTriangle size={13} />
                    {autoBlockIn === 0
                      ? 'Bloqueio automático pendente — execute o scan para aplicar'
                      : `Bloqueio automático em ${autoBlockIn} dia(s) (${daysOverdue}/${GRACE_DAYS} dias de carência)`}
                  </div>
                )}

                {/* Blocked date */}
                {isBlocked && !trustActive && b.blockedAt && (
                  <div className="sa-note mb-3" data-tone="bad">
                    <XCircle size={13} /> Bloqueado em {fmtDate(b.blockedAt)}
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  {!agencia && b.paymentStatus !== 'paid' && (
                    <button onClick={() => handlePaymentStatus(tenant.id, tenant, 'paid')} disabled={isBusy} className="sa-btn sa-press" data-tone="ok">
                      <CheckCircle size={12} /> Marcar pago
                    </button>
                  )}
                  {!agencia && b.paymentStatus !== 'overdue' && (
                    <button onClick={() => handlePaymentStatus(tenant.id, tenant, 'overdue')} disabled={isBusy} className="sa-btn sa-press" data-tone="warn">
                      <AlertTriangle size={12} /> Marcar vencido
                    </button>
                  )}
                  {!agencia && b.paymentStatus !== 'open' && (
                    <button onClick={() => handlePaymentStatus(tenant.id, tenant, 'open')} disabled={isBusy} className="sa-btn sa-press">
                      <Clock size={12} /> Em aberto
                    </button>
                  )}

                  <div className="ml-auto flex gap-2">
                    {/* Trust unblock (only when blocked or overdue, and quota available) */}
                    {!agencia && (isBlocked || b.paymentStatus === 'overdue') && canUseTrust && !trustActive && (
                      <button
                        onClick={() => setTrustPicker({ tenantId: tenant.id, untilDate: '' })}
                        disabled={isBusy}
                        className="sa-btn sa-press"
                        data-tone="info"
                      >
                        <ShieldCheck size={12} /> Confiança até dia...
                      </button>
                    )}

                    {isBlocked && !trustActive ? (
                      <button onClick={() => handleUnblock(tenant.id)} disabled={isBusy} className="sa-btn sa-press" data-tone="info" data-solid="">
                        <Unlock size={12} /> {busy[tenant.id] === 'unblock' ? 'Desbloqueando...' : 'Desbloquear'}
                      </button>
                    ) : (
                      <button onClick={() => handleBlock(tenant.id)} disabled={isBusy} className="sa-btn sa-press" data-tone="bad">
                        <Lock size={12} /> {busy[tenant.id] === 'block' ? 'Bloqueando...' : 'Bloquear'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone, index }) {
  // Numero colorido so quando diz algo: vencidos em vermelho so se houver algum.
  const active = tone && value > 0;
  return (
    <div className="sa-reveal p-4" style={reveal(index)} data-tone={active ? tone : undefined}>
      <p className="text-2xl font-bold text-slate-800 dark:text-white" style={active ? { color: 'var(--tone)' } : undefined}>
        <CountUp value={value} />
      </p>
      <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}
