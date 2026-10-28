import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight, Copy, LockKeyhole, Menu, Search, X } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import OnionMark from '../components/login-kit/OnionMark';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../services/api';
import { defaultDocsSlug, docsPages, getDocsPage, restrictedDocsIndex } from '../docs/content';

const textFromSection = (section) => [
  section.title,
  ...(section.paragraphs || []),
  ...(section.bullets || []),
  ...(section.steps || []),
  ...(section.table?.headers || []),
  ...(section.table?.rows || []).flat(),
  section.note?.title,
  section.note?.text,
  section.code?.value,
].filter(Boolean).join(' ');

const slugFromPath = (pathname) => {
  const value = pathname.replace(/^\/docs\/?/, '').split('/').filter(Boolean).at(-1);
  return value || defaultDocsSlug;
};

const platformDestination = (role) => {
  if (role === 'SUPER_ADMIN') return '/super-admin';
  if (role === 'PARTNER') return '/parceiro';
  if (role === 'AGENT') return '/agent';
  if (role === 'MANAGER') return '/analytics';
  return '/monitor';
};

const CodeBlock = ({ language, value }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-5 overflow-hidden border border-slate-800 bg-slate-950">
      <div className="flex h-9 items-center justify-between border-b border-slate-800 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        <span>{language || 'text'}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-slate-400 transition hover:text-white">
          {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[12px] leading-6 text-slate-200"><code>{value}</code></pre>
    </div>
  );
};

