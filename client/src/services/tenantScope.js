export const routeTenantId = (pathname = '') => {
  const match = pathname.match(/^\/tenant\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
};

export const resolveTenantId = ({ pathname, user, selectedTenant }) => {
  // Parceiro: dentro de um cliente da carteira (rota /tenant/:id ou cliente
  // escolhido no painel); nas telas /parceiro, fora de qualquer cliente.
  if (user?.role === 'PARTNER') {
    const routeId = routeTenantId(pathname);
    if (routeId) return routeId;
    if (String(pathname || '').startsWith('/parceiro')) return null;
    return selectedTenant?.id && selectedTenant.id !== 'super_admin' ? selectedTenant.id : null;
  }
  if (user && user.role !== 'SUPER_ADMIN') return user.tenantId || null;
  const routeId = routeTenantId(pathname);
  if (routeId && routeId !== 'super_admin') return routeId;
  return selectedTenant?.id && selectedTenant.id !== 'super_admin' ? selectedTenant.id : null;
};
