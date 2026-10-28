import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import OperationalModal from '../components/OperationalModal';

const DialogContext = createContext(null);

export const DialogProvider = ({ children }) => {
  const [confirmState, setConfirmState] = useState(null);
  const [promptState, setPromptState] = useState(null);
  const confirmResolverRef = useRef(null);
  const promptResolverRef = useRef(null);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    confirmResolverRef.current = resolve;
    setConfirmState({
      title: opts.title || 'Confirmar ação',
      message: opts.message || 'Tem certeza?',
      confirmText: opts.confirmText || 'Confirmar',
      cancelText: opts.cancelText || 'Cancelar',
      type: opts.type || 'danger',
    });
  }), []);

  const prompt = useCallback((opts = {}) => new Promise((resolve) => {
    promptResolverRef.current = resolve;
    setPromptState({
      title: opts.title || 'Digite o valor',
      message: opts.message || '',
      placeholder: opts.placeholder || '',
      defaultValue: opts.defaultValue || '',
      confirmText: opts.confirmText || 'Confirmar',
      cancelText: opts.cancelText || 'Cancelar',
      type: opts.type || 'info',
      required: opts.required !== false,
    });
  }), []);

  const closeConfirm = (result) => {
    if (confirmResolverRef.current) confirmResolverRef.current(result);
    confirmResolverRef.current = null;
    setConfirmState(null);
  };

  const closePrompt = (result) => {
    if (promptResolverRef.current) promptResolverRef.current(result);
    promptResolverRef.current = null;
    setPromptState(null);
  };

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {confirmState && <ConfirmDialog {...confirmState} onClose={closeConfirm} />}
      {promptState && <PromptDialog {...promptState} onClose={closePrompt} />}
    </DialogContext.Provider>
  );
};

const ConfirmDialog = ({ title, message, confirmText, cancelText, type, onClose }) => {
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose(false);
      if (e.key === 'Enter') onClose(true);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <OperationalModal
      open
      size="sm"
      context={type === 'danger' ? 'Confirmacao necessaria' : 'Confirmar operacao'}
      title={title}
      description={message}
      onClose={() => onClose(false)}
      footer={(
        <div className="flex justify-end gap-2">
          <button onClick={() => onClose(false)} className="h-9 border border-slate-300 px-4 text-sm font-medium text-slate-600 transition hover:border-slate-500 dark:border-slate-700 dark:text-slate-300">{cancelText}</button>
          <button onClick={() => onClose(true)} className="h-9 bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700" autoFocus>{confirmText}</button>
        </div>
      )}
    >
      <div className="px-5 py-6 text-sm leading-6 text-slate-600 dark:text-slate-300">Revise a operacao antes de continuar.</div>
    </OperationalModal>
  );
};

const PromptDialog = ({ title, message, placeholder, defaultValue, confirmText, cancelText, type, required, onClose }) => {
  const [value, setValue] = useState(defaultValue || '');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = String(value || '').trim();
    if (required && !trimmed) return;
    onClose(trimmed);
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') onClose(null);
    if (e.key === 'Enter') submit();
  };

  return (
    <OperationalModal
      open
      size="sm"
      context="Entrada de dados"
      title={title}
      description={message}
      onClose={() => onClose(null)}
      footer={(
        <div className="flex justify-end gap-2">
          <button onClick={() => onClose(null)} className="h-9 border border-slate-300 px-4 text-sm font-medium text-slate-600 transition hover:border-slate-500 dark:border-slate-700 dark:text-slate-300">{cancelText}</button>
          <button onClick={submit} disabled={required && !String(value || '').trim()} className="h-9 bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">{confirmText}</button>
        </div>
      )}
    >
        <div className="p-5">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />
        </div>
    </OperationalModal>
  );
};

export const useDialog = () => {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog deve ser usado dentro de DialogProvider');
  return ctx;
};
