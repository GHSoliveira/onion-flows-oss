import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, LogIn, User } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { API_BASE } from '../services/api';
import ClickSpark from '../components/login-kit/ClickSpark';
import NetworkGlobe from '../components/login-kit/NetworkGlobe';
import OnionLoader from '../components/login-kit/OnionLoader';
import BrandMark from '../components/BrandMark';
import { useBrand } from '../context/BrandingContext';
import SpecularButton from '../components/login-kit/SpecularButton';
import './Login.css';

const APPEARANCES = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
];

const getLoginDestination = (role) => {
  if (role === 'SUPER_ADMIN') return '/super-admin';
  if (role === 'PARTNER') return '/parceiro';
  if (role === 'AGENT') return '/agent';
  if (role === 'MANAGER') return '/analytics';
  return '/monitor';
};

// Mistura a cor da marca com branco (0 a 1) para o brilho do botao, que pede hex.
const clarear = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const canal = (shift) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * amount);
  return `#${[16, 8, 0].map((shift) => canal(shift).toString(16).padStart(2, '0')).join('')}`;
};

const Login = () => {
  const brand = useBrand();
  // Imagem propria da marca no lugar do planeta; link quebrado volta ao planeta.
  const [imagemFalhou, setImagemFalhou] = useState(false);
  useEffect(() => { setImagemFalhou(false); }, [brand.loginImageUrl]);
  const [form, setForm] = useState({ username: '', password: '' });
  const [appearance, setAppearance] = useState(() => localStorage.getItem('appearancePreference') || 'system');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyAppearance = () => {
      const dark = appearance === 'dark' || (appearance === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      localStorage.setItem('appearancePreference', appearance);
    };
    applyAppearance();
    if (appearance === 'system') media.addEventListener('change', applyAppearance);
    return () => media.removeEventListener('change', applyAppearance);
  }, [appearance]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.username || !form.password || loading) return;
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.trim(), password: form.password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Usuario ou senha incorretos.');
      if (!data?.user || !data?.token) throw new Error('Resposta invalida do servidor.');

      setTransitioning(true);
      login(data.user, data.token);
      toast.success(`Bem-vindo, ${data.user.name}!`, { duration: 3000 });
      navigate(getLoginDestination(data.user.role));
    } catch (reason) {
      const message = reason?.message || 'Erro ao conectar. Tente novamente.';
      console.error('Erro no login:', reason);
      setError(message);
      toast.error(message);
      setLoading(false);
    }
  };

  if (transitioning) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-white dark:bg-slate-900">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.09),transparent_36%)]" />
        <OnionLoader size={108} label="Preparando seu espaco" />
      </main>
    );
  }

  return (
    <ClickSpark sparkColor={brand.primaryColor || '#3b82f6'} sparkSize={6} sparkRadius={14} sparkCount={6} duration={320}>
      <main className="grid min-h-screen bg-white dark:bg-slate-900 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="relative hidden overflow-hidden bg-[#0b1f46] p-12 text-white lg:flex lg:flex-col xl:p-16">
          {brand.loginImageUrl && !imagemFalhou ? (
            <>
              <img src={brand.loginImageUrl} alt="" onError={() => setImagemFalhou(true)} className="absolute inset-0 h-full w-full object-cover" />
              {/* Escurece a foto para o texto branco continuar legivel. */}
              <div className="absolute inset-0 bg-gradient-to-b from-[#0b1f46]/80 via-[#0b1f46]/35 to-[#0b1f46]/85" />
            </>
          ) : (
            <NetworkGlobe />
          )}
          <div className="relative flex items-center gap-3">
            <BrandMark color="#fff" className="h-12 w-12" />
            <strong className="text-base font-semibold">{brand.productName}</strong>
          </div>
          <div className="relative mt-16 max-w-sm">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-300">Aparencia</span>
            <div className="mt-4 flex gap-7 border-b border-white/15">
              {APPEARANCES.map((item) => (
                <button key={item.value} type="button" onClick={() => setAppearance(item.value)} className={`-mb-px border-b-2 pb-3 text-xs font-semibold transition ${appearance === item.value ? 'border-white text-white' : 'border-transparent text-blue-200/65 hover:text-white'}`}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <nav className="relative mt-auto flex flex-wrap gap-x-6 gap-y-2 border-t border-white/15 pt-5 text-[11px] font-medium text-blue-200/70" aria-label="Links institucionais">
            <a href="/privacidade" className="transition-colors hover:text-white">Privacidade</a>
            <a href={`mailto:${brand.supportEmail}`} className="transition-colors hover:text-white">Contato</a>
            <a href="/ajuda" className="transition-colors hover:text-white">Ajuda</a>
            <Link to="/docs" className="transition-colors hover:text-white">Docs</Link>
          </nav>
        </section>

        <section className="relative flex items-center justify-center bg-[linear-gradient(90deg,#f4f8ff_0%,#fff_24%,#fff_100%)] p-6 sm:p-10 lg:justify-start lg:pl-[clamp(72px,8vw,120px)] dark:bg-[linear-gradient(90deg,#1e293b_0%,#0f172a_24%,#0f172a_100%)]">
          <div className="w-full max-w-[420px]">
            <div className="mb-9">
              <BrandMark className="mb-5 h-12 w-12 lg:hidden" />
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">Acesse sua conta</h1>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Use suas credenciais da equipe {brand.productName}.</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="Usuario" icon={<User />}>
                <input autoFocus autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </Field>
              <Field label="Senha" icon={<Lock />} trailing={<button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>{showPassword ? <EyeOff /> : <Eye />}</button>}>
                <input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
              </Field>
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <SpecularButton type="submit" disabled={loading} size="md" radius={14} tint={brand.primaryColor || '#0f4fd6'} tintOpacity={1} textColor="#fff" lineColor="#eff6ff" baseColor={brand.primaryColor ? clarear(brand.primaryColor, 0.45) : '#60a5fa'} intensity={2.35} shineSize={18} shineFade={46} thickness={1.7} autoAnimate={!loading} className="min-h-[52px] w-full text-sm font-semibold">
                <span className="flex items-center justify-center gap-2">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><LogIn className="h-4 w-4" /> Entrar</>}</span>
              </SpecularButton>
            </form>
          </div>
        </section>
      </main>
    </ClickSpark>
  );
};

const Field = ({ label, icon, trailing, children }) => (
  <label className="block">
    <span className="mb-1.5 block text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</span>
    <span className="login-field relative block">
      <span className="absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-slate-400 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
      {trailing && <span className="absolute right-2.5 top-1/2 z-10 -translate-y-1/2 text-slate-400 [&_button]:p-1.5 [&_svg]:h-4 [&_svg]:w-4">{trailing}</span>}
    </span>
  </label>
);

export default Login;
