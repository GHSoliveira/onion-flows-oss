import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Pause, Play, PlayCircle, Volume2, VolumeX } from 'lucide-react';
import { API_BASE } from '../services/api';
import { resolveAllowedMediaUrl } from '../utils/mediaUrl';

const BACKEND_ORIGIN = String(API_BASE || '').replace(/\/api\/?$/i, '');

const resolveMediaUrl = (value) => {
  return resolveAllowedMediaUrl(value, {
    apiBase: API_BASE,
    backendOrigin: BACKEND_ORIGIN
  });
};

const inferTypeByMime = (value) => {
  const mime = String(value || '').trim().toLowerCase();
  if (!mime) return null;
  if (mime === 'image' || mime.startsWith('image/')) return 'image';
  if (mime === 'video' || mime.startsWith('video/')) return 'video';
  if (mime === 'audio' || mime.startsWith('audio/') || mime === 'application/ogg') return 'audio';
  if (mime === 'document' || mime === 'file' || mime === 'application' || mime.startsWith('application/')) return 'document';
  return null;
};

const inferTypeByUrl = (value) => {
  const url = String(value || '').trim().toLowerCase();
  if (!url) return null;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/.test(url)) return 'image';
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/.test(url)) return 'video';
  if (/\.(mp3|ogg|wav|m4a|aac|opus)(\?.*)?$/.test(url)) return 'audio';
  return null;
};

const inferTypeByFileName = (value) => {
  const fileName = String(value || '').trim().toLowerCase();
  if (!fileName) return null;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(fileName)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(fileName)) return 'video';
  if (/\.(mp3|ogg|wav|m4a|aac|opus|oga|weba)$/.test(fileName)) return 'audio';
  return null;
};

const looksLikeFileName = (value) => (
  /^[^\\/:*?"<>|]+\.[a-z0-9]{2,8}$/i.test(String(value || '').trim())
);

const inferTypeByKindLike = (value) => {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind) return null;
  if (kind === 'image' || kind === 'photo' || kind === 'sticker' || kind.includes('image') || kind.includes('photo')) return 'image';
  if (kind === 'video' || kind.includes('video') || kind === 'animation' || kind === 'gif') return 'video';
  if (kind === 'audio' || kind === 'voice' || kind === 'ptt' || kind.includes('audio') || kind.includes('voice')) return 'audio';
  if (kind === 'document' || kind === 'file' || kind.includes('document') || kind.includes('file')) return 'document';
  return inferTypeByMime(kind);
};

const extractFirstUrl = (value) => {
  const source = String(value || '').trim();
  if (!source) return '';
  const match = source.match(/(https?:\/\/[^\s]+|\/uploads\/[^\s]+)/i);
  return match ? match[1] : '';
};

const extractFileNameFromUrl = (value) => {
  const url = String(value || '').trim();
  if (!url) return null;
  const cleanUrl = url.split('?')[0].split('#')[0];
  const parts = cleanUrl.split('/');
  const lastPart = parts[parts.length - 1] || '';
  if (!lastPart || !/\.[a-z0-9]{2,8}$/i.test(lastPart)) return null;
  try {
    return decodeURIComponent(lastPart);
  } catch {
    return lastPart;
  }
};

const inferTypeByToken = (value) => {
  const source = String(value || '').trim().toLowerCase();
  if (!source) return null;
  if (source.startsWith('[image]')) return 'image';
  if (source.startsWith('[video]')) return 'video';
  if (source.startsWith('[audio]') || source.startsWith('[voice]')) return 'audio';
  if (source.startsWith('[document]')) return 'document';
  return null;
};

