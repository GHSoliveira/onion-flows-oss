import { useCallback, useEffect, useState } from 'react';
import { Copy, Globe, Handshake, KeyRound, Loader2, Plus, Receipt, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE, apiRequest } from '../services/api';
import OperationalModal from '../components/OperationalModal';
import { TableSkeleton } from '../components/LoadingSkeleton';
import { dominioRaiz } from '../config/instancia';

// Gestao de Parceiros pela Onion: criar Parceiro com o primeiro login e passar
// tenants existentes para a carteira de um Parceiro.
const vazio = { name: '', maxTenants: 20, subdomain: '', userName: '', username: '', password: '' };
const DOMINIO = dominioRaiz;
const campo = 'h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white';
const rotulo = 'mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-300';

const reais = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SITUACAO = { paid: 'Paga', pending: 'Em aberto', overdue: 'Vencida', canceled: 'Cancelada', refunded: 'Estornada', nothing_due: 'Sem valor', creating: 'Em preparo', error: 'Erro no Asaas' };
const URL_WEBHOOK = `${String(API_BASE).replace(/\/$/, '')}/api/billing/asaas/webhook`;

const copiar = async (texto) => {
  try {
    await navigator.clipboard.writeText(texto);
    toast.success('Copiado');
  } catch {
    toast.error('Não deu para copiar. Selecione e copie manualmente.');
  }
};

const lerJson = async (res) => {
  const data = res ? await res.json().catch(() => null) : null;
  if (!res?.ok) throw new Error(data?.error || 'Falha ao falar com o servidor');
  return data;
};

