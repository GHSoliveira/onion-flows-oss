import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Download, FileText, Maximize2, Minimize2, X, ZoomIn, ZoomOut
} from 'lucide-react';
import { normalizeMediaPayload, resolveMediaUrl } from './ChatMessageContent';

export const collectMediaFromMessages = (messages = []) => {
  const items = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const media = normalizeMediaPayload(message);
    if (!media?.url) continue;
    items.push({
      ...media,
      resolvedUrl: resolveMediaUrl(media.url),
      messageId: message?.id || message?.messageId || null,
      timestamp: message?.timestamp || message?.createdAt || null,
      sender: message?.sender || null
    });
  }
  return items;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const ChatMediaLightbox = ({ open, items = [], index = 0, onClose, onIndexChange }) => {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const safeItems = useMemo(
    () => (Array.isArray(items) ? items.filter((item) => item?.resolvedUrl || item?.url) : []),
    [items]
  );
  const safeIndex = clamp(Number(index) || 0, 0, Math.max(0, safeItems.length - 1));
  const current = safeItems[safeIndex] || null;
  const url = current?.resolvedUrl || resolveMediaUrl(current?.url);
  const type = String(current?.type || 'document').toLowerCase();

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const move = useCallback((direction) => {
    if (safeItems.length < 2) return;
    const next = (safeIndex + direction + safeItems.length) % safeItems.length;
    resetView();
    onIndexChange?.(next);
  }, [onIndexChange, resetView, safeIndex, safeItems.length]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    resetView();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
      if (event.key === '+' || event.key === '=') setZoom((value) => clamp(value + 0.25, 0.5, 5));
      if (event.key === '-') setZoom((value) => clamp(value - 0.25, 0.5, 5));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [move, onClose, open, resetView]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  if (!open || !current) return null;

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen?.();
    } catch {
      // Fullscreen is optional and can be blocked by the browser.
    }
  };

  const beginDrag = (event) => {
    if (type !== 'image' || zoom <= 1) return;
    dragRef.current = { x: event.clientX, y: event.clientY, offset };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const drag = (event) => {
    if (!dragRef.current) return;
    setOffset({
      x: dragRef.current.offset.x + event.clientX - dragRef.current.x,
      y: dragRef.current.offset.y + event.clientY - dragRef.current.y
    });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const changeZoom = (delta) => {
    setZoom((value) => {
      const next = clamp(value + delta, 0.5, 5);
      if (next <= 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex flex-col bg-slate-950/95 text-white backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Visualizador de midia"
      onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <header className="relative z-10 flex min-h-14 items-center justify-between border-b border-white/10 bg-slate-950/80 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{current.fileName || 'Midia da conversa'}</div>
          <div className="text-[11px] text-slate-400">{safeIndex + 1} de {safeItems.length}</div>
        </div>
        <div className="flex items-center gap-1">
          {type === 'image' ? (
            <>
              <button type="button" onClick={() => changeZoom(-0.25)} className="media-viewer-action" aria-label="Diminuir zoom"><ZoomOut size={17} /></button>
              <span className="min-w-12 text-center text-xs tabular-nums text-slate-300">{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => changeZoom(0.25)} className="media-viewer-action" aria-label="Aumentar zoom"><ZoomIn size={17} /></button>
            </>
          ) : null}
          <a href={url} download={current.fileName || undefined} target="_blank" rel="noreferrer" className="media-viewer-action" aria-label="Baixar"><Download size={17} /></a>
          <button type="button" onClick={toggleFullscreen} className="media-viewer-action" aria-label="Tela cheia">{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
          <button type="button" onClick={onClose} className="media-viewer-action" aria-label="Fechar"><X size={19} /></button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {safeItems.length > 1 ? <button type="button" onClick={() => move(-1)} className="media-viewer-nav left-3" aria-label="Midia anterior"><ChevronLeft size={24} /></button> : null}
        {type === 'image' ? (
          <img
            src={url}
            alt={current.fileName || 'Imagem'}
            draggable="false"
            onPointerDown={beginDrag}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`max-h-full max-w-full select-none object-contain ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, transformOrigin: 'center' }}
          />
        ) : type === 'video' ? (
          <video controls autoPlay className="max-h-full max-w-full rounded-xl bg-black" src={url} />
        ) : type === 'audio' ? (
          <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/5 p-6">
            <audio controls autoPlay className="w-full" src={url} />
          </div>
        ) : (
          <a href={url} target="_blank" rel="noreferrer" className="flex max-w-md items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 hover:bg-white/10">
            <FileText size={24} /><span className="min-w-0 truncate">{current.fileName || 'Abrir documento'}</span>
          </a>
        )}
        {safeItems.length > 1 ? <button type="button" onClick={() => move(1)} className="media-viewer-nav right-3" aria-label="Proxima midia"><ChevronRight size={24} /></button> : null}
      </div>
    </div>
  );
};

export default ChatMediaLightbox;
