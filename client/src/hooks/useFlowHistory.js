import { useCallback, useEffect, useRef, useState } from 'react';

const cloneSnapshot = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const snapshotKey = (snapshot) => JSON.stringify(snapshot);

export const useFlowHistory = ({
  snapshot,
  enabled = true,
  limit = 50,
  debounceMs = 400,
  onRestore,
}) => {
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const baselineRef = useRef(null);
  const latestRef = useRef(snapshot);
  const latestKeyRef = useRef(snapshotKey(snapshot));
  const timerRef = useRef(null);
  const initializedRef = useRef(false);
  const restoringRef = useRef(false);
  const restoreKeyRef = useRef('');
  const [availability, setAvailability] = useState({ canUndo: false, canRedo: false });

  const notify = useCallback(() => {
    const hasPendingChange = Boolean(
      initializedRef.current
      && baselineRef.current
      && snapshotKey(baselineRef.current) !== latestKeyRef.current
    );
    setAvailability({
      canUndo: pastRef.current.length > 0 || hasPendingChange,
      canRedo: futureRef.current.length > 0 && !hasPendingChange,
    });
  }, []);

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const commitPending = useCallback(() => {
    clearTimer();
    if (!enabled || !initializedRef.current || restoringRef.current) return false;

    const baseline = baselineRef.current;
    const latest = latestRef.current;
    if (!baseline || snapshotKey(baseline) === latestKeyRef.current) return false;

    pastRef.current = [...pastRef.current, cloneSnapshot(baseline)].slice(-limit);
    baselineRef.current = cloneSnapshot(latest);
    futureRef.current = [];
    notify();
    return true;
  }, [clearTimer, enabled, limit, notify]);

  const restore = useCallback((nextSnapshot) => {
    const clean = cloneSnapshot(nextSnapshot);
    restoringRef.current = true;
    restoreKeyRef.current = snapshotKey(clean);
    baselineRef.current = clean;
    latestRef.current = clean;
    latestKeyRef.current = restoreKeyRef.current;
    onRestore(clean);
  }, [onRestore]);

  const undo = useCallback(() => {
    if (!enabled) return false;
    commitPending();
    const previous = pastRef.current.at(-1);
    if (!previous) return false;

    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [cloneSnapshot(baselineRef.current), ...futureRef.current].slice(0, limit);
    restore(previous);
    notify();
    return true;
  }, [commitPending, enabled, limit, notify, restore]);

  const redo = useCallback(() => {
    if (!enabled) return false;
    commitPending();
    const next = futureRef.current[0];
    if (!next) return false;

    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current, cloneSnapshot(baselineRef.current)].slice(-limit);
    restore(next);
    notify();
    return true;
  }, [commitPending, enabled, limit, notify, restore]);

  useEffect(() => {
    const key = snapshotKey(snapshot);
    latestRef.current = snapshot;
    latestKeyRef.current = key;

    if (!enabled) {
      clearTimer();
      initializedRef.current = false;
      restoringRef.current = false;
      pastRef.current = [];
      futureRef.current = [];
      baselineRef.current = null;
      return;
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      baselineRef.current = cloneSnapshot(snapshot);
      window.queueMicrotask(notify);
      return;
    }

    if (restoringRef.current) {
      if (key === restoreKeyRef.current) restoringRef.current = false;
      return;
    }

    if (snapshotKey(baselineRef.current) === key) return;
    clearTimer();
    timerRef.current = window.setTimeout(commitPending, debounceMs);
    window.queueMicrotask(notify);
  }, [clearTimer, commitPending, debounceMs, enabled, notify, snapshot]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    canUndo: enabled && availability.canUndo,
    canRedo: enabled && availability.canRedo,
    undo,
    redo,
    commitPending,
  };
};
