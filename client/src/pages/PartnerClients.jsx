import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, LogIn, Plus, Power, PowerOff, Loader2, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { useDialog } from '../context/DialogContext';
import OperationalModal from '../components/OperationalModal';
import { TableSkeleton } from '../components/LoadingSkeleton';

// Painel do Parceiro: carteira de clientes. "Entrar" abre o painel do cliente
// como administrador dele; cada entrada fica registrada.
const PLANOS = [['basic', 'Basic'], ['pro', 'Pro'], ['premium', 'Premium']];
const vazio = { name: '', plan: 'basic', maxUsers: 5, adminName: '', adminUsername: '', adminPassword: '' };

const campo = 'h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white';
const rotulo = 'mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-300';

const lerJson = async (res) => {
  const data = res ? await res.json().catch(() => null) : null;
  if (!res?.ok) throw new Error(data?.error || 'Falha ao falar com o servidor');
  return data;
};

const PartnerClients = () => {
  const [clientes, setClientes] = useState([]);
  const [limite, setLimite] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [modalAberto, setModalAberto] = useState(false);
  const [form, setForm] = useState(vazio);
  const [salvando, setSalvando] = useState(false);
  const navigate = useNavigate();
  const { confirm } = useDialog();

  const carregar = useCallback(async () => {
    try {
      const data = await lerJson(await apiRequest('/partner/tenants'));
      setClientes(data.items || []);
      setLimite(data.maxTenants ?? null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const entrar = (cliente) => {
    try { localStorage.setItem('selectedTenant', JSON.stringify({ id: cliente.id, name: cliente.name })); } catch { /* segue pela rota */ }
    navigate(`/tenant/${cliente.id}/monitor`);
  };

  const alternarStatus = async (cliente) => {
    const suspender = cliente.status !== 'suspended';
    if (suspender) {
      const ok = await confirm({
        title: 'Suspender cliente',
        message: `O bot de ${cliente.name} para de responder até você reativar. Os dados continuam guardados.`,
        confirmText: 'Suspender',
        type: 'danger'
      });
      if (!ok) return;
    }
    try {
      await lerJson(await apiRequest(`/partner/tenants/${cliente.id}`, { method: 'PATCH', body: JSON.stringify({ status: suspender ? 'suspended' : 'active' }) }));
      toast.success(suspender ? 'Cliente suspenso' : 'Cliente reativado');
      carregar();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const criar = async (event) => {
    event.preventDefault();
    if (form.adminPassword.length < 8) return toast.error('A senha do administrador precisa de pelo menos 8 caracteres.');
    setSalvando(true);
    try {
      await lerJson(await apiRequest('/partner/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          plan: form.plan,
          maxUsers: Number(form.maxUsers) || 5,
          admin: { name: form.adminName, username: form.adminUsername, password: form.adminPassword }
        })
      }));
      toast.success(`Cliente criado. O administrador entra com o usuário ${form.adminUsername}.`);
      setModalAberto(false);
      setForm(vazio);
      carregar();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvando(false);
    }
  };

  const noLimite = limite !== null && clientes.length >= limite;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Clientes</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {limite !== null ? `${clientes.length} de ${limite} clientes na sua carteira.` : 'Sua carteira de clientes.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalAberto(true)}
          disabled={noLimite}
          title={noLimite ? 'Limite de clientes atingido. Fale com a Onion para aumentar.' : undefined}
          className="inline-flex items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} /> Novo cliente
        </button>
      </div>

      <div className="overflow-hidden border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {carregando ? <TableSkeleton rows={4} cols={5} /> : clientes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <Building2 size={28} className="text-gray-300 dark:text-gray-600" />
            <p className="text-sm font-medium text-gray-900 dark:text-white">Nenhum cliente ainda</p>
            <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">Crie o primeiro cliente: ele já nasce com a sua marca e com um administrador para entrar no painel.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Cliente</th>
                  <th className="px-5 py-3 font-medium">Plano</th>
                  <th className="px-5 py-3 font-medium">Situação</th>
                  <th className="px-5 py-3 font-medium">Usuários</th>
                  <th className="px-5 py-3 font-medium">Conversas abertas</th>
                  <th className="px-5 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {clientes.map((cliente) => {
                  const suspenso = cliente.status === 'suspended';
                  return (
                    <tr key={cliente.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-4">
                        <div className="font-medium text-gray-900 dark:text-white">{cliente.name}</div>
                        <div className="mt-0.5 text-xs text-gray-400">{cliente.createdAt ? `Desde ${new Date(cliente.createdAt).toLocaleDateString('pt-BR')}` : ''}</div>
                      </td>
                      <td className="px-5 py-4 capitalize text-gray-600 dark:text-gray-300">{cliente.plan}</td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${suspenso ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'}`}>
                          {suspenso ? 'Suspenso' : 'Ativo'}
                        </span>
                      </td>
                      <td className="px-5 py-4 tabular-nums text-gray-600 dark:text-gray-300">{cliente.users}{cliente.maxUsers ? ` / ${cliente.maxUsers}` : ''}</td>
                      <td className="px-5 py-4 tabular-nums text-gray-600 dark:text-gray-300">{cliente.openChats}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button type="button" onClick={() => alternarStatus(cliente)} className="p-2 text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-gray-200" title={suspenso ? 'Reativar cliente' : 'Suspender cliente'} aria-label={suspenso ? 'Reativar cliente' : 'Suspender cliente'}>
                            {suspenso ? <Power size={16} /> : <PowerOff size={16} />}
                          </button>
                          <button type="button" onClick={() => entrar(cliente)} className="inline-flex items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-200">
                            <LogIn size={14} /> Entrar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <OperationalModal open={modalAberto} onClose={() => setModalAberto(false)} size="md" title="Novo cliente">
        <form onSubmit={criar}>
          <div className="space-y-4 p-5">
            <div><label className={rotulo} htmlFor="cliente-nome">Nome da empresa</label><input id="cliente-nome" required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={campo} placeholder="Pet Shop Exemplo" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className={rotulo} htmlFor="cliente-plano">Plano</label><select id="cliente-plano" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} className={campo}>{PLANOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
              <div><label className={rotulo} htmlFor="cliente-usuarios">Limite de usuários</label><input id="cliente-usuarios" type="number" min={1} max={200} value={form.maxUsers} onChange={(e) => setForm({ ...form, maxUsers: e.target.value })} className={campo} /></div>
            </div>
            <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Administrador do cliente</p>
              <div className="space-y-4">
                <div><label className={rotulo} htmlFor="admin-nome">Nome</label><input id="admin-nome" required value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} className={campo} /></div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className={rotulo} htmlFor="admin-usuario">Usuário</label><input id="admin-usuario" required minLength={3} value={form.adminUsername} onChange={(e) => setForm({ ...form, adminUsername: e.target.value.trim() })} className={campo} autoComplete="off" /></div>
                  <div><label className={rotulo} htmlFor="admin-senha">Senha</label><input id="admin-senha" type="password" required minLength={8} value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} className={campo} autoComplete="new-password" /></div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-800">
            <button type="button" onClick={() => setModalAberto(false)} className="h-9 border border-gray-300 px-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button>
            <button type="submit" disabled={salvando} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {salvando ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Criar cliente
            </button>
          </div>
        </form>
      </OperationalModal>
    </div>
  );
};

export default PartnerClients;