const PartnersAdmin = () => {
  const [parceiros, setParceiros] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [modalAberto, setModalAberto] = useState(false);
  const [form, setForm] = useState(vazio);
  const [salvando, setSalvando] = useState(false);
  const [vinculo, setVinculo] = useState({ tenantId: '', partnerId: '' });
  // Cobranca: configuracao do Asaas e dados do Parceiro escolhido.
  const [asaas, setAsaas] = useState({ environment: 'sandbox', hasApiKey: false, webhookToken: null });
  const [chaveAsaas, setChaveAsaas] = useState('');
  const [salvandoAsaas, setSalvandoAsaas] = useState(false);
  const [cobranca, setCobranca] = useState(null);
  const [faturas, setFaturas] = useState([]);
  // Endereco proprio (agencia.<VITE_ROOT_DOMAIN>) do parceiro escolhido.
  const [endereco, setEndereco] = useState(null);
  // Novo login de Parceiro para uma agencia que ja existe.
  const [acesso, setAcesso] = useState(null);

  const criarAcesso = async (event) => {
    event.preventDefault();
    try {
      const { user } = await lerJson(await apiRequest(`/partners/${acesso.id}/access`, {
        method: 'POST',
        body: JSON.stringify({ name: acesso.name.trim(), username: acesso.username.trim(), password: acesso.password })
      }));
      toast.success(`Acesso criado: ${user.username}`);
      setAcesso(null);
      carregar();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const salvarEndereco = async (event) => {
    event.preventDefault();
    try {
      const salvo = await lerJson(await apiRequest(`/partners/${endereco.id}/address`, {
        method: 'PATCH',
        body: JSON.stringify({ subdomain: endereco.subdomain.trim() || null })
      }));
      toast.success(salvo.url ? `Endereço salvo: ${salvo.url}` : 'Endereço removido');
      setEndereco(null);
      carregar();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const carregar = useCallback(async () => {
    try {
      const [p, t, a] = await Promise.all([apiRequest('/partners'), apiRequest('/tenants'), apiRequest('/partners/billing-settings')]);
      setParceiros((await lerJson(p)).items || []);
      setTenants((await lerJson(t)) || []);
      setAsaas(await lerJson(a));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const criar = async (event) => {
    event.preventDefault();
    setSalvando(true);
    try {
      await lerJson(await apiRequest('/partners', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, maxTenants: Number(form.maxTenants) || 20, ...(form.subdomain.trim() ? { subdomain: form.subdomain.trim() } : {}), user: { name: form.userName, username: form.username, password: form.password } })
      }));
      toast.success(`Parceiro criado. Ele entra com o usuário ${form.username}.`);
      setModalAberto(false);
      setForm(vazio);
      carregar();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvando(false);
    }
  };

  const vincular = async (event) => {
    event.preventDefault();
    if (!vinculo.tenantId) return toast.error('Escolha o cliente.');
    try {
      await lerJson(await apiRequest(`/partners/tenants/${vinculo.tenantId}`, { method: 'PUT', body: JSON.stringify({ partnerId: vinculo.partnerId || null }) }));
      toast.success(vinculo.partnerId ? 'Cliente passou para a carteira do Parceiro' : 'Cliente voltou a ser direto da Onion');
      setVinculo({ tenantId: '', partnerId: '' });
      carregar();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const salvarAsaas = async (event) => {
    event.preventDefault();
    setSalvandoAsaas(true);
    try {
      const salvo = await lerJson(await apiRequest('/partners/billing-settings', { method: 'PUT', body: JSON.stringify({ environment: asaas.environment, ...(chaveAsaas ? { apiKey: chaveAsaas } : {}) }) }));
      setAsaas(salvo);
      setChaveAsaas('');
      toast.success('Configuração do Asaas salva');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvandoAsaas(false);
    }
  };

  const testarAsaas = async () => {
    try {
      await lerJson(await apiRequest('/partners/billing-settings/test', { method: 'POST' }));
      toast.success('Conexão com o Asaas funcionando');
    } catch (error) {
      toast.error(error.message);
    }
  };

  const abrirCobranca = async (parceiro) => {
    const b = parceiro.billing || {};
    setCobranca({ id: parceiro.id, name: parceiro.name, pricePerClient: b.pricePerClient || '', dueDay: b.dueDay || 10, legalName: b.legalName || '', cpfCnpj: b.cpfCnpj || '', email: b.email || '', startPeriod: b.startPeriod || null });
    setFaturas([]);
    try {
      setFaturas((await lerJson(await apiRequest(`/partners/${parceiro.id}/invoices`))).items || []);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const salvarCobranca = async (event) => {
    event.preventDefault();
    try {
      const salvo = await lerJson(await apiRequest(`/partners/${cobranca.id}/billing`, {
        method: 'PATCH',
        body: JSON.stringify({ pricePerClient: Number(cobranca.pricePerClient) || 0, dueDay: Number(cobranca.dueDay) || 10, legalName: cobranca.legalName, cpfCnpj: cobranca.cpfCnpj, email: cobranca.email })
      }));
      setCobranca((atual) => ({ ...atual, startPeriod: salvo.startPeriod }));
      toast.success('Cobrança do parceiro salva');
      carregar();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const gerarFatura = async () => {
    try {
      const fatura = await lerJson(await apiRequest(`/partners/${cobranca.id}/invoices/generate`, { method: 'POST' }));
      if (fatura.alreadyExisted) toast(`Este mês já tem uma fatura valendo (${reais(fatura.amount)}, ${SITUACAO[fatura.status] || fatura.status}). Cancele no Asaas para gerar outra.`);
      else toast.success(fatura.status === 'error' ? `Fatura criada, mas o Asaas recusou: ${fatura.lastError}` : `Fatura de ${reais(fatura.amount)} gerada`);
      setFaturas((await lerJson(await apiRequest(`/partners/${cobranca.id}/invoices`))).items || []);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const nomeDoParceiro = (id) => parceiros.find((p) => p.id === id)?.name || null;

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Parceiros</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Agências que revendem a plataforma com a própria marca.</p>
        </div>
        <button type="button" onClick={() => setModalAberto(true)} className="inline-flex items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus size={16} /> Novo parceiro
        </button>
      </div>

      <div className="overflow-hidden border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {carregando ? <TableSkeleton rows={3} cols={4} /> : parceiros.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <Handshake size={28} className="text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Nenhum parceiro cadastrado.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <tr><th className="px-5 py-3 font-medium">Parceiro</th><th className="px-5 py-3 font-medium">Endereço</th><th className="px-5 py-3 font-medium">Clientes</th><th className="px-5 py-3 font-medium">Marca</th><th className="px-5 py-3 font-medium">Valor por cliente</th><th className="px-5 py-3 font-medium">Pagamento</th><th className="px-5 py-3" /></tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {parceiros.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-4 font-medium text-gray-900 dark:text-white">{p.name}</td>
                    <td className="px-5 py-4 text-gray-600 dark:text-gray-300">
                      <button type="button" onClick={() => setEndereco({ id: p.id, name: p.name, subdomain: p.subdomain || '' })} className="inline-flex items-center gap-1.5 text-left hover:text-blue-700 dark:hover:text-blue-300" title="Mudar endereço">
                        <Globe size={14} className="shrink-0" />
                        {p.subdomain ? <span>{p.subdomain}.{DOMINIO}</span> : <span className="text-gray-400">Definir</span>}
                      </button>
                    </td>
                    <td className="px-5 py-4 tabular-nums text-gray-600 dark:text-gray-300">{p.tenants} de {p.maxTenants}</td>
                    <td className="px-5 py-4 text-gray-600 dark:text-gray-300">{p.branding?.productName || <span className="text-gray-400">Padrão da Onion</span>}</td>
                    <td className="px-5 py-4 tabular-nums text-gray-600 dark:text-gray-300">{p.billing?.pricePerClient > 0 ? reais(p.billing.pricePerClient) : <span className="text-gray-400">Sem cobrança</span>}</td>
                    <td className="px-5 py-4">{p.billing?.blocked ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-900/30 dark:text-red-300">Bloqueado por atraso</span> : <span className="text-xs text-gray-500">Em dia</span>}</td>
                    <td className="px-5 py-4 text-right"><div className="inline-flex gap-2">
                      <button type="button" onClick={() => setAcesso({ id: p.id, partnerName: p.name, accesses: p.accesses ?? 0, name: '', username: '', password: '' })} className="inline-flex items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-200" title={`${p.accesses ?? 0} acesso(s) de parceiro`}><KeyRound size={14} /> Criar acesso</button>
                      <button type="button" onClick={() => abrirCobranca(p)} className="inline-flex items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-200"><Receipt size={14} /> Cobrança</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Cobrança pelo Asaas</h2>
        <form onSubmit={salvarAsaas} className="space-y-4 border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <div className="grid gap-4 sm:grid-cols-[180px_1fr_auto] sm:items-end">
            <div>
              <label className={rotulo} htmlFor="asaas-ambiente">Ambiente</label>
              <select id="asaas-ambiente" value={asaas.environment} onChange={(e) => setAsaas({ ...asaas, environment: e.target.value })} className={campo}>
                <option value="sandbox">Teste (sandbox)</option>
                <option value="production">Produção</option>
              </select>
            </div>
            <div className="min-w-0">
              <label className={rotulo} htmlFor="asaas-chave">Chave da API do Asaas</label>
              <input id="asaas-chave" type="password" autoComplete="off" value={chaveAsaas} onChange={(e) => setChaveAsaas(e.target.value)} className={campo} placeholder={asaas.hasApiKey ? 'Configurada. Preencha só para trocar.' : 'Cole aqui a chave gerada no Asaas'} />
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={salvandoAsaas} className="h-10 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Salvar</button>
              <button type="button" onClick={testarAsaas} disabled={!asaas.hasApiKey} className="h-10 border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:opacity-40 dark:border-gray-700 dark:text-gray-200">Testar</button>
            </div>
          </div>
          {asaas.webhookToken && (
            <div className="space-y-2 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400">No Asaas, em Integrações → Webhooks, crie um webhook com o endereço e o token abaixo e marque os eventos de cobrança. É assim que o pagamento chega aqui.</p>
              {[['Endereço', URL_WEBHOOK], ['Token', asaas.webhookToken]].map(([nome, valor]) => (
                <div key={nome} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs font-semibold text-gray-500">{nome}</span>
                  <code className="min-w-0 flex-1 truncate bg-gray-50 px-2 py-1.5 text-xs text-gray-800 dark:bg-gray-950 dark:text-gray-200">{valor}</code>
                  <button type="button" onClick={() => copiar(valor)} className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label={`Copiar ${nome.toLowerCase()}`} title="Copiar"><Copy size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Carteira de um cliente existente</h2>
        <form onSubmit={vincular} className="flex flex-col gap-3 border border-gray-200 bg-white p-4 sm:flex-row sm:items-end dark:border-gray-800 dark:bg-gray-900">
          <div className="min-w-0 flex-1">
            <label className={rotulo} htmlFor="vinculo-tenant">Cliente</label>
            <select id="vinculo-tenant" value={vinculo.tenantId} onChange={(e) => setVinculo({ ...vinculo, tenantId: e.target.value })} className={campo}>
              <option value="">Escolha um cliente</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}{t.partnerId ? ` · ${nomeDoParceiro(t.partnerId) || 'parceiro'}` : ' · direto'}</option>)}
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label className={rotulo} htmlFor="vinculo-parceiro">Passa para</label>
            <select id="vinculo-parceiro" value={vinculo.partnerId} onChange={(e) => setVinculo({ ...vinculo, partnerId: e.target.value })} className={campo}>
              <option value="">Direto da Onion (sem parceiro)</option>
              {parceiros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button type="submit" className="h-10 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">Aplicar</button>
        </form>
      </section>

      <OperationalModal open={Boolean(cobranca)} onClose={() => setCobranca(null)} size="lg" title={cobranca ? `Cobrança · ${cobranca.name}` : 'Cobrança'}>
        {cobranca && (
          <div>
            <form onSubmit={salvarCobranca} className="space-y-4 border-b border-gray-200 p-5 dark:border-gray-800">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div><label className={rotulo} htmlFor="cob-valor">Valor por cliente (R$)</label><input id="cob-valor" type="number" min={0} step="0.01" value={cobranca.pricePerClient} onChange={(e) => setCobranca({ ...cobranca, pricePerClient: e.target.value })} className={campo} placeholder="0,00" /></div>
                <div><label className={rotulo} htmlFor="cob-dia">Dia do vencimento</label><input id="cob-dia" type="number" min={1} max={28} value={cobranca.dueDay} onChange={(e) => setCobranca({ ...cobranca, dueDay: e.target.value })} className={campo} /></div>
                <div className="col-span-2"><label className={rotulo} htmlFor="cob-doc">CPF ou CNPJ</label><input id="cob-doc" value={cobranca.cpfCnpj} onChange={(e) => setCobranca({ ...cobranca, cpfCnpj: e.target.value })} className={campo} /></div>
                <div className="col-span-2"><label className={rotulo} htmlFor="cob-razao">Razão social</label><input id="cob-razao" value={cobranca.legalName} onChange={(e) => setCobranca({ ...cobranca, legalName: e.target.value })} className={campo} /></div>
                <div className="col-span-2"><label className={rotulo} htmlFor="cob-email">E-mail financeiro</label><input id="cob-email" type="email" value={cobranca.email} onChange={(e) => setCobranca({ ...cobranca, email: e.target.value })} className={campo} /></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">{cobranca.startPeriod ? `Cobrança automática a partir de ${cobranca.startPeriod}. ` : 'Valor vazio = sem cobrança. '}Clientes suspensos pelo parceiro não entram na conta.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={gerarFatura} className="h-9 border border-gray-300 px-3 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Gerar fatura deste mês</button>
                  <button type="submit" className="h-9 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">Salvar</button>
                </div>
              </div>
            </form>
            <div className="max-h-[40vh] overflow-y-auto">
              {faturas.length === 0 ? <p className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">Nenhuma fatura ainda.</p> : (
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400"><tr><th className="px-5 py-2.5 font-medium">Mês</th><th className="px-5 py-2.5 font-medium">Clientes</th><th className="px-5 py-2.5 font-medium">Valor</th><th className="px-5 py-2.5 font-medium">Vencimento</th><th className="px-5 py-2.5 font-medium">Situação</th></tr></thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                    {faturas.map((f) => (
                      <tr key={f.id}>
                        <td className="px-5 py-2.5 text-gray-900 dark:text-white">{f.period}</td>
                        <td className="px-5 py-2.5 tabular-nums">{f.activeClients}</td>
                        <td className="px-5 py-2.5 tabular-nums">{reais(f.amount)}</td>
                        <td className="px-5 py-2.5">{f.dueDate}</td>
                        <td className="px-5 py-2.5" title={f.lastError || undefined}>{SITUACAO[f.status] || f.status}{f.invoiceUrl ? <> · <a href={f.invoiceUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">fatura</a></> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </OperationalModal>

      <OperationalModal open={Boolean(acesso)} onClose={() => setAcesso(null)} size="sm" title={acesso ? `Novo acesso para ${acesso.partnerName}` : ''}>
        {acesso && (
          <form onSubmit={criarAcesso} className="space-y-4 p-5">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {acesso.accesses ? `Esta agência já tem ${acesso.accesses} acesso(s). ` : 'Esta agência ainda não tem login. '}
              O novo acesso entra no painel do parceiro: clientes, marca e cobrança da agência.
            </p>
            <div><label className={rotulo} htmlFor="acesso-nome">Nome de quem vai usar</label><input id="acesso-nome" required minLength={1} maxLength={120} value={acesso.name} onChange={(e) => setAcesso({ ...acesso, name: e.target.value })} className={campo} autoFocus /></div>
            <div><label className={rotulo} htmlFor="acesso-usuario">Usuário</label><input id="acesso-usuario" required minLength={3} maxLength={60} value={acesso.username} onChange={(e) => setAcesso({ ...acesso, username: e.target.value.trim() })} className={campo} autoComplete="off" /></div>
            <div><label className={rotulo} htmlFor="acesso-senha">Senha</label><input id="acesso-senha" type="password" required minLength={8} value={acesso.password} onChange={(e) => setAcesso({ ...acesso, password: e.target.value })} className={campo} autoComplete="new-password" /><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Pelo menos 8 caracteres.</p></div>
            <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
              <button type="button" onClick={() => setAcesso(null)} className="h-9 border border-gray-300 px-4 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Cancelar</button>
              <button type="submit" className="h-9 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">Criar acesso</button>
            </div>
          </form>
        )}
      </OperationalModal>

      <OperationalModal open={Boolean(endereco)} onClose={() => setEndereco(null)} size="sm" title={endereco ? `Endereço de ${endereco.name}` : ''}>
        {endereco && (
          <form onSubmit={salvarEndereco} className="space-y-4 p-5">
            <div>
              <label className={rotulo} htmlFor="endereco-sub">Endereço próprio</label>
              <div className="flex items-center gap-2">
                <input id="endereco-sub" autoFocus value={endereco.subdomain} onChange={(e) => setEndereco({ ...endereco, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="nomedaagencia" maxLength={40} className={campo} />
                <span className="shrink-0 text-sm text-gray-500">.{DOMINIO}</span>
              </div>
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">De 3 a 40 letras minúsculas, números ou hífen. Em branco tira o endereço. O painel abre nele com a marca da agência.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
              <button type="button" onClick={() => setEndereco(null)} className="h-9 border border-gray-300 px-4 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Cancelar</button>
              <button type="submit" className="h-9 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">Salvar</button>
            </div>
          </form>
        )}
      </OperationalModal>

      <OperationalModal open={modalAberto} onClose={() => setModalAberto(false)} size="md" title="Novo parceiro">
        <form onSubmit={criar}>
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-[1fr_120px] gap-4">
              <div><label className={rotulo} htmlFor="parceiro-nome">Nome da agência</label><input id="parceiro-nome" required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={campo} /></div>
              <div className="sm:col-span-2"><label className={rotulo} htmlFor="parceiro-endereco">Endereço próprio (opcional)</label><div className="flex items-center gap-2"><input id="parceiro-endereco" value={form.subdomain} onChange={(e) => setForm({ ...form, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="nomedaagencia" maxLength={40} className={campo} /><span className="shrink-0 text-sm text-gray-500">.{DOMINIO}</span></div></div>
              <div><label className={rotulo} htmlFor="parceiro-limite">Limite de clientes</label><input id="parceiro-limite" type="number" min={1} max={1000} value={form.maxTenants} onChange={(e) => setForm({ ...form, maxTenants: e.target.value })} className={campo} /></div>
            </div>
            <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Login do parceiro</p>
              <div className="space-y-4">
                <div><label className={rotulo} htmlFor="parceiro-pessoa">Nome</label><input id="parceiro-pessoa" required value={form.userName} onChange={(e) => setForm({ ...form, userName: e.target.value })} className={campo} /></div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className={rotulo} htmlFor="parceiro-usuario">Usuário</label><input id="parceiro-usuario" required minLength={3} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim() })} className={campo} autoComplete="off" /></div>
                  <div><label className={rotulo} htmlFor="parceiro-senha">Senha</label><input id="parceiro-senha" type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={campo} autoComplete="new-password" /></div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-800">
            <button type="button" onClick={() => setModalAberto(false)} className="h-9 border border-gray-300 px-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button>
            <button type="submit" disabled={salvando} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {salvando ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Criar parceiro
            </button>
          </div>
        </form>
      </OperationalModal>
    </div>
  );
};

export default PartnersAdmin;