const normalizeMediaPayload = (message) => {
  const mediaSource = message?.media ?? message?.attachment ?? null;
  let media = {};
  if (mediaSource && typeof mediaSource === 'object') {
    media = mediaSource;
  } else if (typeof mediaSource === 'string') {
    try {
      const parsed = JSON.parse(mediaSource);
      if (parsed && typeof parsed === 'object') {
        media = parsed;
      }
    } catch {
      const rawValue = String(mediaSource || '').trim();
      media = /^(https?:\/\/|\/uploads\/)/i.test(rawValue)
        ? { url: rawValue }
        : {};
    }
  }

  const textValue = String(message?.text || '').trim();
  const tokenType = inferTypeByToken(message?.text);
  const mediaUrl = (
    media.url
    || media.mediaUrl
    || (typeof message?.media === 'string' ? String(message.media || '').trim() : '')
    || (typeof message?.attachment === 'string' ? String(message.attachment || '').trim() : '')
    || message?.mediaUrl
    || message?.fileUrl
    || message?.path
    || message?.filePath
    || message?.storagePath
    || message?.meta?.mediaUrl
    || message?.meta?.fileUrl
    || message?.meta?.path
    || message?.meta?.filePath
    || message?.meta?.storagePath
    || message?.attachmentUrl
    || (tokenType ? extractFirstUrl(textValue) : '')
  );
  if (!mediaUrl) return null;

  const mimeType = (
    media.mimeType
    || media.mime_type
    || media.mimetype
    || message?.mimeType
    || message?.mime_type
    || message?.meta?.mimeType
    || message?.meta?.mime_type
    || message?.meta?.mimetype
    || ''
  );
  const fileName = (
    media.fileName
    || media.filename
    || media.file_name
    || message?.fileName
    || message?.file_name
    || message?.meta?.fileName
    || message?.meta?.file_name
    || extractFileNameFromUrl(mediaUrl)
    || (looksLikeFileName(textValue) ? textValue : null)
    || null
  );
  const directKind = String(
    media.type
    || media.kind
    || media.mediaType
    || media.media_type
    || message?.attachment?.mediaType
    || message?.attachment?.type
    || message?.mediaType
    || message?.media_type
    || message?.mediaKind
    || message?.media_kind
    || message?.messageType
    || message?.message_type
    || message?.kind
    || message?.type
    || ''
  ).trim().toLowerCase();
  const normalizedKind = inferTypeByKindLike(directKind);
  const inferredType =
    tokenType
    || inferTypeByMime(mimeType)
    || inferTypeByFileName(fileName)
    || inferTypeByUrl(mediaUrl)
    || inferTypeByKindLike(message?.attachment?.type);

  let type = normalizedKind || inferredType || 'document';
  if (type === 'document' && inferredType && inferredType !== 'document') {
    type = inferredType;
  }

  return {
    url: String(mediaUrl),
    type,
    caption: media.caption || message?.caption || message?.meta?.caption || '',
    fileName,
    mimeType: mimeType || null,
    voice: media.voice === true
  };
};

const formatAudioTime = (value) => {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const CompactAudioPlayer = ({ url, mimeType, fileName, voice = false, onOpen }) => {
  const label = voice ? 'Mensagem de voz' : 'Áudio';
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.load();
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setFailed(false);
  }, [url, mimeType]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Number(event.target.value || 0);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  };

  const progress = duration > 0
    ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
    : 0;

  return (
    <div className="compact-audio-player" title={voice ? label : (fileName || label)}>
      <audio
        ref={audioRef}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(Number(event.currentTarget.duration || 0))}
        onDurationChange={(event) => setDuration(Number(event.currentTarget.duration || 0))}
        onTimeUpdate={(event) => setCurrentTime(Number(event.currentTarget.currentTime || 0))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      >
        {mimeType ? <source src={url} type={mimeType} /> : null}
        <source src={url} />
      </audio>
      <button
        type="button"
        onClick={togglePlayback}
        disabled={failed}
        className="compact-audio-play"
        aria-label={playing ? 'Pausar audio' : 'Reproduzir audio'}
      >
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between gap-2 text-[9px] font-semibold">
          <span className="truncate opacity-75">{failed ? 'Áudio indisponível' : label}</span>
          <span className="shrink-0 tabular-nums opacity-65">
            {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max={duration || 0}
          step="0.05"
          value={Math.min(currentTime, duration || 0)}
          onChange={seek}
          disabled={failed || !duration}
          className="compact-audio-range"
          style={{ '--audio-progress': `${progress}%` }}
          aria-label="Posicao do audio"
        />
      </div>
      <button type="button" onClick={toggleMute} className="compact-audio-action" aria-label={muted ? 'Ativar som' : 'Silenciar'}>
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      {typeof onOpen === 'function' ? (
        <button type="button" onClick={onOpen} className="compact-audio-action" aria-label="Abrir audio">
          <ExternalLink size={13} />
        </button>
      ) : null}
    </div>
  );
};

