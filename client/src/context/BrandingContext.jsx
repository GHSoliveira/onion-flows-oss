import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../services/api';
import { initialFaviconUrl } from '../utils/brandInitial';
import { useAuth } from './AuthContext';
import { contatoSuporte, dominioRaiz } from '../config/instancia';

// Marca do painel (white label). Vem de /branding (aba Identidade do tenant) e
// fica guardada no navegador: a tela de login, que ainda nao sabe de que
// empresa e quem vai entrar, mostra a ultima marca usada aqui.
const STORAGE_KEY = 'brand:v1';
const ROOT_DOMAIN = dominioRaiz;

// Endereco proprio de agencia (agencia.<VITE_ROOT_DOMAIN>). O endereco principal e o
// da API ficam de fora; o servidor confere o resto.
const agencyHost = () => {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname.toLowerCase();
  if (!host.endsWith(`.${ROOT_DOMAIN}`)) return null;
  const sub = host.slice(0, -(ROOT_DOMAIN.length + 1));
  return sub && !sub.includes('.') && !['flows', 'www', 'api-dev'].includes(sub) ? host : null;
};
const DEFAULT_FAVICON = '/favicon-32.png?v=1';

export const DEFAULT_BRAND = Object.freeze({
  productName: 'Onion Flows',
  organizationName: null,
  logoUrl: null,
  faviconUrl: null,
  loginImageUrl: null,
  primaryColor: null,
  supportEmail: contatoSuporte.email,
  supportWhatsapp: contatoSuporte.whatsapp,
  custom: false
});

// Tons do azul do Tailwind (as classes leem --color-blue-*) refeitos a partir
// da cor da marca: claros misturam com branco, escuros com preto.
const SHADES = {
  50: [8, 'white'], 100: [15, 'white'], 200: [30, 'white'], 300: [50, 'white'], 400: [72, 'white'],
  500: [88, 'white'], 600: [100, null], 700: [82, 'black'], 800: [66, 'black'], 900: [52, 'black'], 950: [36, 'black']
};

const readCache = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeCache = (value) => {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // sem storage: so nao lembra a marca na proxima tela de login
  }
};

const toBrand = (remote) => {
  if (!remote) return DEFAULT_BRAND;
  return {
    productName: remote.productName || DEFAULT_BRAND.productName,
    organizationName: remote.organizationName || null,
    logoUrl: remote.logoUrl || null,
    faviconUrl: remote.faviconUrl || null,
    loginImageUrl: remote.loginImageUrl || null,
    primaryColor: /^#[0-9a-fA-F]{6}$/.test(String(remote.primaryColor || '')) ? remote.primaryColor : null,
    supportEmail: remote.supportEmail || DEFAULT_BRAND.supportEmail,
    supportWhatsapp: remote.supportWhatsapp || DEFAULT_BRAND.supportWhatsapp,
    custom: Boolean(remote.source) && remote.source !== 'default'
  };
};

const applyBrandToDocument = (brand) => {
  const root = document.documentElement;
  Object.entries(SHADES).forEach(([shade, [percent, mixWith]]) => {
    const property = `--color-blue-${shade}`;
    if (!brand.primaryColor) root.style.removeProperty(property);
    else root.style.setProperty(property, mixWith ? `color-mix(in oklab, ${brand.primaryColor} ${percent}%, ${mixWith})` : brand.primaryColor);
  });
  const icon = document.querySelector('link[rel="icon"]');
  // Marca de agencia sem icone proprio: o logo dela ou a inicial, nunca a cebola.
  if (icon) icon.href = brand.faviconUrl || (brand.custom ? (brand.logoUrl || initialFaviconUrl(brand.productName, brand.primaryColor)) : DEFAULT_FAVICON);
};

const BrandingContext = createContext({ brand: DEFAULT_BRAND, refresh: () => {} });

export const BrandingProvider = ({ children }) => {
  const { user } = useAuth();
  // Super admin nunca abre com a marca guardada de outro usuario deste navegador.
  const [remote, setRemote] = useState(() => (user?.role === 'SUPER_ADMIN' ? null : readCache()));
  const userId = user?.id || null;
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  // Parceiro entrando e saindo de clientes troca de marca.
  const scopeTenantId = user?.tenantId || null;

  const refresh = useCallback(async () => {
    // Sem login, no endereco da agencia: a marca vem do dono do endereco.
    if (!userId) {
      const host = agencyHost();
      if (!host) return;
      try {
        const res = await apiRequest(`/branding/public?host=${encodeURIComponent(host)}`);
        if (!res?.ok) return;
        const data = await res.json();
        setRemote(data);
        writeCache(data);
      } catch {
        // mantem a ultima marca conhecida
      }
      return;
    }
    // O painel global da Onion fica sempre com a marca da Onion.
    if (isSuperAdmin) {
      setRemote(null);
      writeCache(null);
      return;
    }
    try {
      const res = await apiRequest('/branding');
      if (!res?.ok) return;
      const data = await res.json();
      setRemote(data);
      writeCache(data);
    } catch {
      // mantem a ultima marca conhecida
    }
  }, [userId, isSuperAdmin, scopeTenantId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener('brand:changed', onChanged);
    return () => window.removeEventListener('brand:changed', onChanged);
  }, [refresh]);

  const brand = useMemo(() => toBrand(remote), [remote]);
  useEffect(() => { applyBrandToDocument(brand); }, [brand]);

  const value = useMemo(() => ({ brand, refresh }), [brand, refresh]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
};

export const useBrand = () => useContext(BrandingContext).brand;

// Link do WhatsApp de suporte com a mensagem ja preenchida.
export const supportWhatsappLink = (brand) => (
  brand.supportWhatsapp
    ? `https://wa.me/${brand.supportWhatsapp}?text=${encodeURIComponent(`Olá! Preciso de ajuda com o ${brand.productName}.`)}`
    : null
);
