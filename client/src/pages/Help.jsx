import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Mail, MessageCircle, Minus, Plus, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import { useBrand, supportWhatsappLink } from '../context/BrandingContext';
import { useAuth } from '../context/AuthContext';
import { contato, grupos, textoDoItem } from '../docs/ajuda';

// Pagina de ajuda do usuario final. A documentacao em /docs e tecnica e serve
// para quem implanta; aqui a pergunta vem na lingua de quem esta com o
// problema na frente, e cada resposta cabe em poucas linhas.

const destinoDoPainel = (role) => {
  if (role === 'SUPER_ADMIN') return '/super-admin';
  if (role === 'PARTNER') return '/parceiro';
  if (role === 'AGENT') return '/agent';
  if (role === 'MANAGER') return '/analytics';
  return '/monitor';
};

const Resposta = ({ item }) => (
  <div className="pb-5 pl-7 pr-2 text-[14px] leading-7 text-slate-600 dark:text-slate-300">
    {(item.paragrafos || []).map((texto) => <p key={texto} className="mt-3 first:mt-0">{texto}</p>)}
    {item.passos && (
      <ol className="mt-3 border-l border-slate-200 dark:border-slate-700">
        {item.passos.map((passo, index) => (
          <li key={passo} className="grid grid-cols-[34px_1fr] py-1.5 pl-3">
            <span className="font-mono text-[11px] font-semibold text-blue-600 dark:text-blue-400">{String(index + 1).padStart(2, '0')}</span>
            <span>{passo}</span>
          </li>
        ))}
      </ol>
    )}
    {item.marcadores && (
      <ul className="mt-3 space-y-2">
        {item.marcadores.map((texto) => (
          <li key={texto} className="grid grid-cols-[12px_1fr] gap-2">
            <span className="mt-[11px] h-1 w-1 bg-blue-600 dark:bg-blue-400" />
            <span>{texto}</span>
          </li>
        ))}
      </ul>
    )}
    {item.nota && (
      <div className="mt-4 border-l-2 border-blue-600 bg-blue-50/60 px-4 py-3 text-[13px] leading-6 text-blue-900/80 dark:bg-blue-950/30 dark:text-blue-200/80">
        {item.nota}
      </div>
    )}
  </div>
);

const Pergunta = ({ item, aberto, alternar }) => (
  <div className="border-b border-slate-200 last:border-b-0 dark:border-slate-800">
    <button
      type="button"
      onClick={alternar}
      aria-expanded={aberto}
      className="flex w-full items-start gap-3 py-4 text-left"
    >
      <span className="mt-0.5 text-blue-600 dark:text-blue-400">{aberto ? <Minus size={16} /> : <Plus size={16} />}</span>
      <span className="text-[15px] font-semibold text-slate-900 dark:text-white">{item.pergunta}</span>
    </button>
    {aberto ? <Resposta item={item} /> : null}
  </div>
);

const Help = () => {
  const brand = useBrand();
  const whatsappHref = brand.custom ? supportWhatsappLink(brand) : contato.whatsapp;
  const { user } = useAuth();
  const [busca, setBusca] = useState('');
  const [abertos, setAbertos] = useState(() => new Set());
  const buscaAdiada = useDeferredValue(busca.trim().toLowerCase());

  const resultado = useMemo(() => {
    if (!buscaAdiada) return grupos;
    return grupos
      .map((grupo) => ({ ...grupo, itens: grupo.itens.filter((item) => textoDoItem(item).includes(buscaAdiada)) }))
      .filter((grupo) => grupo.itens.length > 0);
  }, [buscaAdiada]);

  const total = resultado.reduce((soma, grupo) => soma + grupo.itens.length, 0);
  // Buscando, a resposta aparece aberta: quem procurou ja sabe o que quer ler.
  const estaAberto = (chave) => Boolean(buscaAdiada) || abertos.has(chave);
  const alternar = (chave) => setAbertos((anterior) => {
    const proximo = new Set(anterior);
    if (proximo.has(chave)) proximo.delete(chave); else proximo.add(chave);
    return proximo;
  });

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-5">
          <Link to={user ? destinoDoPainel(user.role) : '/login'} className="flex items-center gap-2.5">
            <BrandMark className="h-6 w-6" />
            <span className="text-sm font-semibold text-slate-900 dark:text-white">{brand.productName}</span>
          </Link>
          <div className="flex items-center gap-4 text-xs font-semibold">
            <Link to="/docs" className="inline-flex items-center gap-1.5 text-slate-500 transition hover:text-blue-600 dark:text-slate-400">
              <BookOpen size={14} /> Documentação
            </Link>
            <Link to={user ? destinoDoPainel(user.role) : '/login'} className="inline-flex items-center gap-1.5 text-slate-500 transition hover:text-blue-600 dark:text-slate-400">
              <ArrowLeft size={14} /> {user ? 'Voltar ao painel' : 'Entrar'}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 pb-20 pt-12">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">Ajuda</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">Como podemos ajudar?</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-600 dark:text-slate-300">
          Respostas curtas para o que mais aparece no dia a dia. Se a sua pergunta não estiver aqui, fale com a gente no fim da página.
        </p>

        <div className="relative mt-8 max-w-xl">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={busca}
            onChange={(evento) => setBusca(evento.target.value)}
            placeholder="Buscar: transferir, senha, fila, ligação..."
            aria-label="Buscar na ajuda"
            className="h-11 w-full border border-slate-200 bg-transparent pl-9 pr-3 text-sm outline-none transition focus:border-blue-500 dark:border-slate-700 dark:text-white"
          />
        </div>

        {buscaAdiada ? (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {total === 0 ? 'Nada encontrado com esse termo.' : `${total} ${total === 1 ? 'resposta encontrada' : 'respostas encontradas'}.`}
          </p>
        ) : null}

        {resultado.map((grupo) => (
          <section key={grupo.id} className="mt-12">
            <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">{grupo.titulo}</h2>
            <p className="mt-1.5 text-[13px] text-slate-500 dark:text-slate-400">{grupo.resumo}</p>
            <div className="mt-5 border-t border-slate-200 dark:border-slate-800">
              {grupo.itens.map((item) => (
                <Pergunta
                  key={item.pergunta}
                  item={item}
                  aberto={estaAberto(`${grupo.id}:${item.pergunta}`)}
                  alternar={() => alternar(`${grupo.id}:${item.pergunta}`)}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="mt-14 border border-slate-200 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900/40">
          <h2 className="text-base font-semibold text-slate-950 dark:text-white">Não resolveu?</h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-7 text-slate-600 dark:text-slate-300">
            Chame a gente e diga o que aconteceu, em qual tela e com qual cliente. Quanto mais concreto, mais rápido resolvemos.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {whatsappHref && (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700"
              >
                <MessageCircle size={15} /> Falar pelo WhatsApp
              </a>
            )}
            <a
              href={`mailto:${brand.custom ? brand.supportEmail : contato.email}`}
              className="inline-flex h-10 items-center gap-2 border border-slate-300 px-4 text-xs font-semibold text-slate-700 transition hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:text-slate-200"
            >
              <Mail size={15} /> {brand.custom ? brand.supportEmail : contato.email}
            </a>
            <Link
              to="/docs"
              className="inline-flex h-10 items-center gap-2 border border-slate-300 px-4 text-xs font-semibold text-slate-700 transition hover:border-blue-400 hover:text-blue-700 dark:border-slate-700 dark:text-slate-200"
            >
              <BookOpen size={15} /> Documentação completa
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Help;
