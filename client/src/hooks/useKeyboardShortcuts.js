import { useEffect, useRef } from 'react';

const useKeyboardShortcuts = (shortcuts, deps = []) => {
  const callbacksRef = useRef({});

  useEffect(() => {
    callbacksRef.current = shortcuts;
  }, [shortcuts, ...deps]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      const { key, ctrlKey, metaKey, shiftKey, altKey } = e;

      Object.entries(callbacksRef.current).forEach(([shortcutKey, callback]) => {
        const [keyChar, modifiers] = shortcutKey.split('+');

        const keyMatch = key.toLowerCase() === keyChar.toLowerCase();
        const ctrlMatch = modifiers?.includes('ctrl') ? (ctrlKey || metaKey) : !ctrlKey && !metaKey;
        const shiftMatch = modifiers?.includes('shift') ? shiftKey : !shiftKey;
        const altMatch = modifiers?.includes('alt') ? altKey : !altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          callback(e);
        }
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
};

export default useKeyboardShortcuts;
