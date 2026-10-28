import { useEffect, useState } from 'react';
import { Copy, Loader2, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { dominioRaiz } from '../config/instancia';

// Marca do Parceiro: vale para o painel dele e para todos os clientes da
// carteira. Cada cliente pode trocar o que quiser na aba Identidade dele.
const CAMPOS = [
  ['productName', 'Nome do produto no painel', 'text', 'Atende+'],
  ['organizationName', 'Nome da empresa', 'text', 'Agência Exemplo LTDA'],
  ['logoUrl', 'URL do logotipo (https)', 'url', 'https://...'],
  ['faviconUrl', 'URL do ícone da aba (https)', 'url', 'https://...'],
  ['loginImageUrl', 'URL da imagem da tela de login (https)', 'url', 'https://... (em branco: o planeta)'],
  ['supportEmail', 'E-mail de suporte', 'email', 'suporte@suaagencia.com.br'],
  ['supportWhatsapp', 'WhatsApp de suporte', 'tel', '55 11 99999-0000']
];

const PartnerBrand = () => {
  const [marca, setMarca] = useState({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [endereco, setEndereco] = useState(undefined);

  useEffect(() => {
    apiRequest('/partner/me')
      .then((res) => (res?.ok ? res.json() : null))
      .then((data) => setEndereco(data?.partner?.url || null))
      .catch(() => setEndereco(null));
  }, []);

  const copiarEndereco = async () => {
    try {
      await navigator.clipboard.writeText(endereco);
      toast.success('Endereço copiado');
    } catch {
      toast.error('Não deu para copiar. Selecione e copie manualmente.');
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest('/partner/branding');
        const data = res ? await res.json().catch(() => null) : null;
        if (res?.ok) setMarca(data?.settings || {});
      } finally {
        setCarregando(false);
      }
    })();
  }, []);

  const salvar = async (event) => {
    event.preventDefault();
    setSalvando(true);
    try {
      const res = await apiRequest('/partner/branding', { method: 'PATCH', body: JSON.stringify(marca) });
      const data = res ? await res.json().catch(() => null) : null;
      if (!res?.ok) throw new Error(data?.error || 'Falha ao salvar a marca');
      setMarca(data.settings || {});
      window.dispatchEvent(new Event('brand:changed'));
      toast.success('Marca salva');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvando(false);
    }
  };

  const campo = 'h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white';

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-3 sm:p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Marca</h1>
        <p className="mt-1 max-w-xl text-sm text-gray-500 dark:text-gray-400">
          Aparece no seu painel e no de todos os seus clientes. Um cliente pode trocar algum item na aba Identidade dele; o que ficar em branco usa esta marca.
        </p>
      </div>

      {endereco !== undefined && (
        <section className="border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Seu endereço</h2>
          {endereco ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-gray-800 dark:text-gray-200">{endereco}</span>
              <button type="button" onClick={copiarEndereco} className="inline-flex items-center gap-1 border border-gray-300 px-2 py-1 text-xs font-semibold text-gray-700 hover:border-blue-500 dark:border-gray-700 dark:text-gray-200"><Copy size={12} /> Copiar</button>
              <p className="w-full text-xs text-gray-500 dark:text-gray-400">Passe este endereço para os seus clientes: o login já abre com a sua marca.</p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Você ainda não tem endereço próprio. Peça para a Onion (exemplo: suaagencia.{dominioRaiz}).</p>
          )}
        </section>
      )}
      <form onSubmit={salvar} className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="grid gap-5 p-5 md:grid-cols-2">
          {CAMPOS.map(([key, label, type, placeholder]) => (
            <div key={key}>
              <label htmlFor={`marca-${key}`} className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-gray-300">{label}</label>
              <input id={`marca-${key}`} type={type} disabled={carregando} value={marca[key] || ''} placeholder={placeholder} onChange={(e) => setMarca({ ...marca, [key]: e.target.value })} className={campo} />
            </div>
          ))}
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-gray-300">Cor principal</span>
            <span className="flex items-center gap-3">
              <input id="marca-primaryColor" type="color" aria-label="Cor principal" disabled={carregando} value={marca.primaryColor || '#155dfc'} onChange={(e) => setMarca({ ...marca, primaryColor: e.target.value })} className="h-10 w-14 cursor-pointer border border-gray-300 bg-transparent p-0.5 dark:border-gray-700" />
              <span className="font-mono text-xs text-gray-500">{marca.primaryColor || 'Padrão'}</span>
              {marca.primaryColor ? <button type="button" onClick={() => setMarca({ ...marca, primaryColor: '' })} className="text-xs font-semibold text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Usar padrão</button> : null}
            </span>
          </div>
        </div>
        <div className="flex justify-end border-t border-gray-200 p-4 dark:border-gray-800">
          <button type="submit" disabled={salvando || carregando} className="inline-flex items-center gap-2 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {salvando ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Salvar marca
          </button>
        </div>
      </form>
    </div>
  );
};

export default PartnerBrand;
