import { useEffect, useState } from 'react';
import { ExternalLink, Receipt, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { TableSkeleton } from '../components/LoadingSkeleton';

// Cobranca do Parceiro: valor por cliente ativo, faturas do Asaas e o link
// para pagar (Pix, boleto ou cartao, a escolha dele na pagina do Asaas).
const SITUACAO = {
  paid: ['Paga', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'],
  pending: ['Em aberto', 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300'],
  overdue: ['Vencida', 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'],
  canceled: ['Cancelada', 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'],
  refunded: ['Estornada', 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'],
  nothing_due: ['Sem valor', 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'],
  creating: ['Em preparo', 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'],
  error: ['Em preparo', 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300']
};

const reais = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mes = (periodo) => {
  const [ano, m] = String(periodo || '').split('-');
  if (!ano || !m) return periodo;
  const texto = new Date(Number(ano), Number(m) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
};
const data = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR') : '-');

const PartnerBilling = () => {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest('/partner/billing');
        const body = res ? await res.json().catch(() => null) : null;
        if (!res?.ok) throw new Error(body?.error || 'Falha ao carregar a cobrança');
        setInfo(body);
      } catch (error) {
        toast.error(error.message);
        setInfo({ invoices: [], pricePerClient: 0, activeClients: 0 });
      }
    })();
  }, []);

  const estimativa = info ? info.activeClients * info.pricePerClient : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-3 sm:p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Cobrança</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Uma fatura por mês, pelos clientes ativos na sua carteira.</p>
      </div>

      {info?.blocked && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <TriangleAlert size={18} className="mt-0.5 shrink-0" />
          <p>Seus clientes estão bloqueados por uma fatura com mais de 10 dias de atraso. Assim que o pagamento for confirmado, eles voltam a funcionar sozinhos.</p>
        </div>
      )}

      {info && !(info.pricePerClient > 0) ? (
        <div className="flex flex-col items-center gap-3 border-y border-gray-200 bg-white px-6 py-14 text-center dark:border-gray-800 dark:bg-gray-900">
          <Receipt size={28} className="text-gray-300 dark:text-gray-600" />
          <p className="text-sm text-gray-500 dark:text-gray-400">A Onion ainda não definiu o valor da sua cobrança.</p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-1 divide-y divide-gray-200 border-y border-gray-200 bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
            {[
              ['Valor por cliente ativo', info ? reais(info.pricePerClient) : '…'],
              ['Clientes ativos agora', info ? info.activeClients : '…'],
              ['Próxima fatura (estimativa)', info ? reais(estimativa) : '…']
            ].map(([rotulo, valor]) => (
              <div key={rotulo} className="px-5 py-4">
                <div className="text-xs text-gray-500 dark:text-gray-400">{rotulo}</div>
                <div className="mt-1.5 text-xl font-semibold tabular-nums text-gray-950 dark:text-white">{valor}</div>
              </div>
            ))}
          </section>

          <div className="overflow-hidden border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            {!info ? <TableSkeleton rows={3} cols={5} /> : info.invoices.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400">Nenhuma fatura ainda. A primeira sai no início do próximo mês, com vencimento no dia {info.dueDay}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    <tr><th className="px-5 py-3 font-medium">Mês</th><th className="px-5 py-3 font-medium">Clientes</th><th className="px-5 py-3 font-medium">Valor</th><th className="px-5 py-3 font-medium">Vencimento</th><th className="px-5 py-3 font-medium">Situação</th><th className="px-5 py-3" /></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                    {info.invoices.map((fatura) => {
                      const [rotulo, estilo] = SITUACAO[fatura.status] || [fatura.status, SITUACAO.canceled[1]];
                      const pagavel = ['pending', 'overdue'].includes(fatura.status) && fatura.invoiceUrl;
                      return (
                        <tr key={fatura.id}>
                          <td className="px-5 py-3.5 text-gray-900 dark:text-white">{mes(fatura.period)}</td>
                          <td className="px-5 py-3.5 tabular-nums text-gray-600 dark:text-gray-300">{fatura.activeClients}</td>
                          <td className="px-5 py-3.5 tabular-nums text-gray-900 dark:text-white">{reais(fatura.amount)}</td>
                          <td className="px-5 py-3.5 text-gray-600 dark:text-gray-300">{data(fatura.dueDate)}</td>
                          <td className="px-5 py-3.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${estilo}`}>{rotulo}</span></td>
                          <td className="px-5 py-3.5 text-right">
                            {pagavel ? (
                              <a href={fatura.invoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                                Pagar <ExternalLink size={13} />
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default PartnerBilling;
