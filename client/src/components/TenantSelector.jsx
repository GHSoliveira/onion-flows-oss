import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "../context/TenantContext";
import { Building2, ChevronDown } from "lucide-react";

export default function TenantSelector() {
  const { tenant, tenants, fetchTenants, switchTenant, isSuperAdmin } = useTenant();
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();

  if (!tenant) return null;

  const handleToggle = () => {
    if (isSuperAdmin && tenants.length === 0) {
      fetchTenants();
    }
    setIsOpen(!isOpen);
  };

  const handleSelect = async (t) => {
    await switchTenant(t.id);
    setIsOpen(false);


    if (t.id === "super_admin") {
      navigate("/super-admin");
    } else {
      navigate(`/tenant/${t.id}/monitor`);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 px-3 py-2 bg-slate-100 dark:bg-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
      >
        <Building2 size={16} className="text-blue-500" />
        <span className="text-sm font-medium truncate max-w-[150px]">
          {tenant.name}
        </span>
        {isSuperAdmin && <ChevronDown size={14} className="text-slate-400" />}
      </button>

      {isOpen && isSuperAdmin && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-50 overflow-hidden">
            <div className="p-2 border-b border-slate-200 dark:border-slate-700">
              <span className="text-xs font-bold text-slate-500 uppercase">
                Selecionar Tenant
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {}
              <button
                onClick={() => handleSelect({ id: "super_admin" })}
                className={`w-full px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${
                  tenant?.id === "super_admin" ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600" : ""
                }`}
              >
                <div className="font-medium text-sm">🔑 Super Admin</div>
                <div className="text-xs text-slate-400">Acesso total ao sistema</div>
              </button>

              {}
              <div className="border-t border-slate-200 dark:border-slate-700 my-1"></div>

              {}
              {tenants.length === 0 ? (
                <div className="p-4 text-center text-slate-500 text-sm">
                  Nenhum tenant encontrado
                </div>
              ) : (
                tenants.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t)}
                    className={`w-full px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${
                      t.id === tenant.id ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600" : ""
                    }`}
                  >
                    <div className="font-medium text-sm">{t.name}</div>
                    <div className="text-xs text-slate-400">{t.slug}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