const renderMedia = (mediaPayload, { onOpen } = {}) => {
  if (!mediaPayload?.url) return null;
  const url = resolveMediaUrl(mediaPayload.url);
  if (!url) return null;
  const type = String(mediaPayload.type || 'document').toLowerCase();

  if (type === 'image') {
    const content = (
      <img
        src={url}
        alt={mediaPayload.fileName || 'Imagem recebida'}
        className="max-h-72 w-auto rounded-xl border border-black/10 object-cover"
        loading="lazy"
      />
    );
    return typeof onOpen === 'function' ? (
      <button type="button" onClick={onOpen} className="block cursor-zoom-in text-left">
        {content}
      </button>
    ) : (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {content}
      </a>
    );
  }

  if (type === 'video') {
    return (
      <video
        controls
        preload="metadata"
        className="max-h-72 w-full rounded-xl border border-black/10 bg-black"
        src={url}
      />
    );
  }

  if (type === 'audio') {
    const safeMimeType = String(mediaPayload.mimeType || '').toLowerCase().startsWith('audio/')
      ? mediaPayload.mimeType
      : undefined;
    return <CompactAudioPlayer url={url} mimeType={safeMimeType} fileName={mediaPayload.fileName} voice={mediaPayload.voice === true} onOpen={onOpen} />;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl border border-black/10 bg-black/5 px-3 py-3 transition-colors hover:bg-black/10"
    >
      <FileText size={18} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{mediaPayload.fileName || 'Documento'}</div>
        <div className="text-xs opacity-70">{mediaPayload.mimeType || 'Arquivo'}</div>
      </div>
      <PlayCircle size={16} className="shrink-0 opacity-70" />
    </a>
  );
};

const ChatMessageContent = ({ message, onOpenMedia }) => {
  const media = normalizeMediaPayload(message);
  const caption = String(media?.caption || '').trim();
  const text = String(message?.text || '').trim();
  const mediaUrlInText = media ? extractFirstUrl(text) : '';
  const textLooksLikeMediaToken = /^\[(image|video|audio|document)\]/i.test(text);
  const textLooksLikeMediaUrl = /^https?:\/\/\S+$/i.test(text) || /^\/uploads\/\S+/i.test(text);
  const textLooksLikeBareFileName = Boolean(media?.fileName) && text.toLowerCase() === String(media.fileName || '').trim().toLowerCase();
  const showText = !media
    || Boolean(caption)
    || (
      !textLooksLikeMediaToken
      && !textLooksLikeMediaUrl
      && !textLooksLikeBareFileName
      && (!mediaUrlInText || !text.includes(mediaUrlInText))
    );
  const handleOpen = media
    ? () => {
      if (typeof onOpenMedia === 'function') {
        onOpenMedia(message, media);
        return;
      }
      window.dispatchEvent(new CustomEvent('onion:open-chat-media', {
        detail: { message, media }
      }));
    }
    : undefined;

  return (
    <div className="space-y-2">
      {media && renderMedia(media, { onOpen: handleOpen })}
      {showText && <div className="whitespace-pre-wrap break-words">{text || '-'}</div>}
    </div>
  );
};

export { normalizeMediaPayload, resolveMediaUrl };
export default ChatMessageContent;
