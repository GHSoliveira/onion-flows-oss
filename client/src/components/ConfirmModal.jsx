import { Check, X, Info, AlertTriangle, Loader2 } from 'lucide-react';

const ConfirmModal = ({ isOpen, title, message, onConfirm, onCancel, confirmText = 'Confirmar', cancelText = 'Cancelar', type = 'danger' }) => {
  if (!isOpen) return null;

  const types = {
    danger: {
      icon: AlertTriangle,
      iconColor: 'text-red-500',
      confirmClass: 'bg-red-500 hover:bg-red-600 text-white',
    },
    warning: {
      icon: Info,
      iconColor: 'text-yellow-500',
      confirmClass: 'bg-yellow-500 hover:bg-yellow-600 text-white',
    },
    info: {
      icon: Info,
      iconColor: 'text-blue-500',
      confirmClass: 'bg-blue-500 hover:bg-blue-600 text-white',
    },
    success: {
      icon: Check,
      iconColor: 'text-green-500',
      confirmClass: 'bg-green-500 hover:bg-green-600 text-white',
    },
  };

  const { Icon, iconColor, confirmClass } = types[type];

  return (
    <div className="ui-overlay-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="ui-modal-surface bg-card border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-2 rounded-full bg-${type === 'danger' ? 'red' : type === 'warning' ? 'yellow' : type === 'success' ? 'green' : 'blue'}-100 dark:bg-${type === 'danger' ? 'red' : type === 'warning' ? 'yellow' : type === 'success' ? 'green' : 'blue'}-900/20`}>
              <Icon className={`w-6 h-6 ${iconColor}`} />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-text-primary mb-2">{title}</h3>
              <p className="text-text-secondary text-sm">{message}</p>
            </div>
          </div>

          <div className="flex gap-3 justify-end mt-6">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              {cancelText}
            </button>
            <button
              onClick={onConfirm}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${confirmClass}`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
