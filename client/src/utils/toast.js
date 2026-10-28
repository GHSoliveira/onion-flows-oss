import toast from 'react-hot-toast';

const toastConfig = {
  duration: 4000,
  position: 'top-right',
  style: {
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    padding: '12px 16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  },
  success: {
    iconTheme: {
      primary: '#10b981',
      secondary: '#fff',
    },
  },
  error: {
    iconTheme: {
      primary: '#ef4444',
      secondary: '#fff',
    },
  },
  loading: {
    iconTheme: {
      primary: '#3b82f6',
      secondary: '#fff',
    },
  },
};

const showToast = {
  success: (message) => toast.success(message, toastConfig),
  error: (message) => toast.error(message, toastConfig),
  info: (message) => toast(message, toastConfig),
  loading: (message) => toast.loading(message, toastConfig),
  promise: (promise, { loading, success, error }) =>
    toast.promise(promise, {
      loading: loading || 'Carregando...',
      success: success || 'Sucesso!',
      error: error || 'Erro ao processar',
    }, toastConfig),
  dismiss: (toastId) => toast.dismiss(toastId),
  dismissAll: () => toast.dismiss(),
};

export default showToast;
