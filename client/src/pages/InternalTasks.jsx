import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';
import AgentTasks from '../components/AgentTasks';

export default function InternalTasks() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { tenantId: routeTenant } = useParams();
  const tenantId = user.role === 'SUPER_ADMIN' ? (routeTenant || tenant?.id) : user.tenantId;
  if (!['ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(user.role)) return <p>Acesso restrito a administracao.</p>;
  if (!tenantId || tenantId === 'super_admin') return <p>Selecione um tenant para consultar tarefas.</p>;
  return <div className="internal-tasks-page"><AgentTasks key={`${tenantId}:${user.id}`} tenantId={tenantId} user={user} /></div>;
}
