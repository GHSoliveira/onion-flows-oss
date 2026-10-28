import { createContext, useContext, useState, useEffect, useRef } from "react";
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { resolveTenantId } from '../services/tenantScope';
import { apiRequest } from "../services/api";

const TenantContext = createContext(null);

export const TenantProvider = ({ children }) => {
  const [tenant, setTenant] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState(null);
  const { user } = useAuth();
  const { pathname } = useLocation();
  const generation = useRef(0);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('selectedTenant') || 'null'); } catch { /* Invalid persisted selection. */ }
  const effectiveId = resolveTenantId({ pathname, user, selectedTenant: tenant || saved });
  const effectiveTenant = effectiveId
    ? (tenant?.id === effectiveId ? tenant : saved?.id === effectiveId ? saved : { id: effectiveId, name: effectiveId })
    : tenant;

  useEffect(() => {
    generation.current++;
    if (!user) { setTenant(null); setLoading(false); return; }
    // Parceiro no proprio painel: nao ha tenant atual para buscar.
    if (user.role === 'PARTNER' && !effectiveId) { setTenant(null); setLoading(false); return; }
    if (effectiveId) {
      if (user.role !== 'SUPER_ADMIN' && effectiveTenant.name === effectiveId) { fetchTenant(); return; }
      setTenant(effectiveTenant);
      localStorage.setItem('selectedTenant', JSON.stringify(effectiveTenant));
      setLoading(false);
      // Super admin entrando pela URL: o tenant chega so com o id. Busca o nome
      // real para a barra lateral e o titulo da aba.
      if (user.role === 'SUPER_ADMIN' && effectiveTenant.name === effectiveId) resolveTenantName(effectiveId);
      return;
    }
    fetchTenant();
  }, [pathname, user?.id]);

  const resolveTenantName = async (tenantId) => {
    const requestGeneration = generation.current;
    try {
      const res = await apiRequest("/tenants");
      if (!res || !res.ok) return;
      const lista = await res.json();
      const encontrado = (Array.isArray(lista) ? lista : []).find((item) => item?.id === tenantId);
      if (!encontrado?.name || requestGeneration !== generation.current) return;
      // So o basico no navegador: nada de dados de cobranca do tenant.
      const basico = {
        id: encontrado.id,
        name: encontrado.name,
        slug: encontrado.slug || null,
        plan: encontrado.plan || null,
        status: encontrado.status || null,
        environment: encontrado.environment || null
      };
      setTenant(basico);
      localStorage.setItem("selectedTenant", JSON.stringify(basico));
    } catch {
      // Sem a lista, fica o id: nao atrapalha a navegacao.
    }
  };

  const fetchTenant = async () => {
    const requestGeneration = ++generation.current;
    try {
      const res = await apiRequest("/tenant/current");
      if (res && res.ok && requestGeneration === generation.current) {
        const data = await res.json();
        if (requestGeneration !== generation.current) return;
        setTenant(data);
        setUserRole(data.role);

        localStorage.setItem("selectedTenant", JSON.stringify(data));
      }
    } catch (error) {
      console.error("Erro ao buscar tenant:", error);
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const res = await apiRequest("/tenants");
      if (res && res.ok) {
        const data = await res.json();
        setTenants(data);
      }
    } catch (error) {
      console.error("Erro ao buscar tenants:", error);
    }
  };

  const switchTenant = async (tenantId) => {
    const requestGeneration = ++generation.current;
    if (tenantId === "super_admin") {
      localStorage.removeItem("selectedTenant");
      setTenant({ id: "super_admin", name: "Super Admin", role: "SUPER_ADMIN" });
      setLoading(false);
      return;
    }
    try {
      const res = await apiRequest("/tenants/" + tenantId + "/switch", { method: "POST" });
      if (res && res.ok && requestGeneration === generation.current) {
        const data = await res.json();
        if (requestGeneration !== generation.current) return;
        localStorage.setItem("selectedTenant", JSON.stringify(data));
        setTenant(data);
      }
    } catch (error) {
      console.error("Erro ao trocar de tenant:", error);
    }
  };

  return (
    <TenantContext.Provider value={{
      tenant: effectiveTenant, tenants, loading, fetchTenant, fetchTenants, switchTenant,
      isSuperAdmin: user?.role === 'SUPER_ADMIN' || userRole === "SUPER_ADMIN"
    }}>
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) throw new Error("useTenant deve ser usado dentro de TenantProvider");
  return context;
};
