import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

const widths = {
  sm: 'max-w-xl',
  md: 'max-w-3xl',
  lg: 'max-w-5xl',
  xl: 'max-w-6xl'
};

const OperationalModal = ({
  open,
  title,
  description,
  context,
  onClose,
  children,
  footer = null,
  size = 'lg',
  bodyClassName = ''
}) => {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/55 p-0 sm:p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose?.();
          }}
        >
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`flex max-h-[100dvh] w-full flex-col border border-slate-300 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950 sm:max-h-[92dvh] ${widths[size] || widths.lg}`}
            initial={{ opacity: 0, y: 12, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.995 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex shrink-0 items-start justify-between gap-6 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-950 sm:px-6">
              <div className="min-w-0">
                {context && <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">{context}</div>}
                <h2 className="truncate text-base font-semibold text-slate-950 dark:text-slate-50">{title}</h2>
                {description && <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
              </div>
              <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center border border-slate-200 text-slate-500 transition hover:border-slate-400 hover:text-slate-950 dark:border-slate-700 dark:text-slate-400 dark:hover:text-white" aria-label="Fechar">
                <X size={16} />
              </button>
            </header>

            <div className={`min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 ${bodyClassName}`}>
              <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                {children}
              </div>
            </div>

            {footer && <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6">{footer}</footer>}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default OperationalModal;
