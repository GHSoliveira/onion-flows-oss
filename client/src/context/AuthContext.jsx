import { createContext, useState, useContext, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveTenantId } from '../services/tenantScope';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { setErrorTrackingUser } from '../services/errorTracking';

const AuthContext = createContext();
const HEARTBEAT_INTERVAL_MS = Number(import.meta.env?.VITE_AUTH_HEARTBEAT_INTERVAL_MS || 60000);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(() => {
        const saved = localStorage.getItem('user');
        try {
            return saved ? JSON.parse(saved) : null;
        } catch {
            return null;
        }
    });

    useEffect(() => { setErrorTrackingUser(user); }, [user]);

    const login = (userData, userToken) => {
        // Parceiro comeca sempre no painel dele, sem cliente escolhido.
        if (userData?.role === 'PARTNER') localStorage.removeItem('selectedTenant');
        setUser(userData);
        localStorage.setItem('user', JSON.stringify(userData));
        localStorage.setItem('token', userToken);
    };

    const logout = async () => {
        try {
            await apiRequest('/auth/logout', { method: 'POST' });
        } catch (_) {}
        socketService.disconnect();
        setUser(null);
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        localStorage.removeItem('selectedTenant');
        window.location.href = '/login';
    };


    useEffect(() => {
        if (!user) return;

        let consecutiveErrors = 0;
        let isMounted = true;
        const maxErrors = 3;

        const beat = setInterval(async () => {
            if (!isMounted) return;

            try {
                const res = await apiRequest('/auth/heartbeat');
                if (res && res.ok) {
                    const data = await res.json();
                    if (data?.user) {
                        // So troca o objeto quando algo mudou: um usuario novo a cada
                        // batida reexecutava todo efeito que depende dele (refetch da
                        // fila e religar o tempo real a cada minuto). O heartbeat traz
                        // menos campos que o login, entao mescla em vez de substituir.
                        setUser((current) => {
                            const next = { ...(current || {}), ...data.user };
                            if (current && JSON.stringify(next) === JSON.stringify(current)) return current;
                            localStorage.setItem('user', JSON.stringify(next));
                            return next;
                        });
                    }
                }
                consecutiveErrors = 0;
            } catch (error) {
                consecutiveErrors++;
                if (consecutiveErrors >= maxErrors) {
                    console.warn('Heartbeat falhou múltiplas vezes, parando tentativas');
                    clearInterval(beat);
                }
            }
        }, Math.max(HEARTBEAT_INTERVAL_MS, 30000));

        return () => {
            isMounted = false;
            clearInterval(beat);
        };
    }, [user?.id]);

    // Parceiro dentro de um cliente da carteira: para as telas ele e ADMIN
    // daquele tenant, como o servidor o trata. partnerUser guarda quem ele e.
    const location = useLocation();
    let selectedTenant = null;
    try { selectedTenant = JSON.parse(localStorage.getItem('selectedTenant') || 'null'); } catch { /* selecao invalida */ }
    const actingTenantId = user?.role === 'PARTNER'
        ? resolveTenantId({ pathname: location.pathname, user, selectedTenant })
        : null;
    const effectiveUser = useMemo(
        () => (actingTenantId ? { ...user, role: 'ADMIN', tenantId: actingTenantId, actingAsPartner: true } : user),
        [user, actingTenantId]
    );
    const partnerUser = user?.role === 'PARTNER' ? user : null;

    return (
        <AuthContext.Provider value={{ user: effectiveUser, partnerUser, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuth deve ser usado dentro de um AuthProvider");
    return context;
};
