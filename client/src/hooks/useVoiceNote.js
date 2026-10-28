import { useCallback, useEffect, useRef, useState } from 'react';
import Recorder from 'opus-recorder';
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js?url';

// Grava mensagem de voz em OGG/OPUS mono: o unico formato que o WhatsApp mostra
// como audio de voz (microfone e onda). Chrome e Edge so gravam webm, por isso o
// encoder roda no navegador (opus-recorder, MIT). A 24 kbps, 2 min ficam abaixo
// dos 512 KB em que o WhatsApp ainda mostra o play direto.
export const VOICE_NOTE_MAX_SECONDS = 120;

export default function useVoiceNote({ onRecorded }) {
  const recorderRef = useRef(null);
  const discardRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const onRecordedRef = useRef(onRecorded);
  const [state, setState] = useState('idle'); // idle | starting | recording
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  const finish = useCallback((discard) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    discardRef.current = discard;
    clearInterval(timerRef.current);
    timerRef.current = null;
    recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (!Recorder.isRecordingSupported()) throw new Error('Este navegador não grava áudio.');
    const recorder = new Recorder({
      encoderPath,
      numberOfChannels: 1,
      encoderApplication: 2048,
      encoderSampleRate: 48000,
      encoderBitRate: 24000,
      mediaTrackConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    recorderRef.current = recorder;
    discardRef.current = false;
    recorder.ondataavailable = (data) => {
      if (discardRef.current) return;
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      onRecordedRef.current?.(new Blob([data], { type: 'audio/ogg' }), durationSeconds);
    };
    recorder.onstop = () => {
      recorderRef.current = null;
      setState('idle');
      setSeconds(0);
    };
    setState('starting');
    try {
      await recorder.start();
    } catch (error) {
      recorderRef.current = null;
      setState('idle');
      recorder.close?.();
      throw error;
    }
    startedAtRef.current = Date.now();
    setSeconds(0);
    setState('recording');
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= VOICE_NOTE_MAX_SECONDS) finish(false);
    }, 250);
  }, [finish]);

  // Saiu da tela gravando: descarta, nunca envia sozinho.
  useEffect(() => () => {
    clearInterval(timerRef.current);
    if (recorderRef.current) {
      discardRef.current = true;
      recorderRef.current.stop();
    }
  }, []);

  return {
    state,
    seconds,
    start,
    send: useCallback(() => finish(false), [finish]),
    cancel: useCallback(() => finish(true), [finish])
  };
}
