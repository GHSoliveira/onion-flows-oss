// Constantes das telas de administracao (separadas dos componentes em OpsKit.jsx
// para o fast refresh do Vite continuar funcionando).

// Deslocamento da cascata de entrada; passa de 14 itens e o fim da lista demora demais.
export const reveal = (index) => ({ '--i': Math.min(index, 14) });

export const PAYMENT_TONE = {
  paid: { tone: 'ok', label: 'Pago' },
  open: { tone: 'warn', label: 'Em aberto' },
  overdue: { tone: 'bad', label: 'Vencido' }
};

export const TENANT_STATUS_TONE = {
  active: { tone: 'ok', label: 'Ativo' },
  trial: { tone: 'warn', label: 'Trial' },
  suspended: { tone: 'bad', label: 'Suspenso' }
};

export const PLAN_LABEL = { basic: 'Basic', pro: 'PRO', premium: 'Premium' };
