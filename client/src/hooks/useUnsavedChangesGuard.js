import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export const useUnsavedChangesGuard = ({ when, confirm }) => {
  const navigate = useNavigate();
  const confirmationPendingRef = useRef(false);
  const dirtyRef = useRef(Boolean(when));

  useEffect(() => {
    dirtyRef.current = Boolean(when);
  }, [when]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const handleNavigationClick = (event) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('download') || anchor.target === '_blank') return;

      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (destination.origin !== current.origin) return;
      if (`${destination.pathname}${destination.search}${destination.hash}` === `${current.pathname}${current.search}${current.hash}`) return;

      event.preventDefault();
      event.stopPropagation();
      if (confirmationPendingRef.current) return;

      confirmationPendingRef.current = true;
      void confirm({
        title: 'Alteracoes nao salvas',
        message: 'Existem alteracoes ainda nao salvas neste fluxo. Deseja sair mesmo assim?',
        confirmText: 'Sair sem salvar',
        cancelText: 'Continuar editando',
        type: 'warning'
      }).then((confirmed) => {
        if (!confirmed) return;
        dirtyRef.current = false;
        navigate(`${destination.pathname}${destination.search}${destination.hash}`);
      }).finally(() => {
        confirmationPendingRef.current = false;
      });
    };

    document.addEventListener('click', handleNavigationClick, true);
    return () => document.removeEventListener('click', handleNavigationClick, true);
  }, [confirm, navigate]);
};