const DataTable = ({ data }) => (
  <div className="my-5 overflow-x-auto border-y border-slate-200">
    <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
      <thead>
        <tr className="bg-slate-50 text-[10px] uppercase tracking-[0.13em] text-slate-500">
          {data.headers.map((header) => <th key={header} className="border-b border-slate-200 px-3 py-3 font-semibold">{header}</th>)}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.rows.map((row, rowIndex) => (
          <tr key={`${rowIndex}-${row[0]}`} className="align-top text-slate-600">
            {row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`} className={`px-3 py-3.5 leading-5 ${cellIndex === 0 ? 'font-semibold text-slate-900' : ''}`}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const ArticleSection = ({ section, index }) => (
  <motion.section
    id={`secao-${index}`}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.24, delay: Math.min(index * 0.035, 0.18), ease: [0.22, 1, 0.36, 1] }}
    className="scroll-mt-24 border-t border-slate-200 py-9 first:border-t-0 first:pt-0"
  >
    <h2 className="text-lg font-semibold tracking-tight text-slate-950">{section.title}</h2>
    {(section.paragraphs || []).map((paragraph) => <p key={paragraph} className="mt-4 max-w-3xl text-[14px] leading-7 text-slate-600">{paragraph}</p>)}
    {section.bullets && <ul className="mt-4 max-w-3xl space-y-2.5 text-[14px] leading-6 text-slate-600">{section.bullets.map((item) => <li key={item} className="grid grid-cols-[12px_1fr] gap-2"><span className="mt-[10px] h-1 w-1 bg-blue-600" /><span>{item}</span></li>)}</ul>}
    {section.steps && <ol className="mt-5 max-w-3xl border-l border-slate-200">{section.steps.map((item, stepIndex) => <li key={item} className="grid grid-cols-[34px_1fr] py-2.5 pl-4 text-[14px] leading-6 text-slate-600"><span className="font-mono text-[11px] font-semibold text-blue-600">{String(stepIndex + 1).padStart(2, '0')}</span><span>{item}</span></li>)}</ol>}
    {section.table && <DataTable data={section.table} />}
    {section.code && <CodeBlock {...section.code} />}
    {section.note && <div className="my-5 max-w-3xl border-l-2 border-blue-600 bg-blue-50/60 px-4 py-3"><strong className="block text-xs font-semibold text-blue-900">{section.note.title}</strong><p className="mt-1 text-[13px] leading-6 text-blue-900/75">{section.note.text}</p></div>}
  </motion.section>
);

const AccessGate = ({ metadata, user, loading, error }) => {
  const superAdminOnly = metadata?.access === 'super_admin';
  let title = 'Conteúdo protegido';
  let message = 'Entre na plataforma para consultar esta seção operacional.';

  if (loading) {
    title = 'Validando acesso';
    message = 'A documentação protegida está sendo carregada conforme seu papel.';
  } else if (error) {
    title = 'Não foi possível carregar';
    message = error;
  } else if (user && superAdminOnly) {
    title = 'Acesso interno';
    message = 'Esta seção exige uma sessão SUPER_ADMIN válida. O conteúdo não é incluído no bundle público.';
  } else if (user) {
    title = 'Acesso indisponível';
    message = 'Seu usuário não possui acesso a esta seção.';
  }

  return (
    <div className="border-y border-slate-200 py-14">
      <LockKeyhole size={22} className="text-blue-600" />
      <h2 className="mt-5 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-3 max-w-xl text-[14px] leading-7 text-slate-500">{message}</p>
      {!user && !loading && <Link to="/login" className="mt-6 inline-flex h-10 items-center border border-blue-600 px-4 text-xs font-semibold text-blue-700 transition hover:bg-blue-50">Acessar plataforma</Link>}
    </div>
  );
};

const Documentation = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [protectedPages, setProtectedPages] = useState([]);
  const [protectedLoading, setProtectedLoading] = useState(false);
  const [protectedError, setProtectedError] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const requestedSlug = slugFromPath(location.pathname);

  useEffect(() => {
    let active = true;
    if (!user) {
      setProtectedPages([]);
      setProtectedLoading(false);
      setProtectedError('');
      return () => { active = false; };
    }

    setProtectedLoading(true);
    setProtectedError('');
    apiRequest('/documentation')
      .then(async (response) => {
        if (!response?.ok) throw new Error('A documentação protegida não está disponível no momento.');
        const payload = await response.json();
        if (active) setProtectedPages(Array.isArray(payload?.pages) ? payload.pages : []);
      })
      .catch((reason) => {
        if (active) {
          setProtectedPages([]);
          setProtectedError(reason?.message || 'Falha ao validar o acesso à documentação.');
        }
      })
      .finally(() => {
        if (active) setProtectedLoading(false);
      });

    return () => { active = false; };
  }, [user?.id, user?.role]);

  const allPages = useMemo(() => [...docsPages, ...protectedPages], [protectedPages]);
  const restrictedMetadata = restrictedDocsIndex.find((item) => item.slug === requestedSlug) || null;
  const currentPage = allPages.find((item) => item.slug === requestedSlug)
    || (restrictedMetadata ? null : getDocsPage(requestedSlug));
  const displayPage = currentPage || {
    slug: restrictedMetadata?.slug || requestedSlug,
    group: restrictedMetadata?.group || 'Documentação',
    title: restrictedMetadata?.title || 'Página não encontrada',
    summary: restrictedMetadata ? 'O acesso a esta seção depende da sua sessão e do seu papel.' : 'O conteúdo solicitado não está disponível.',
    sections: [],
  };

  const visibleGroups = useMemo(() => [...new Set(allPages.map((item) => item.group))], [allPages]);
  const results = useMemo(() => {
    if (!deferredQuery) return [];
    return allPages.filter((item) => {
      const haystack = [item.title, item.summary, item.group, ...item.sections.map(textFromSection)].join(' ').toLowerCase();
      return haystack.includes(deferredQuery);
    }).slice(0, 8);
  }, [allPages, deferredQuery]);

  useEffect(() => {
    document.title = `${displayPage.title} - Documentação Onion Flows`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    setMobileNavOpen(false);
    setQuery('');
  }, [displayPage.slug]);

  const openPage = (slug) => navigate(`/docs/${slug}`);

  const Navigation = () => (
    <nav aria-label="Documentação" className="space-y-7 pb-10">
      {visibleGroups.map((group) => (
        <div key={group}>
          <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{group}</div>
          <div className="space-y-0.5">
            {allPages.filter((item) => item.group === group).map((item) => (
              <Link
                key={item.slug}
                to={`/docs/${item.slug}`}
                className={`flex min-h-8 items-center border-l-2 px-3 text-[12px] transition ${item.slug === displayPage.slug ? 'border-blue-600 bg-blue-50 font-semibold text-blue-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'}`}
              >
                {item.title}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="fixed inset-x-0 top-0 z-50 h-16 border-b border-slate-200 bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-[1580px] items-center gap-5 px-4 sm:px-6">
          <Link to="/docs/inicio" className="flex shrink-0 items-center gap-2.5" aria-label="Onion Flows Docs">
            <OnionMark className="h-7 w-7" label="Onion Flows" />
            <span className="text-sm font-semibold tracking-tight">Onion Flows</span>
            <span className="border-l border-slate-200 pl-2 text-[11px] font-medium text-slate-400">Docs</span>
          </Link>

          <div className="relative ml-auto w-full max-w-lg">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar na documentação" className="h-9 w-full border border-slate-200 bg-slate-50 pl-9 pr-9 text-[12px] outline-none transition focus:border-blue-500 focus:bg-white" />
            {query && <button type="button" onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-900"><X size={14} /></button>}
            <AnimatePresence>
              {deferredQuery && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="absolute left-0 right-0 top-11 border border-slate-200 bg-white shadow-2xl shadow-slate-900/10">
                  {results.length ? results.map((item) => <button type="button" key={item.slug} onClick={() => openPage(item.slug)} className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-b-0 hover:bg-slate-50"><span><strong className="block text-[12px] text-slate-900">{item.title}</strong><span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-400">{item.summary}</span></span><ChevronRight size={14} className="shrink-0 text-slate-300" /></button>) : <div className="px-4 py-6 text-center text-xs text-slate-400">Nenhum conteúdo encontrado.</div>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="hidden shrink-0 items-center gap-4 text-[11px] font-medium text-slate-500 md:flex">
            <Link to="/privacidade" className="hover:text-slate-950">Privacidade</Link>
            <Link to={user ? platformDestination(user.role) : '/login'} className="text-blue-600 hover:text-blue-800">{user ? 'Voltar à plataforma' : 'Acessar plataforma'}</Link>
          </div>
          <button type="button" onClick={() => setMobileNavOpen(true)} className="grid h-9 w-9 shrink-0 place-items-center border border-slate-200 text-slate-600 lg:hidden" aria-label="Abrir navegação"><Menu size={17} /></button>
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-16 hidden w-[270px] overflow-y-auto border-r border-slate-200 bg-white px-4 pt-7 lg:block xl:w-[300px]">
        <Navigation />
      </aside>

      <AnimatePresence>
        {mobileNavOpen && <motion.div className="fixed inset-0 z-[80] bg-slate-950/30 backdrop-blur-sm lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && setMobileNavOpen(false)}><motion.aside initial={{ x: -320 }} animate={{ x: 0 }} exit={{ x: -320 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="h-full w-[min(88vw,320px)] overflow-y-auto bg-white p-4 shadow-2xl"><div className="mb-6 flex h-10 items-center justify-between border-b border-slate-200"><span className="text-xs font-semibold">Documentação</span><button type="button" onClick={() => setMobileNavOpen(false)}><X size={17} /></button></div><Navigation /></motion.aside></motion.div>}
      </AnimatePresence>

      <main className="pt-16 lg:pl-[270px] xl:pl-[300px]">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-14 px-5 py-12 sm:px-9 lg:grid-cols-[minmax(0,780px)_180px] lg:px-12 lg:py-16">
          <article className="min-w-0">
            <motion.header key={`${displayPage.slug}-header`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="mb-10 border-b border-slate-200 pb-10">
              <div className="text-[10px] font-semibold uppercase tracking-[0.17em] text-blue-600">{displayPage.group}</div>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-[40px] sm:leading-[1.1]">{displayPage.title}</h1>
              <p className="mt-5 max-w-2xl text-[15px] leading-7 text-slate-500">{displayPage.summary}</p>
            </motion.header>

            {currentPage
              ? <div key={currentPage.slug}>{currentPage.sections.map((section, index) => <ArticleSection key={`${currentPage.slug}-${section.title}`} section={section} index={index} />)}</div>
              : <AccessGate metadata={restrictedMetadata} user={user} loading={protectedLoading} error={protectedError} />}

            <footer className="mt-10 border-t border-slate-200 py-8 text-[11px] leading-5 text-slate-400">
              Documentação baseada no comportamento atual da aplicação. Recursos de provedores externos podem mudar sem aviso.
            </footer>
          </article>

          {currentPage && <aside className="sticky top-24 hidden h-fit border-l border-slate-200 pl-5 lg:block">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400">Nesta página</div>
            <div className="space-y-2.5">{currentPage.sections.map((section, index) => <a key={section.title} href={`#secao-${index}`} className="block text-[11px] leading-4 text-slate-400 transition hover:text-blue-600">{section.title}</a>)}</div>
          </aside>}
        </div>
      </main>
    </div>
  );
};

export default Documentation;