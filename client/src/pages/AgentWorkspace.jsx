import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Reorder } from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../context/DialogContext';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { uploadMediaAsset } from '../services/media';
import ChatMessageContent from '../components/ChatMessageContent';
import AgentTasks from '../components/AgentTasks';
import ChatMediaLightbox, { collectMediaFromMessages } from '../components/ChatMediaLightbox';
import useVoiceNote, { VOICE_NOTE_MAX_SECONDS } from '../hooks/useVoiceNote';
import {
  User, MessageCircle, Clock, Play, XCircle, Send, Headset, Star, Check, CheckCheck,
  ArrowLeft, Paperclip, Info, MessageSquareText, Loader2, FileText, Image as ImageIcon, Video, AudioLines,
  PanelRightClose, PanelRightOpen, ArrowRightLeft, CornerUpLeft, X as XIcon, Workflow, ChevronDown, Mic, Trash2
} from 'lucide-react';
import toast from 'react-hot-toast';
import { CenterSkeleton } from '../components/LoadingSkeleton';
import { can } from '../utils/managerPermissions';

const chatOrderStorageKey = (userId, listKey) => `agentChatOrder:${userId || 'anon'}:${listKey}`;

const loadChatOrder = (userId, listKey) => {
  try {
    const raw = localStorage.getItem(chatOrderStorageKey(userId, listKey));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const saveChatOrder = (userId, listKey, chats) => {
  try {
    const ids = (Array.isArray(chats) ? chats : []).map((chat) => String(chat?.id || '')).filter(Boolean);
    localStorage.setItem(chatOrderStorageKey(userId, listKey), JSON.stringify(ids));
  } catch {
    // ignore quota / private mode
  }
};

const formatWorkspaceValue = (value, fallback = '-') => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return formatWorkspaceValue(item, '');
        }

        const pedido = item.pedido ?? item.item ?? item.nome ?? item.name;
        const quantidade = item.quantidade ?? item.qtd ?? item.quantity;
        if (pedido !== undefined || quantidade !== undefined) {
          return [
            pedido !== undefined ? String(pedido) : null,
            quantidade !== undefined ? `Qtd: ${String(quantidade)}` : null
          ].filter(Boolean).join(' | ');
        }
        return JSON.stringify(item);
      }).filter(Boolean).join(' / ');
    }

    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    return fallback;
  }
};

/** Mantém a ordem atual (ou salva); so adiciona chats novos no fim. Nao reordena por mensagem. */
const mergeChatsPreserveOrder = (prevList, nextList, storedOrder = []) => {
  const nextById = new Map();
  (Array.isArray(nextList) ? nextList : []).forEach((chat) => {
    if (chat?.id) nextById.set(String(chat.id), chat);
  });

  const prevIds = (Array.isArray(prevList) ? prevList : [])
    .map((chat) => String(chat?.id || ''))
    .filter(Boolean);
  const baseOrder = prevIds.length > 0 ? prevIds : (Array.isArray(storedOrder) ? storedOrder : []);
  const used = new Set();
  const result = [];

  baseOrder.forEach((id) => {
    if (!nextById.has(id) || used.has(id)) return;
    result.push(nextById.get(id));
    used.add(id);
  });

  nextById.forEach((chat, id) => {
    if (used.has(id)) return;
    result.push(chat);
    used.add(id);
  });

  return result;
};

const parseMessageTimeLoose = (value) => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const DELIVERY_STATUS_PRIORITY = Object.freeze({ pending: 0, sent: 1, delivered: 2, read: 3 });

const strongestDeliveryStatus = (previousMessage, incomingMessage) => {
  const previous = String(previousMessage?.deliveryStatus || previousMessage?.meta?.deliveryStatus || '').trim().toLowerCase();
  const incoming = String(incomingMessage?.deliveryStatus || incomingMessage?.meta?.deliveryStatus || '').trim().toLowerCase();
  if (!previous) return incoming || null;
  if (!incoming) return previous || null;
  if (incoming === 'failed') return previous === 'pending' ? 'failed' : previous;
  if (previous === 'failed') return incoming === 'pending' ? 'failed' : incoming;
  return (DELIVERY_STATUS_PRIORITY[incoming] ?? -1) >= (DELIVERY_STATUS_PRIORITY[previous] ?? -1)
    ? incoming
    : previous;
};

const messagesLookSame = (left, right) => {
  if (!left || !right) return false;
  const leftProvider = left.providerMessageId || left.meta?.providerMessageId || left.meta?.genesysMessageId || null;
  const rightProvider = right.providerMessageId || right.meta?.providerMessageId || right.meta?.genesysMessageId || null;
  if (leftProvider && rightProvider && String(leftProvider) === String(rightProvider)) return true;

  const leftId = left.id || left.messageId || null;
  const rightId = right.id || right.messageId || null;
  if (leftId && rightId && String(leftId) === String(rightId)) return true;
  if (leftId && rightId) {
    const leftValue = String(leftId);
    const rightValue = String(rightId);
    if (leftValue.endsWith(rightValue) || rightValue.endsWith(leftValue)) return true;
  }

  // Text and timestamp are not identities. Customers may legitimately send
  // the same content several times in quick succession.
  return false;
};

const mergeDuplicateMessage = (previous, incoming) => {
  const deliveryStatus = strongestDeliveryStatus(previous, incoming);
  return {
    ...previous,
    ...incoming,
    id: previous.id || incoming.id,
    messageId: previous.messageId || incoming.messageId || previous.id,
    providerMessageId: incoming.providerMessageId
      || previous.providerMessageId
      || incoming.meta?.providerMessageId
      || previous.meta?.providerMessageId
      || null,
    media: incoming?.media ?? previous?.media ?? null,
    attachment: incoming?.attachment ?? previous?.attachment ?? null,
    deliveryStatus,
    meta: previous?.meta || incoming?.meta
      ? { ...(previous?.meta || {}), ...(incoming?.meta || {}), ...(deliveryStatus ? { deliveryStatus } : {}) }
      : null
  };
};

// Balao otimista do atendente: aparece na hora com localPending e some quando a
// mensagem real chega (socket, resposta do POST ou recarga da conversa). O
// casamento e por texto, um para um, so com mensagem real gravada depois que o
// balao foi criado; a resposta do POST troca pelo id de qualquer jeito.
const ECHO_CLOCK_TOLERANCE_MS = 3000;
const isLocalAgentMessage = (message) => Boolean(message?.localPending || message?.localFailed);
const settleLocalMessages = (messages) => {
  if (!Array.isArray(messages) || !messages.some((message) => message?.localPending)) return messages;
  const used = new Set();
  const settled = new Set();
  messages.forEach((local) => {
    if (!local?.localPending) return;
    const createdAt = new Date(local.timestamp).getTime() || 0;
    const echoIndex = messages.findIndex((real, index) => (
      !used.has(index)
      && real?.sender === 'agent'
      && !isLocalAgentMessage(real)
      && String(real?.text || '') === String(local.text || '')
      && (new Date(real?.timestamp).getTime() || 0) >= createdAt - ECHO_CLOCK_TOLERANCE_MS
    ));
    if (echoIndex === -1) return;
    used.add(echoIndex);
    settled.add(local.id);
  });
  return settled.size ? messages.filter((message) => !settled.has(message?.id)) : messages;
};

const dedupeMessageList = (list) => {
  if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? list : [];
  const result = [];
  for (const message of list) {
    if (!message) continue;
    const index = result.findIndex((item) => messagesLookSame(item, message));
    if (index === -1) result.push(message);
    else result[index] = mergeDuplicateMessage(result[index], message);
  }
  return result.sort((left, right) => parseMessageTimeLoose(left?.timestamp) - parseMessageTimeLoose(right?.timestamp));
};

const AgentWorkspace = () => {
  const { user } = useAuth();
  const [workspaceSection, setWorkspaceSection] = useState('chats');
  const workspaceSectionRef = useRef('chats');
  const { confirm } = useDialog();
  const location = useLocation();
  const [waitingChats, setWaitingChats] = useState([]);
  const [myChats, setMyChats] = useState([]);
  const [draggingChatId, setDraggingChatId] = useState(null);
  const chatDragMovedRef = useRef(false);
  const chatDragStartIdRef = useRef(null);
  const [selectedChat, setSelectedChat] = useState(null);
  const [pendingFocusChatId, setPendingFocusChatId] = useState(() => localStorage.getItem('pendingActiveChatId') || null);
  const [agentInput, setAgentInput] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  // Horario so no ultimo balao da sequencia; nos outros, aparece ao clicar.
  const [revealedTimeId, setRevealedTimeId] = useState(null);
  const highlightTimerRef = useRef(null);
  const [visibleVars, setVisibleVars] = useState([]);
  const [rootVars, setRootVars] = useState([]);
  const [quickReplies, setQuickReplies] = useState([]);
  const [appTemplates, setAppTemplates] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [quickDraft, setQuickDraft] = useState('');
  const [bulkPickupModal, setBulkPickupModal] = useState({
    open: false,
    message: '',
    loading: false
  });
  const [isMobileView, setIsMobileView] = useState(() => window.innerWidth < 1024);
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [mobileListTab, setMobileListTab] = useState('active');
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [mobilePanelTab, setMobilePanelTab] = useState('info');
  const [isSidePanelCollapsed, setIsSidePanelCollapsed] = useState(true);
  const [unreadByChatId, setUnreadByChatId] = useState({});
  const [mediaModal, setMediaModal] = useState({
    open: false,
    file: null,
    previewUrl: '',
    previewKind: 'document',
    caption: '',
    uploading: false
  });
  const [mediaViewer, setMediaViewer] = useState({ open: false, index: 0 });
  const [transferModal, setTransferModal] = useState({
    open: false,
    loading: false,
    submitting: false,
    mode: 'queue',
    queue: '',
    agentId: '',
    reason: '',
    queues: [],
    agents: []
  });
  const [tick, setTick] = useState(Date.now());
  const chatEndRef = useRef(null);
  // Lista de mensagens: sabe se o atendente esta perto do fim para nao puxa-lo
  // para baixo enquanto le algo antigo, e mostra o botao de descer.
  const messagesScrollRef = useRef(null);
  const nearBottomRef = useRef(true);
  const lastScrolledChatIdRef = useRef(null);
  const [showJumpToEnd, setShowJumpToEnd] = useState(false);
  const agentInputRef = useRef(null);
  const selectedChatRef = useRef(null);
  const mediaInputRef = useRef(null);
  const unreadByChatIdRef = useRef({});
  const unreadBootstrappedRef = useRef(false);
  const lastReadCustomerAtRef = useRef({});

  useEffect(() => {
    const input = agentInputRef.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  }, [agentInput]);

  const mergeChatMessages = useCallback((previousMessages, nextMessages) => {
    if (!Array.isArray(nextMessages)) return Array.isArray(previousMessages) ? previousMessages : [];
    if (!Array.isArray(previousMessages) || previousMessages.length === 0) return dedupeMessageList(nextMessages);
    if (nextMessages.length === 0) return dedupeMessageList(previousMessages);
    const merged = [...previousMessages];
    for (const message of nextMessages) {
      if (!message) continue;
      const index = merged.findIndex((item) => messagesLookSame(item, message));
      if (index === -1) merged.push(message);
      else merged[index] = mergeDuplicateMessage(merged[index], message);
    }
    return dedupeMessageList(merged);
  }, []);

  const mergeChatPayload = useCallback((previousChat, nextChat, options = {}) => {
    if (!previousChat) return nextChat;
    if (!nextChat) return previousChat;
    const sameChat = String(previousChat.id || '') === String(nextChat.id || '');
    const nextMessages = Array.isArray(nextChat.messages) ? nextChat.messages : null;
    const previousMessages = Array.isArray(previousChat.messages) ? previousChat.messages : [];
    let messages;
    if (!sameChat) messages = nextMessages?.length ? dedupeMessageList(nextMessages) : [];
    else if (options.replaceMessages === true && nextMessages) {
      messages = dedupeMessageList(nextMessages);
      const locals = previousMessages.filter(isLocalAgentMessage);
      if (locals.length) messages = [...messages, ...locals];
    }
    else if (!nextMessages || nextMessages.length === 0) messages = previousMessages;
    else messages = mergeChatMessages(previousMessages, nextMessages);

    return {
      ...(sameChat ? previousChat : {}),
      ...nextChat,
      messages: settleLocalMessages(messages)
    };
  }, [mergeChatMessages]);

  const chatMediaItems = useMemo(
    () => collectMediaFromMessages(selectedChat?.messages),
    [selectedChat?.messages]
  );

  const openChatMedia = useCallback((message, media) => {
    const items = collectMediaFromMessages(selectedChat?.messages);
    if (!items.length) return;
    const messageId = message?.id || message?.messageId || null;
    const mediaUrl = media?.url || message?.media?.url || message?.attachment?.url || null;
    let index = messageId
      ? items.findIndex((item) => String(item.messageId || '') === String(messageId))
      : -1;
    if (index < 0 && mediaUrl) index = items.findIndex((item) => item.url === mediaUrl);
    setMediaViewer({ open: true, index: Math.max(0, index) });
  }, [selectedChat?.messages]);

  useEffect(() => {
    const handleOpenChatMedia = (event) => {
      openChatMedia(event?.detail?.message, event?.detail?.media);
    };
    window.addEventListener('onion:open-chat-media', handleOpenChatMedia);
    return () => window.removeEventListener('onion:open-chat-media', handleOpenChatMedia);
  }, [openChatMedia]);

  const isCustomerMessage = useCallback((message) => {
    const sender = String(message?.sender || '').toLowerCase();
    return ['user', 'customer', 'cliente', 'visitor'].includes(sender);
  }, []);

  const parseMessageTime = useCallback((value) => {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }, []);

  const isSameMessage = useCallback((left, right) => messagesLookSame(left, right), []);

  const appendRealtimeMessage = useCallback((messages, message) => {
    if (!message || typeof message !== 'object') return Array.isArray(messages) ? messages : [];
    const current = Array.isArray(messages) ? messages : [];
    const existingIndex = current.findIndex((item, index) => isSameMessage(item, message, index));
    if (existingIndex !== -1) {
      return current.map((item, index) => {
        if (index !== existingIndex) return item;
        return {
          ...mergeDuplicateMessage(item, message)
        };
      });
    }
    return settleLocalMessages([...current, message].sort((a, b) => parseMessageTime(a?.timestamp) - parseMessageTime(b?.timestamp)));
  }, [isSameMessage, parseMessageTime]);

  const getLatestCustomerMessageAt = useCallback((chat) => {
    const messages = Array.isArray(chat?.messages) && chat.messages.length
      ? chat.messages
      : (chat?.lastMessage ? [chat.lastMessage] : []);
    let latest = 0;
    messages.forEach((message) => {
      if (!isCustomerMessage(message)) return;
      const at = parseMessageTime(message?.timestamp);
      if (at > latest) latest = at;
    });
    return latest;
  }, [isCustomerMessage, parseMessageTime]);

  const getUnreadCustomerCount = useCallback((chat, lastReadAt = 0) => {
    const messages = Array.isArray(chat?.messages) && chat.messages.length
      ? chat.messages
      : (chat?.lastMessage ? [chat.lastMessage] : []);
    return messages.reduce((acc, message) => {
      if (!isCustomerMessage(message)) return acc;
      const at = parseMessageTime(message?.timestamp);
      return at > Number(lastReadAt || 0) ? acc + 1 : acc;
    }, 0);
  }, [isCustomerMessage, parseMessageTime]);

  const applyStableChatOrder = useCallback((prevList, nextList, listKey) => {
    const stored = loadChatOrder(user?.id, listKey);
    const merged = mergeChatsPreserveOrder(prevList, nextList, stored);
    saveChatOrder(user?.id, listKey, merged);
    return merged;
  }, [user?.id]);

  const handleChatListReorderByIds = useCallback((listKey, nextIds, currentList) => {
    const byId = new Map(
      (Array.isArray(currentList) ? currentList : [])
        .filter((chat) => chat?.id)
        .map((chat) => [String(chat.id), chat])
    );
    const ordered = (Array.isArray(nextIds) ? nextIds : [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
    // preserva itens que por algum motivo nao vieram em nextIds
    (Array.isArray(currentList) ? currentList : []).forEach((chat) => {
      if (chat?.id && !ordered.some((item) => String(item.id) === String(chat.id))) {
        ordered.push(chat);
      }
    });
    if (listKey === 'active') setMyChats(ordered);
    if (listKey === 'waiting') setWaitingChats(ordered);
    saveChatOrder(user?.id, listKey, ordered);
  }, [user?.id]);

  const handleChatCardDragStart = useCallback((chatId) => {
    // Nao bloqueia click ainda: so marca drag real apos passar o limiar de movimento
    chatDragMovedRef.current = false;
    chatDragStartIdRef.current = String(chatId || '');
  }, []);

  const handleChatCardDrag = useCallback((_event, info) => {
    const offsetX = Number(info?.offset?.x || 0);
    const offsetY = Number(info?.offset?.y || 0);
    const distance = Math.hypot(offsetX, offsetY);
    // Clique normal quase sempre gera offset minúsculo; so considera drag apos ~8px
    if (distance < 8) return;
    if (!chatDragMovedRef.current) {
      chatDragMovedRef.current = true;
      if (chatDragStartIdRef.current) {
        setDraggingChatId(chatDragStartIdRef.current);
      }
    }
  }, []);

  const handleChatCardDragEnd = useCallback(() => {
    setDraggingChatId(null);
    chatDragStartIdRef.current = null;
    // evita click acidental de "abrir chat" logo apos um drag real
    window.setTimeout(() => {
      chatDragMovedRef.current = false;
    }, 60);
  }, []);

  const renderStars = (avg) => {
    const value = Number(avg || 0);
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            size={12}
            className={i < Math.round(value) ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600'}
            fill={i < Math.round(value) ? 'currentColor' : 'none'}
          />
        ))}
      </div>
    );
  };

  const renderChannelBadge = (channel) => {
    const channelValue = String(channel || '').trim();
    if (!channelValue) return null;
    const key = channelValue.toLowerCase();
    const icon = MessageCircle;
    const label = key === 'telegram'
      ? 'Telegram'
      : key === 'whatsapp'
        ? 'WhatsApp'
        : key === 'genesys'
          ? 'Genesys'
          : channelValue;
    const tone = key === 'genesys'
      ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
    const Icon = icon;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
        <Icon size={10} /> {label}
      </span>
    );
  };

  const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

  const getMessageDeliveryStatus = (message) => {
    if (message?.localPending) return 'pending';
    if (message?.localFailed) return 'failed';
    const status = String(
      message?.deliveryStatus
      || message?.meta?.deliveryStatus
      || ''
    ).trim().toLowerCase();
    // "played" e o audio de voz ouvido pelo cliente: para os tiques, vale como lido.
    if (status === 'played') return 'read';
    return ['sent', 'delivered', 'read', 'failed'].includes(status) ? status : null;
  };

  const renderMessageDeliveryStatus = (message) => {
    const status = getMessageDeliveryStatus(message);
    if (!status || (message?.sender !== 'agent' && message?.sender !== 'bot')) return null;

    const commonClass = 'absolute bottom-2 right-3 flex items-center gap-1 text-[10px]';
    const neutralClass = message?.sender === 'agent'
      ? 'text-white/80 dark:text-gray-300'
      : 'text-gray-400 dark:text-gray-500';
    const readClass = message?.sender === 'agent'
      ? 'text-sky-300 dark:text-sky-400'
      : 'text-sky-500 dark:text-sky-400';
    const failedClass = message?.sender === 'agent'
      ? 'text-red-200 dark:text-red-300'
      : 'text-red-500 dark:text-red-400';

    if (status === 'read') {
      return (
        <span className={`${commonClass} ${readClass}`} title="Lida">
          <CheckCheck size={14} strokeWidth={2.4} />
        </span>
      );
    }

    if (status === 'delivered') {
      return (
        <span className={`${commonClass} ${neutralClass}`} title="Entregue">
          <CheckCheck size={14} strokeWidth={2.4} />
        </span>
      );
    }

    if (status === 'pending') {
      return (
        <span className={`${commonClass} ${neutralClass}`} role="status" title="Enviando" aria-label="Enviando">
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
            <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
      );
    }

    if (status === 'failed' && message?.localFailed) {
      return (
        <button
          type="button"
          onClick={() => retryLocalMessage(message)}
          className={`${commonClass} ${failedClass} cursor-pointer transition-transform hover:scale-110`}
          title={`Não enviada${message.failureReason ? `: ${message.failureReason}` : ''}. Clique para tentar de novo.`}
        >
          <XCircle size={13} strokeWidth={2.2} />
        </button>
      );
    }

    if (status === 'failed') {
      return (
        <span className={`${commonClass} ${failedClass}`} title="Falhou">
          <XCircle size={13} strokeWidth={2.2} />
        </span>
      );
    }

    return (
      <span className={`${commonClass} ${neutralClass}`} title="Enviada">
        <Check size={13} strokeWidth={2.4} />
      </span>
    );
  };

  const loadChatDetails = useCallback(async (chatId) => {
    if (!chatId) return null;
    try {
      const res = await apiRequest(`/chats/${chatId}`);
      if (!res || !res.ok) return null;
      const fullChat = await res.json();
      setSelectedChat((prev) => {
        if (!prev || prev.id !== chatId) return prev;
        return mergeChatPayload(prev, fullChat, { replaceMessages: true });
      });
      return fullChat;
    } catch (error) {
      console.error('Erro ao carregar detalhes do chat:', error);
      return null;
    }
  }, [mergeChatPayload]);

  const markChatAsRead = useCallback((chat) => {
    if (workspaceSectionRef.current !== 'chats') return;
    const chatId = chat?.id;
    if (!chatId) return;
    const latestCustomerAt = getLatestCustomerMessageAt(chat);
    const previousReadAt = Number(lastReadCustomerAtRef.current[chatId] || 0);
    lastReadCustomerAtRef.current[chatId] = Math.max(previousReadAt, latestCustomerAt);

    setUnreadByChatId((prev) => {
      if (!prev || !prev[chatId]) return prev;
      const next = { ...prev, [chatId]: 0 };
      unreadByChatIdRef.current = next;
      return next;
    });
  }, [getLatestCustomerMessageAt]);

  const openChat = useCallback((chat) => {
    workspaceSectionRef.current = 'chats';
    setWorkspaceSection('chats');
    markChatAsRead(chat);
    setSelectedChat((prev) => mergeChatPayload(prev, chat));
    setMobilePanelOpen(false);
    if (window.innerWidth < 1024) {
      setShowMobileChat(true);
    }
    void loadChatDetails(chat?.id);
  }, [loadChatDetails, markChatAsRead, mergeChatPayload]);

  const handleChatCardClick = useCallback((chat) => {
    // so ignora click se houve drag real (movimento acima do limiar)
    if (chatDragMovedRef.current) return;
    openChat(chat);
  }, [openChat]);

  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  useEffect(() => {
    unreadByChatIdRef.current = unreadByChatId;
  }, [unreadByChatId]);

  useEffect(() => {
    const handleResize = () => setIsMobileView(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!selectedChat) {
      setShowMobileChat(false);
    }
  }, [selectedChat]);

  useEffect(() => {
    setMediaViewer({ open: false, index: 0 });
  }, [selectedChat?.id]);

  useEffect(() => {
    const focusChatId = location.state?.focusChatId;
    if (!focusChatId) return;
    localStorage.setItem('pendingActiveChatId', focusChatId);
    setPendingFocusChatId(focusChatId);
  }, [location.state]);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiRequest('/chats/my-queues');
      if (res && res.ok) {
        const data = await res.json();
        const waitingRaw = Array.isArray(data.waiting) ? data.waiting : [];
        const activeRaw = Array.isArray(data.active) ? data.active : [];
        const all = [...activeRaw, ...waitingRaw];
        const current = selectedChatRef.current;
        const currentSelectedId = current?.id || null;
        let unreadSnapshot = unreadByChatIdRef.current;

        if (!unreadBootstrappedRef.current) {
          const initialUnread = {};
          all.forEach((chat) => {
            if (!chat?.id) return;
            const latestCustomerAt = getLatestCustomerMessageAt(chat);
            lastReadCustomerAtRef.current[chat.id] = latestCustomerAt;
            initialUnread[chat.id] = 0;
          });
          unreadBootstrappedRef.current = true;
          unreadSnapshot = initialUnread;
          unreadByChatIdRef.current = initialUnread;
          setUnreadByChatId(initialUnread);
        } else {
          const nextUnread = {};
          const notifications = [];
          all.forEach((chat) => {
            if (!chat?.id) return;
            const latestCustomerAt = getLatestCustomerMessageAt(chat);
            const previousReadAt = Number(lastReadCustomerAtRef.current[chat.id] || 0);

            if (workspaceSectionRef.current === 'chats' && currentSelectedId && chat.id === currentSelectedId) {
              lastReadCustomerAtRef.current[chat.id] = Math.max(previousReadAt, latestCustomerAt);
              nextUnread[chat.id] = 0;
              return;
            }

            const unreadCount = getUnreadCustomerCount(chat, previousReadAt);
            nextUnread[chat.id] = unreadCount;
            const previousUnread = Number(unreadByChatIdRef.current[chat.id] || 0);
            if (unreadCount > previousUnread) {
              notifications.push({ chat, total: unreadCount });
            }
          });

          unreadSnapshot = nextUnread;
          unreadByChatIdRef.current = nextUnread;
          setUnreadByChatId(nextUnread);

          notifications.slice(0, 3).forEach(({ chat, total }) => {
            const displayName = String(
              chat?.customerName
              || chat?.vars?.nome_cliente
              || chat?.variables?.nome_cliente
              || chat?.channelUserId
              || 'Cliente'
            ).trim();
            const label = total > 1 ? `${total} novas mensagens` : 'Nova mensagem';
            toast.success(`${label} de ${displayName}`);
          });
        }

        setWaitingChats((prev) => {
          const waiting = applyStableChatOrder(prev, waitingRaw, 'waiting');
          return JSON.stringify(prev) !== JSON.stringify(waiting) ? waiting : prev;
        });
        setMyChats((prev) => {
          const active = applyStableChatOrder(prev, activeRaw, 'active');
          return JSON.stringify(prev) !== JSON.stringify(active) ? active : prev;
        });

        if (pendingFocusChatId) {
          const focusChat = all.find((chat) => chat.id === pendingFocusChatId);
          if (focusChat) {
            openChat(focusChat);
            localStorage.removeItem('pendingActiveChatId');
            setPendingFocusChatId(null);
          }
        }

        if (current) {
          const updated = all.find(c => c.id === current.id);
          const varsChanged = JSON.stringify(updated?.vars || {}) !== JSON.stringify(current.vars || {});
          const variablesChanged = JSON.stringify(updated?.variables || {}) !== JSON.stringify(current.variables || {});
          const messagesChanged = JSON.stringify(updated?.messages || []) !== JSON.stringify(current.messages || []);
          if (updated && (messagesChanged || varsChanged || variablesChanged)) {
            setSelectedChat(prev => mergeChatPayload(prev, updated));
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, [
    applyStableChatOrder,
    getLatestCustomerMessageAt,
    getUnreadCustomerCount,
    mergeChatPayload,
    openChat,
    pendingFocusChatId,
    user
  ]);

  useEffect(() => {
    let isMounted = true;
    let timeoutId;

    if (!user) return;

    const poll = async () => {
      await fetchAll();
      if (isMounted) {
        timeoutId = setTimeout(poll, 60000);
      }
    };

    poll();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [user, fetchAll]);

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    socketService.connect(token);

    let refreshTimeout = null;
    const refresh = () => {
      clearTimeout(refreshTimeout);
      refreshTimeout = setTimeout(() => fetchAll(), 500);
    };

    const handleRealtimeMessage = (event) => {
      const chatId = event?.chatId;
      const message = event?.message;
      if (!chatId || !message) {
        refresh();
        return;
      }

      const messageAt = parseMessageTime(message.timestamp);
      setSelectedChat((prev) => {
        if (!prev || prev.id !== chatId) return prev;
        if (workspaceSectionRef.current === 'chats' && isCustomerMessage(message)) {
          const previousReadAt = Number(lastReadCustomerAtRef.current[chatId] || 0);
          lastReadCustomerAtRef.current[chatId] = Math.max(previousReadAt, messageAt);
        }
        return {
          ...prev,
          messages: appendRealtimeMessage(prev.messages, message),
          lastMessage: message,
          lastMessageAt: message.timestamp || prev.lastMessageAt,
          messageCount: Math.max(Number(prev.messageCount || 0), (Array.isArray(prev.messages) ? prev.messages.length : 0) + 1),
          updatedAt: message.timestamp || new Date().toISOString()
        };
      });

      // Atualiza dados do card no lugar — NAO reordena a lista
      const patchChatList = (list) => (Array.isArray(list) ? list : []).map((chat) => {
        if (chat?.id !== chatId) return chat;
        return {
          ...chat,
          messages: appendRealtimeMessage(chat.messages, message),
          lastMessage: message,
          lastMessageAt: message.timestamp || chat.lastMessageAt,
          messageCount: Math.max(Number(chat.messageCount || 0), (Array.isArray(chat.messages) ? chat.messages.length : 0) + 1),
          updatedAt: message.timestamp || new Date().toISOString()
        };
      });

      setMyChats(patchChatList);
      setWaitingChats(patchChatList);
      // refresh sem reordenar (fetchAll usa ordem estavel)
      refresh();
    };

    const handleAgentAssigned = (event) => {
      const chat = event?.chat;
      if (chat?.id) {
        setSelectedChat((prev) => {
          if (!prev || prev.id !== chat.id) return prev;
          return {
            ...prev,
            ...chat,
            messages: Array.isArray(chat.messages) && chat.messages.length
              ? chat.messages
              : prev.messages,
            vars: { ...(prev.vars || {}), ...(chat.vars || {}) },
            variables: { ...(prev.variables || {}), ...(chat.variables || {}) }
          };
        });
      }
      refresh();
    };

    const handleChatClosed = (event) => {
      const closedId = event?.chatId;
      if (closedId) {
        setSelectedChat((prev) => (prev?.id === closedId ? null : prev));
        setMyChats((list) => (Array.isArray(list) ? list.filter((c) => c?.id !== closedId) : list));
        setWaitingChats((list) => (Array.isArray(list) ? list.filter((c) => c?.id !== closedId) : list));
      }
      refresh();
    };

    socketService.on('message', handleRealtimeMessage);
    socketService.on('new_chat', refresh);
    socketService.on('queue_update', refresh);
    socketService.on('agent_assigned', handleAgentAssigned);
    socketService.on('chat_closed', handleChatClosed);

    return () => {
      socketService.off('message', handleRealtimeMessage);
      socketService.off('new_chat', refresh);
      socketService.off('queue_update', refresh);
      socketService.off('agent_assigned', handleAgentAssigned);
      socketService.off('chat_closed', handleChatClosed);
      clearTimeout(refreshTimeout);
    };
  }, [appendRealtimeMessage, fetchAll, isCustomerMessage, parseMessageTime, user]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        if (!user?.tenantId) return;
        const res = await apiRequest(`/tenants/${user.tenantId}/settings`);
        if (res && res.ok) {
          const settings = await res.json();
          setVisibleVars(settings.agentViewVars || []);
        }
      } catch (error) {
        console.error('Erro ao carregar settings:', error);
      }
    };
    loadSettings();
  }, [user?.tenantId]);

  useEffect(() => {
    const loadRootVars = async () => {
      try {
        const res = await apiRequest('/variables');
        if (res && res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : [];
          setRootVars(list.filter(v => v.isRoot === true && v.enabled !== false));
        }
      } catch (error) {
        console.error('Erro ao carregar variáveis root:', error);
      }
    };
    loadRootVars();
  }, []);

  useEffect(() => {
    const loadQuickReplies = async () => {
      try {
        const [templatesRes, quickRes] = await Promise.all([
          apiRequest('/templates'),
          apiRequest('/cannedResponses'),
        ]);
        const templateData = templatesRes?.ok ? await templatesRes.json() : [];
        const quickData = quickRes?.ok ? await quickRes.json() : [];
        const templates = Array.isArray(templateData) ? templateData : [];
        const responses = Array.isArray(quickData) ? quickData : [];
        setAppTemplates(templates);
        setQuickReplies([
          ...responses.map((item) => ({ ...item, text: item.message || '' })),
          ...templates.filter((item) => item.scope === 'root'),
        ]);
      } catch (error) {
        console.error('Erro ao carregar respostas rapidas:', error);
      }
    };
    loadQuickReplies();
  }, []);

  useEffect(() => {
    const loadContacts = async () => {
      try {
        const res = await apiRequest('/contacts?limit=500');
        if (res && res.ok) {
          const data = await res.json();
          setContacts(Array.isArray(data) ? data : []);
        }
      } catch (error) {
        console.error('Erro ao carregar contatos:', error);
      }
    };
    loadContacts();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const messages = selectedChat?.messages;
    const chatChanged = lastScrolledChatIdRef.current !== selectedChat?.id;
    lastScrolledChatIdRef.current = selectedChat?.id || null;
    const sentByMe = Array.isArray(messages) && messages[messages.length - 1]?.sender === 'agent';
    if (chatChanged || sentByMe || nearBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: chatChanged ? 'auto' : 'smooth' });
    }
  }, [selectedChat?.messages, selectedChat?.id]);

  const handleMessagesScroll = (event) => {
    const el = event.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < 120;
    setShowJumpToEnd(distance > 200);
  };

  // Limpa o "respondendo a" ao trocar de atendimento.
  useEffect(() => { setReplyingTo(null); }, [selectedChat?.id]);

  // Limpa o timer de highlight ao desmontar.
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const handlePickup = async (chat) => {
    if (!can(user, 'atendimento.fila')) return toast.error('Seu cargo não permite atender conversas.');
    try {
      const res = await apiRequest('/chats/pickup', {
        method: 'POST',
        body: JSON.stringify({ chatId: chat.id })
      });
      if (res && res.ok) {
        const updatedChat = await res.json();
        openChat(updatedChat);
        toast.success("Atendimento iniciado!");
      } else {
        toast.error("Não foi possível puxar este atendimento.");
      }
    } catch (e) {
      console.error(e);
      toast.error("Erro ao puxar atendimento");
    }
  };

  const openBulkPickupModal = () => {
    if (waitingChats.length === 0) return toast.error('Nao ha atendimentos em espera.');
    setBulkPickupModal({ open: true, message: '', loading: false });
  };

  const closeBulkPickupModal = () => {
    setBulkPickupModal((prev) => (
      prev.loading
        ? prev
        : { open: false, message: '', loading: false }
    ));
  };

  const handleBulkPickup = async () => {
    if (bulkPickupModal.loading) return;
    try {
      setBulkPickupModal((prev) => ({ ...prev, loading: true }));
      const res = await apiRequest('/chats/pickup-all', {
        method: 'POST',
        body: JSON.stringify({ message: bulkPickupModal.message })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) {
        throw new Error(data?.error || 'Falha ao puxar atendimentos.');
      }

      const pickedCount = Number(data?.pickedCount || 0);
      const failedCount = Number(data?.failedCount || 0);
      const chats = Array.isArray(data?.chats) ? data.chats : [];
      if (pickedCount > 0) {
        setMyChats((prev) => applyStableChatOrder(prev, [...chats, ...prev], 'active'));
        setWaitingChats((prev) => {
          const next = prev.filter((chat) => !chats.some((picked) => picked.id === chat.id));
          saveChatOrder(user?.id, 'waiting', next);
          return next;
        });
        openChat(chats[0]);
      }
      toast.success(`${pickedCount} atendimento(s) puxado(s)${failedCount ? `, ${failedCount} falharam` : ''}.`);
      setBulkPickupModal({ open: false, message: '', loading: false });
      fetchAll();
    } catch (error) {
      toast.error(error?.message || 'Falha ao puxar atendimentos.');
      setBulkPickupModal((prev) => ({ ...prev, loading: false }));
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!can(user, 'atendimento.fila')) return toast.error('Seu cargo não permite atender conversas.');
    if (!agentInput.trim() || !selectedChat) return;
    if (selectedChat.status === 'waiting') return toast.error("Puxe o atendimento antes de responder.");
    if (selectedChat.outreachPendingReply === true) return toast.error("Aguarde a primeira resposta do cliente antes de enviar mensagens.");

    const textToSend = agentInput;
    const replyTo = replyingTo || null;
    setAgentInput('');
    setReplyingTo(null);
    sendAgentText(textToSend, replyTo);
  };

  // O balao sai na hora com um spinner; a resposta do POST troca pela mensagem
  // gravada. Se falhar, o X vermelho reenvia ao clicar.
  const sendAgentText = async (textToSend, replyTo = null) => {
    const chatId = selectedChat?.id;
    if (!chatId) return;
    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const patchChat = (update) => setSelectedChat((prev) => (prev && prev.id === chatId ? update(prev) : prev));
    patchChat((prev) => ({
      ...prev,
      messages: [...(Array.isArray(prev.messages) ? prev.messages : []), {
        id: localId,
        sender: 'agent',
        agentName: user.name,
        text: textToSend,
        timestamp: new Date().toISOString(),
        localPending: true,
        ...(replyTo ? { replyTo: { messageId: replyTo.id, sender: replyTo.sender, preview: replyTo.preview } } : {})
      }]
    }));

    try {
      const res = await apiRequest(`/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          sender: 'agent',
          agentName: user.name,
          text: textToSend,
          ...(replyTo?.id ? { replyToMessageId: replyTo.id } : {})
        })
      });

      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Falha no envio');
      const savedMsg = data;
      patchChat((prev) => ({
        ...prev,
        messages: appendRealtimeMessage((prev.messages || []).filter((message) => message?.id !== localId), savedMsg),
        lastMessage: savedMsg,
        lastMessageAt: savedMsg?.timestamp || prev?.lastMessageAt,
        updatedAt: savedMsg?.timestamp || new Date().toISOString()
      }));
      if (data?.genesys && data.genesys.relayed === false && !data.genesys.skipped) {
        toast.error(
          data.genesys.reason === 'extension_offline'
            ? 'Mensagem salva, mas a extensão Genesys está offline'
            : 'Mensagem salva, mas não foi possível enviar ao Genesys'
        );
      }
    } catch (error) {
      console.error("Erro ao enviar:", error);
      patchChat((prev) => ({
        ...prev,
        messages: (prev.messages || []).map((message) => (
          message?.id === localId
            ? { ...message, localPending: false, localFailed: true, failureReason: error?.message || null }
            : message
        ))
      }));
      toast.error(error?.message || "Falha no envio");
    }
  };

  const retryLocalMessage = (message) => {
    if (!message?.localFailed || !selectedChat) return;
    setSelectedChat((prev) => (prev ? { ...prev, messages: (prev.messages || []).filter((item) => item?.id !== message.id) } : prev));
    sendAgentText(message.text, message.replyTo ? { id: message.replyTo.messageId, sender: message.replyTo.sender, preview: message.replyTo.preview } : null);
  };

  const handleAgentInputKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    event.preventDefault();
    handleSend(event);
  };

  // Ao clicar no preview de um reply, rola até a mensagem original e destaca
  // por ~1.5s. Usa id no DOM (agentmsg-<id>) em vez de refs por causa do
  // volume dinâmico de mensagens.
  const scrollToMessage = (messageId) => {
    if (!messageId) return;
    const el = document.getElementById(`agentmsg-${messageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
  };

  const handleClose = async () => {
    const ok = await confirm({
      title: 'Encerrar atendimento',
      message: 'Tem certeza que deseja encerrar esta conversa?',
      confirmText: 'Encerrar',
      type: 'danger',
    });
    if (!ok) return;

    const continueFlow = selectedChat?.continueFlowAfterQueue ?? false;

    try {
      const res = await apiRequest(`/chats/${selectedChat.id}/close`, {
        method: 'PUT',
        body: JSON.stringify({ continueFlow })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) {
        throw new Error(data?.error || 'Erro ao encerrar');
      }
      setSelectedChat(null);
      toast.success("Atendimento encerrado");
      if (data?.genesys && data.genesys.relayed === false && !data.genesys.skipped) {
        toast.error(
          data.genesys.reason === 'extension_offline'
            ? 'Encerrado no app, mas a extensão Genesys está offline'
            : 'Encerrado no app, mas não foi possível avisar o Genesys'
        );
      }
    } catch (error) {
      toast.error(error?.message || "Erro ao encerrar");
    }
  };

  const closeTransferModal = () => {
    setTransferModal((prev) => (
      prev.submitting
        ? prev
        : {
          open: false,
          loading: false,
          submitting: false,
          mode: 'queue',
          queue: '',
          agentId: '',
          reason: '',
          queues: [],
          agents: []
        }
    ));
  };

  const openTransferModal = async () => {
    if (!selectedChat || selectedChat.status === 'waiting') return;
    setTransferModal((prev) => ({
      ...prev,
      open: true,
      loading: true,
      submitting: false,
      mode: 'queue',
      queue: selectedChat.queue || '',
      agentId: '',
      reason: ''
    }));
    try {
      const res = await apiRequest('/chats/transfer-options');
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao carregar opcoes de transferencia.');
      const queues = Array.isArray(data.queues) ? data.queues : [];
      const agents = Array.isArray(data.agents) ? data.agents : [];
      setTransferModal((prev) => ({
        ...prev,
        loading: false,
        queues,
        agents,
        queue: prev.queue || queues[0]?.name || '',
        agentId: agents[0]?.id || ''
      }));
    } catch (error) {
      toast.error(error?.message || 'Falha ao carregar transferencia.');
      closeTransferModal();
    }
  };

  const handleTransferChat = async () => {
    if (!selectedChat || transferModal.submitting) return;
    const toQueue = transferModal.mode === 'queue';
    const queue = toQueue ? transferModal.queue : '';
    const agentId = toQueue ? '' : transferModal.agentId;
    if (toQueue && !queue) return toast.error('Selecione uma fila.');
    if (!toQueue && !agentId) return toast.error('Selecione um agente.');

    try {
      setTransferModal((prev) => ({ ...prev, submitting: true }));
      const targetAgent = transferModal.agents.find((agent) => agent.id === agentId);
      const res = await apiRequest('/chats/transfer', {
        method: 'POST',
        body: JSON.stringify({
          chatId: selectedChat.id,
          queue,
          agentId: agentId || null,
          agentName: targetAgent?.name || null,
          reason: transferModal.reason || 'Transferencia pelo agente',
          continueFlow: selectedChat.continueFlowAfterQueue ?? false
        })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao transferir atendimento.');

      toast.success(data?.message || 'Atendimento transferido.');
      setSelectedChat(null);
      setTransferModal({
        open: false,
        loading: false,
        submitting: false,
        mode: 'queue',
        queue: '',
        agentId: '',
        reason: '',
        queues: [],
        agents: []
      });
      await fetchAll();
    } catch (error) {
      toast.error(error?.message || 'Falha ao transferir atendimento.');
      setTransferModal((prev) => ({ ...prev, submitting: false }));
    }
  };

  const chatVars = { ...(selectedChat?.variables || {}), ...(selectedChat?.vars || {}) };
  const selectedChatReplyLocked = selectedChat?.status === 'waiting' || selectedChat?.outreachPendingReply === true;

  const getQueueLabel = (chat) => {
    if (chat?.activeOutreach) return 'ATIVO';
    return String(chat?.queue || '').trim();
  };

  const normalizeKey = (value) => String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const resolveVarValue = (name) => {
    if (!name) return undefined;
    if (Object.prototype.hasOwnProperty.call(chatVars, name)) return chatVars[name];
    const target = normalizeKey(name);
    const entry = Object.entries(chatVars).find(([key]) => normalizeKey(key) === target);
    return entry ? entry[1] : undefined;
  };

  const resolveVarValueFromChat = useCallback((chat, name) => {
    if (!chat || !name) return undefined;
    const vars = { ...(chat?.variables || {}), ...(chat?.vars || {}) };
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    const target = normalizeKey(name);
    const entry = Object.entries(vars).find(([key]) => normalizeKey(key) === target);
    return entry ? entry[1] : undefined;
  }, []);

  const getChatWaId = useCallback((chat) => {
    if (!chat) return null;
    const direct = chat?.channelUserId || chat?.channelChatId || chat?.customerCpf;
    const fromVars = (
      resolveVarValueFromChat(chat, 'WA_ID')
      ?? resolveVarValueFromChat(chat, 'wa_id')
      ?? resolveVarValueFromChat(chat, 'whatsapp_id')
      ?? resolveVarValueFromChat(chat, 'contato_telefone')
      ?? resolveVarValueFromChat(chat, 'telefone')
      ?? resolveVarValueFromChat(chat, 'numero_telefone')
    );
    return String(fromVars || direct || '').trim() || null;
  }, [resolveVarValueFromChat]);

  const contactNameByPhone = (() => {
    const map = new Map();
    (Array.isArray(contacts) ? contacts : []).forEach((contact) => {
      const contactName = String(contact?.name || '').trim();
      if (!contactName) return;

      const phones = Array.isArray(contact?.phones) ? contact.phones : [];
      phones.forEach((phone) => {
        const candidates = [
          phone?.waId,
          phone?.number,
          phone?.normalizedNumber
        ];
        candidates.forEach((candidate) => {
          const raw = String(candidate || '').trim();
          const digits = normalizeDigits(raw);
          if (raw) map.set(raw, contactName);
          if (digits) map.set(digits, contactName);
        });
      });

      const primaryRaw = String(contact?.primaryPhone || '').trim();
      const primaryDigits = normalizeDigits(primaryRaw);
      if (primaryRaw) map.set(primaryRaw, contactName);
      if (primaryDigits) map.set(primaryDigits, contactName);
    });
    return map;
  })();

  const resolveContactNameForChat = (chat) => {
    if (!chat) return null;
    const waId = getChatWaId(chat);
    if (!waId) return null;
    const raw = String(waId).trim();
    const digits = normalizeDigits(raw);
    return contactNameByPhone.get(raw) || contactNameByPhone.get(digits) || null;
  };

  const customerWhatsAppValue = selectedChat?.channel === 'whatsapp'
    ? (
      selectedChat?.activeOutreach
        ? (
          resolveVarValue('contato_telefone')
          ?? resolveVarValue('telefone')
          ?? resolveVarValue('numero_telefone')
          ?? selectedChat?.channelUserId
        )
        : (
          resolveVarValue('WA_ID')
          ?? resolveVarValue('wa_id')
          ?? resolveVarValue('whatsapp_id')
          ?? selectedChat?.channelUserId
        )
    )
    : null;

  const customerWhatsAppLabel = selectedChat?.activeOutreach ? 'Numero' : 'WA ID';

  const renderTemplateText = (text) => {
    if (!text) return '';
    return text.replace(/\{([\w.-]+)\}/g, (match, key) => {
      if (key === 'nome_agente') return user?.name || match;
      const value = chatVars?.[key];
      return value !== undefined && value !== null ? String(value) : match;
    });
  };

  const handleQuickSelect = (template) => {
    const filled = renderTemplateText(template.text || '');
    setQuickDraft(filled);
    setMobilePanelOpen(false);
    setShowQuickModal(true);
  };

  const handleQuickSend = async () => {
    if (!quickDraft.trim() || !selectedChat) return;
    if (selectedChat.status === 'waiting') return toast.error("Puxe o atendimento antes de responder.");
    if (selectedChat.outreachPendingReply === true) return toast.error("Aguarde a primeira resposta do cliente antes de enviar mensagens.");
    try {
      const replyToMessageId = replyingTo?.id || null;
      const res = await apiRequest(`/chats/${selectedChat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          sender: 'agent',
          agentName: user.name,
          text: quickDraft,
          ...(replyToMessageId ? { replyToMessageId } : {})
        })
      });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (res && res.ok) {
        const savedMsg = data;
        setReplyingTo(null);
        setSelectedChat(prev => ({
          ...prev,
          messages: appendRealtimeMessage(prev?.messages, savedMsg)
        }));
        setShowQuickModal(false);
        setQuickDraft('');
      } else {
        toast.error(data?.error || 'Falha no envio');
      }
    } catch (error) {
      toast.error('Falha no envio');
    }
  };

  const filterVars = (vars) => {
    if (!vars) return [];
    const entries = Object.entries(vars);
    if (!visibleVars || visibleVars.length === 0) return entries;
    return entries.filter(([key]) => visibleVars.includes(key));
  };

  const formatWait = (chat) => {
    const since = chat.waitingSince || chat.transferredAt || chat.createdAt;
    if (!since) return '0s';
    const diff = Math.max(0, tick - new Date(since).getTime());
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const formatTime = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const getLastMessagePreview = (chat) => {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const lastMessage = messages[messages.length - 1] || chat?.lastMessage || null;
    if (!lastMessage) {
      return chat?.status === 'waiting' ? 'Aguardando atendimento' : 'Sem mensagens ainda';
    }
    if (lastMessage?.media?.voice) {
      const total = Number(lastMessage.media.durationSeconds) || 0;
      return total ? `Mensagem de voz (${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')})` : 'Mensagem de voz';
    }
    if (lastMessage?.media?.fileName) return lastMessage.media.fileName;
    if (lastMessage?.media?.type) return `[${lastMessage.media.type}]`;
    return String(lastMessage?.text || '').trim() || 'Sem mensagens';
  };

  const formatFileSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const closeMediaModal = useCallback(() => {
    setMediaModal((prev) => {
      if (prev.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return {
        open: false,
        file: null,
        previewUrl: '',
        previewKind: 'document',
        caption: '',
        uploading: false
      };
    });
  }, []);

  const handleMediaFileSelected = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const type = String(file.type || '').toLowerCase();
    const previewKind = type.startsWith('image/')
      ? 'image'
      : type.startsWith('video/')
        ? 'video'
        : type.startsWith('audio/')
          ? 'audio'
          : 'document';
    const previewUrl = URL.createObjectURL(file);

    setMediaModal((prev) => {
      if (prev.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return {
        open: true,
        file,
        previewUrl,
        previewKind,
        caption: '',
        uploading: false
      };
    });
  }, []);

  const openMediaPicker = () => {
    if (!selectedChat) return;
    if (selectedChatReplyLocked) return toast.error('Aguarde a primeira resposta do cliente antes de enviar mensagens.');
    mediaInputRef.current?.click();
  };

  // Mensagem de voz: grava em OGG/OPUS, sobe como asset e envia com voice: true.
  const [voiceSending, setVoiceSending] = useState(false);
  const sendVoiceNote = async (blob, durationSeconds) => {
    const chat = selectedChat;
    if (!chat) return;
    setVoiceSending(true);
    try {
      const file = new File([blob], `audio-${Date.now()}.ogg`, { type: 'audio/ogg' });
      const asset = await uploadMediaAsset(file);
      const replyToMessageId = replyingTo?.id || null;
      const res = await apiRequest(`/chats/${chat.id}/media`, {
        method: 'POST',
        body: JSON.stringify({
          sender: 'agent',
          agentName: user.name,
          mediaType: 'audio',
          voice: true,
          durationSeconds,
          mediaUrl: asset.url,
          fileName: asset.originalName || file.name,
          mimeType: 'audio/ogg',
          caption: '',
          ...(replyToMessageId ? { replyToMessageId } : {})
        })
      });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (res && res.ok) {
        setReplyingTo(null);
        setSelectedChat((prev) => (prev?.id !== chat.id ? prev : {
          ...prev,
          messages: appendRealtimeMessage(prev?.messages, data),
          lastMessage: data,
          lastMessageAt: data?.timestamp || prev?.lastMessageAt,
          updatedAt: data?.timestamp || new Date().toISOString()
        }));
      } else {
        toast.error(data?.error || 'Falha ao enviar o áudio');
      }
    } catch (error) {
      toast.error(error?.message || 'Falha ao enviar o áudio');
    } finally {
      setVoiceSending(false);
    }
  };
  const voice = useVoiceNote({ onRecorded: sendVoiceNote });
  const startVoiceNote = async () => {
    if (selectedChatReplyLocked) return;
    try {
      await voice.start();
    } catch (error) {
      toast.error(error?.name === 'NotAllowedError' ? 'Permita o uso do microfone no navegador para gravar.' : (error?.message || 'Não foi possível acessar o microfone.'));
    }
  };
  const voiceCancel = voice.cancel;
  useEffect(() => { voiceCancel(); }, [selectedChat?.id, voiceCancel]);
  const formatVoiceTime = (total) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

  const handleSendMedia = async () => {
    if (!selectedChat || !mediaModal.file) return;
    if (selectedChat.status === 'waiting') return toast.error('Puxe o atendimento antes de enviar mensagens.');
    if (selectedChat.outreachPendingReply === true) return toast.error('Aguarde a primeira resposta do cliente antes de enviar mensagens.');

    try {
      setMediaModal((prev) => ({ ...prev, uploading: true }));
      const asset = await uploadMediaAsset(mediaModal.file);
      const mimeType = String(asset?.mimeType || mediaModal.file.type || '').toLowerCase();
      const mediaType = mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('video/')
          ? 'video'
          : mimeType.startsWith('audio/')
            ? 'audio'
            : 'document';

      const replyToMessageId = replyingTo?.id || null;
      const res = await apiRequest(`/chats/${selectedChat.id}/media`, {
        method: 'POST',
        body: JSON.stringify({
          sender: 'agent',
          agentName: user.name,
          mediaType,
          mediaUrl: asset.url,
          fileName: asset.originalName || mediaModal.file.name,
          mimeType: asset.mimeType || mediaModal.file.type || '',
          caption: mediaModal.caption || '',
          ...(replyToMessageId ? { replyToMessageId } : {})
        })
      });

      const data = res ? await res.json().catch(() => ({})) : null;
      if (res && res.ok) {
        setReplyingTo(null);
        setSelectedChat((prev) => ({
          ...prev,
          messages: appendRealtimeMessage(prev?.messages, data),
          lastMessage: data,
          lastMessageAt: data?.timestamp || prev?.lastMessageAt,
          updatedAt: data?.timestamp || new Date().toISOString()
        }));
        closeMediaModal();
      } else {
        toast.error(data?.error || 'Falha ao enviar midia');
        setMediaModal((prev) => ({ ...prev, uploading: false }));
      }
    } catch (error) {
      toast.error(error?.message || 'Falha ao enviar midia');
      setMediaModal((prev) => ({ ...prev, uploading: false }));
    }
  };

  useEffect(() => () => {
    if (mediaModal.previewUrl) {
      URL.revokeObjectURL(mediaModal.previewUrl);
    }
  }, [mediaModal.previewUrl]);

  if (!user) return <CenterSkeleton />;

  const renderChatListItem = (chat, tone = 'active') => {
    const chatId = String(chat?.id || '');
    const selected = Boolean(selectedChat?.id) && String(selectedChat.id) === chatId;
    const waitingTone = tone === 'waiting';
    const isDragging = draggingChatId === chatId;
    const resolvedContactName = resolveContactNameForChat(chat);
    const resolvedWaId = getChatWaId(chat);
    const name = resolvedContactName
      || chat.customerName
      || chat.vars?.nome_cliente
      || chat.variables?.nome_cliente
      || resolvedWaId
      || (waitingTone ? 'Anonimo' : 'Cliente');
    const preview = getLastMessagePreview(chat);
    const channel = String(chat?.channel || '').trim();
    const queueLabel = getQueueLabel(chat);
    const lastMessage = Array.isArray(chat?.messages) ? chat.messages[chat.messages.length - 1] : null;
    const unreadCount = Number(unreadByChatId[chat.id] || 0);
    // Ambos os cards (espera e em atendimento) usam o mesmo padrao operacional
    // definido em agent-operational.css: flat, cantos retos, borda fina, com a
    // cor apenas como acento de status (laranja = espera, azul = em atendimento).
    // As classes dedicadas .agent-waiting-card / .agent-active-card permitem
    // repor essas cores vencendo o coringa [class*="bg-orange-|emerald-"] que o
    // tema aplica no workspace, sem afetar o restante da tela.
    const shellClass = waitingTone
      ? (selected ? 'agent-waiting-card is-selected' : 'agent-waiting-card')
      : (selected ? 'agent-active-card is-selected' : 'agent-active-card');
    const selectedOutlineClass = '';

    return (
      <Reorder.Item
        key={chatId}
        value={chatId}
        as="div"
        dragListener
        dragElastic={0.12}
        onDragStart={() => handleChatCardDragStart(chatId)}
        onDrag={handleChatCardDrag}
        onDragEnd={handleChatCardDragEnd}
        whileDrag={{
          scale: 1.02,
          zIndex: 50,
          cursor: 'grabbing'
        }}
        transition={{ type: 'spring', stiffness: 480, damping: 36, mass: 0.65 }}
        className={`agent-chat-card mx-2 my-1 w-[calc(100%-1rem)] ${isDragging ? 'agent-chat-card-dragging' : ''}`}
        style={{ position: 'relative', touchAction: 'none', zIndex: isDragging ? 50 : 'auto', cursor: isDragging ? 'grabbing' : 'pointer' }}
      >
        <div
          className={`ui-card-hover border p-2 text-left transition-[border-color,box-shadow,background-color] duration-150 ${shellClass} ${selectedOutlineClass}`}
          data-selected={selected ? 'true' : 'false'}
          data-chat-id={chatId}
        >
          <button
            type="button"
            onClick={() => handleChatCardClick(chat)}
            className={`flex w-full min-w-0 items-start gap-2 text-left ${isDragging ? 'cursor-grabbing' : 'cursor-pointer'}`}
            title="Arraste o card para reordenar"
          >
            <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${waitingTone ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300' : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300'}`}>
              <User size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-900 dark:text-white">{name}</div>
                  {channel || queueLabel ? (
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {channel ? renderChannelBadge(channel) : null}
                      {queueLabel ? (
                        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${waitingTone ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'}`}>
                          {queueLabel}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {unreadCount > 0 ? (
                    <span className="inline-flex min-w-[18px] justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  ) : null}
                  <span className="text-[10px] font-medium text-gray-400">
                    {formatTime(lastMessage?.timestamp || chat.updatedAt || chat.createdAt)}
                  </span>
                </div>
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">{preview}</div>
              {waitingTone ? (
                <div className="mt-1 text-[10px] font-semibold text-orange-600 dark:text-orange-300">
                  Esperando ha {formatWait(chat)}
                </div>
              ) : null}
            </div>
          </button>
        </div>
      </Reorder.Item>
    );
  };

  const renderInfoPanel = () => (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[10px] font-bold uppercase text-gray-500 dark:text-gray-400">Info do cliente</div>
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">CPF</span>
            <span className="font-semibold text-gray-800 dark:text-gray-200">{formatWorkspaceValue(chatVars?.cpf)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">Nome</span>
            <span className="font-semibold text-gray-800 dark:text-gray-200">
              {formatWorkspaceValue(resolveContactNameForChat(selectedChat) || selectedChat?.customerName || chatVars?.nome_cliente || getChatWaId(selectedChat))}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">Telefone</span>
            <span className="break-all text-right font-semibold text-gray-800 dark:text-gray-200">
              {formatWorkspaceValue(chatVars?.telefone || selectedChat?.customerPhone || customerWhatsAppValue)}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">Endereco</span>
            <span className="max-w-[150px] break-words text-right font-semibold text-gray-800 dark:text-gray-200">
              {formatWorkspaceValue(chatVars?.endereco)}
            </span>
          </div>
          {chatVars?.filial ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Filial</span>
              <span className="font-semibold text-gray-800 dark:text-gray-200">{formatWorkspaceValue(chatVars.filial)}</span>
            </div>
          ) : null}
          {chatVars?.ativo ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Ativo</span>
              <span className="font-semibold text-gray-800 dark:text-gray-200">{formatWorkspaceValue(chatVars.ativo)}</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">Canal</span>
            <span className="font-semibold text-gray-800 dark:text-gray-200">{selectedChat?.channel || 'web'}</span>
          </div>
          {customerWhatsAppValue ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">{customerWhatsAppLabel}</span>
              <span className="break-all text-right font-semibold text-gray-800 dark:text-gray-200">{String(customerWhatsAppValue)}</span>
            </div>
          ) : null}
        </div>
      </div>

      {selectedChat?.commercialInsights ? (
        <div>
          <div className="mb-2 text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Contexto comercial</div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Intencao</span>
              <span className="text-right font-semibold text-gray-800 dark:text-gray-200">{selectedChat.commercialInsights.intent || '-'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-500">Proxima acao</span>
              <span className="text-right font-semibold text-gray-800 dark:text-gray-200">{selectedChat.commercialInsights.nextAction || '-'}</span>
            </div>
            <div className="border-l-2 border-blue-500 pl-2 text-gray-600 dark:text-gray-300">
              {selectedChat.commercialInsights.reason || 'Sem resumo disponivel.'}
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-2 text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Variaveis root</div>
        {rootVars.length === 0 ? (
          <div className="text-xs text-gray-400">Nenhuma variavel root ativa.</div>
        ) : (
          <div className="space-y-2">
            {rootVars.map((v) => (
              <div key={v.id} className="flex justify-between gap-2 text-sm">
                <span className="text-gray-500">{v.name}</span>
                <span className="max-w-[140px] truncate font-semibold text-gray-800 dark:text-gray-200">
                  {formatWorkspaceValue(resolveVarValue(v.name) ?? v.defaultValue)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderQuickRepliesPanel = () => (
    <div>
      <div className="mb-2 text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Mensagens rapidas</div>
      {quickReplies.length === 0 ? (
        <div className="text-xs text-gray-400">Nenhuma resposta rapida configurada.</div>
      ) : (
        <div className="space-y-2">
          {quickReplies.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => handleQuickSelect(tpl)}
              className="w-full text-left text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              <div className="font-semibold text-gray-800 dark:text-gray-200">{tpl.name}</div>
              <div className="text-[11px] text-gray-500 line-clamp-2">{tpl.text}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const selectedChatName = (visibleVars.length === 0 || visibleVars.includes('nome_cliente'))
    ? (
      resolveContactNameForChat(selectedChat)
      || selectedChat?.customerName
      || selectedChat?.variables?.nome_cliente
      || selectedChat?.vars?.nome_cliente
      || getChatWaId(selectedChat)
      || 'Visitante'
    )
    : (getChatWaId(selectedChat) || 'Visitante');
  const selectedChatCpf = (visibleVars.length === 0 || visibleVars.includes('cpf'))
    ? (selectedChat?.variables?.cpf || selectedChat?.vars?.cpf || 'N/A')
    : null;
  const rootOnlyVarMap = Object.fromEntries(
    rootVars
      .map((variable) => [
        variable.name,
        resolveVarValue(variable.name) ?? variable.defaultValue ?? ''
      ])
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
  );
  const visibleChatVars = selectedChat?.status === 'open' ? filterVars(rootOnlyVarMap) : [];
  const showListPanel = !isMobileView || !showMobileChat;
  const showChatPanel = !isMobileView || showMobileChat;

  return (
    <div className="workspace-sections">
      <nav className="workspace-section-nav" aria-label="Secoes do workspace">
        <button type="button" aria-pressed={workspaceSection === 'chats'} onClick={() => { workspaceSectionRef.current = 'chats'; setWorkspaceSection('chats'); if (selectedChat) markChatAsRead(selectedChat); }}><MessageCircle size={15} />Conversas</button>
        <button type="button" aria-pressed={workspaceSection === 'tasks'} onClick={() => { workspaceSectionRef.current = 'tasks'; setWorkspaceSection('tasks'); }}><FileText size={15} />Tarefas</button>
      </nav>
      {workspaceSection === 'tasks' && <AgentTasks key={`${user.tenantId}:${user.id}`} user={user} />}
    <div style={workspaceSection === 'tasks' ? { display: 'none' } : undefined} className="agent-operational agent-workspace relative flex h-full w-full min-h-0 overflow-hidden bg-slate-100 dark:bg-slate-950">
      <input
        ref={mediaInputRef}
        type="file"
        className="hidden"
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
        onChange={handleMediaFileSelected}
      />

      {showListPanel ? (
      <aside className={`w-full lg:w-[280px] lg:min-w-[280px] bg-slate-50 dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col z-10 lg:max-h-none ${isMobileView ? 'ui-mobile-list-enter' : ''}`}>
        <div className="border-b border-slate-200 bg-white/90 px-3 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">{user.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Online
              </div>
            </div>
            <div className="rounded-lg bg-slate-100 px-2 py-1.5 text-right dark:bg-slate-800">
              <div className="flex items-center justify-end gap-1">{renderStars(user.ratingAvg)}</div>
              <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">{Number(user.ratingAvg || 0).toFixed(1)} ({user.ratingCount || 0})</div>
            </div>
          </div>
          {isMobileView ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              <button type="button" onClick={() => setMobileListTab('active')} className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${mobileListTab === 'active' ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>Ativos ({myChats.length})</button>
              <button type="button" onClick={() => setMobileListTab('waiting')} className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${mobileListTab === 'waiting' ? 'bg-white text-orange-600 shadow-sm dark:bg-slate-700 dark:text-orange-300' : 'text-slate-500 dark:text-slate-300'}`}>Fila ({waitingChats.length})</button>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          {!isMobileView || mobileListTab === 'active' ? (
            <section className={!isMobileView ? 'border-b border-slate-200 dark:border-slate-800' : ''}>
              {!isMobileView ? <div className="sticky top-0 z-10 border-b border-blue-100 bg-blue-50/95 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 backdrop-blur dark:border-blue-900/30 dark:bg-blue-900/20 dark:text-blue-300">Em atendimento</div> : null}
              {myChats.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-slate-400">Nenhum atendimento ativo agora.</div>
              ) : (
                <Reorder.Group
                  as="div"
                  axis="y"
                  layoutScroll
                  values={myChats.map((chat) => String(chat.id))}
                  onReorder={(nextIds) => handleChatListReorderByIds('active', nextIds, myChats)}
                  className="agent-chat-reorder-group flex flex-col"
                >
                  {myChats.map((chat) => renderChatListItem(chat, 'active'))}
                </Reorder.Group>
              )}
            </section>
          ) : null}

          {!isMobileView || mobileListTab === 'waiting' ? (
            <section>
              {!isMobileView ? (
                <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y border-orange-100 bg-orange-50/95 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-orange-700 backdrop-blur dark:border-orange-900/30 dark:bg-orange-900/20 dark:text-orange-300">
                  <span>Fila de espera</span>
                  {waitingChats.length > 0 ? (
                    <button
                      type="button"
                      onClick={openBulkPickupModal}
                      className="inline-flex items-center gap-1 rounded-full bg-orange-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-orange-600"
                    >
                      <Play size={10} fill="currentColor" />
                      Puxar todos
                    </button>
                  ) : null}
                </div>
              ) : waitingChats.length > 0 ? (
                <div className="px-2 pt-2">
                  <button
                    type="button"
                    onClick={openBulkPickupModal}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-orange-500 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-orange-600"
                  >
                    <Play size={12} fill="currentColor" />
                    Puxar todos em espera
                  </button>
                </div>
              ) : null}
              {waitingChats.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-slate-400">Fila vazia.</div>
              ) : (
                <Reorder.Group
                  as="div"
                  axis="y"
                  layoutScroll
                  values={waitingChats.map((chat) => String(chat.id))}
                  onReorder={(nextIds) => handleChatListReorderByIds('waiting', nextIds, waitingChats)}
                  className="agent-chat-reorder-group flex flex-col"
                >
                  {waitingChats.map((chat) => renderChatListItem(chat, 'waiting'))}
                </Reorder.Group>
              )}
            </section>
          ) : null}
        </div>
      </aside>
      ) : null}

      {showChatPanel ? (
      <main className={`flex-1 flex flex-col bg-slate-100 dark:bg-slate-950 relative min-w-0 ${isMobileView ? 'ui-mobile-chat-enter' : ''}`}>
        {selectedChat ? (
          <>
            <header className="z-10 border-b border-slate-200 bg-white/90 px-2.5 py-2 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 lg:px-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {isMobileView ? <button type="button" onClick={() => setShowMobileChat(false)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"><ArrowLeft size={16} /></button> : null}
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300"><User size={16} /></div>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">{selectedChatName}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">{renderChannelBadge(selectedChat.channel)}<span className="truncate">{getQueueLabel(selectedChat)}</span>{selectedChatCpf ? <span className="truncate">CPF: {selectedChatCpf}</span> : null}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {selectedChat.status === 'waiting' ? (
                    <button
                      type="button"
                      onClick={() => handlePickup(selectedChat)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm transition-colors hover:bg-orange-600"
                    >
                      <Play size={12} fill="currentColor" />
                      {isMobileView ? 'Puxar' : 'Puxar atendimento'}
                    </button>
                  ) : (
                    <>
                      {isMobileView ? (
                        <button
                          type="button"
                          onClick={() => { setMobilePanelTab('quick'); setMobilePanelOpen(true); }}
                          className="agent-icon-action flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                          title="Mensagens rápidas"
                          aria-label="Mensagens rápidas"
                        >
                          <MessageSquareText size={16} />
                        </button>
                      ) : null}
                      {isMobileView ? (
                        <button
                          type="button"
                          onClick={() => { setMobilePanelTab('info'); setMobilePanelOpen(true); }}
                          className="agent-icon-action flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                          title="Info do cliente"
                          aria-label="Info do cliente"
                        >
                          <Info size={16} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={openTransferModal}
                        className="agent-icon-action flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                        title="Transferir atendimento"
                        aria-label="Transferir atendimento"
                      >
                        <ArrowRightLeft size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={handleClose}
                        className="agent-icon-action flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                        title="Encerrar atendimento"
                        aria-label="Encerrar atendimento"
                      >
                        <XCircle size={16} />
                      </button>
                    </>
                  )}
                  {!isMobileView ? (
                    <button
                      type="button"
                      onClick={() => setIsSidePanelCollapsed((prev) => !prev)}
                      className="agent-icon-action flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-100 hover:text-blue-600 dark:text-slate-400 dark:hover:bg-blue-900/40 dark:hover:text-blue-300"
                      title={isSidePanelCollapsed ? 'Mostrar painel' : 'Ocultar painel'}
                      aria-label={isSidePanelCollapsed ? 'Mostrar painel' : 'Ocultar painel'}
                    >
                      <span className={`transition-transform duration-300 ${isSidePanelCollapsed ? 'rotate-0' : 'rotate-180'}`}>
                        {isSidePanelCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            </header>
            {visibleChatVars.length > 0 ? <div className="border-b border-slate-200 bg-white/80 px-2.5 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/70 lg:px-3"><div className="flex gap-1.5 overflow-x-auto scrollbar-hide">{visibleChatVars.map(([key, value]) => <div key={key} className="min-w-[90px] rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800/70"><div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{key.replace('_', ' ')}</div><div className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200" title={String(value)}>{String(value)}</div></div>)}</div></div> : null}
            {selectedChat.outreachPendingReply === true ? <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/30 dark:bg-amber-900/20 dark:text-amber-200 lg:px-3">Atendimento ativo iniciado. Aguarde a primeira resposta do cliente para liberar o envio manual de mensagens.</div> : null}
            <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row"><div className="agent-chat-doodles pointer-events-none absolute inset-0" /><div className="relative flex min-h-0 flex-1 flex-col lg:flex-row"><div className="relative flex min-h-0 flex-1 flex-col"><div ref={messagesScrollRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto px-2.5 py-2.5 custom-scrollbar sm:px-3 lg:px-4"><div className="mx-auto flex max-w-2xl flex-col gap-2">{(Array.isArray(selectedChat.messages) ? selectedChat.messages : []).map((m, i, all) => { const continues = Boolean(m.sender !== 'system' && all[i - 1]?.sender === m.sender); const endsGroup = all[i + 1]?.sender !== m.sender; const showMeta = m.sender !== 'system' && (endsGroup || revealedTimeId === m.id || getMessageDeliveryStatus(m) === 'failed'); const hasStatus = Boolean(getMessageDeliveryStatus(m) && (m.sender === 'agent' || m.sender === 'bot')); const timeClass = m.sender === 'agent' ? 'text-white/75' : 'text-slate-400 dark:text-slate-500'; const bubbleSpacingClass = !showMeta ? '' : hasStatus && !m.media ? 'pb-5 pr-10' : 'pb-5'; return <div key={m.id || `${m.sender}_${i}`} id={`agentmsg-${m.id}`} className={`ui-message-enter -mx-2 px-2 py-0.5 flex transition-colors duration-500 ${continues ? '-mt-1.5' : ''} ${m.sender === 'agent' ? 'justify-end' : 'justify-start'} ${highlightedMessageId === m.id ? 'bg-blue-400/20' : ''}`}><div onClick={m.sender !== 'system' && !endsGroup ? (event) => { if (event.target.closest('button, a, audio, video, img')) return; setRevealedTimeId((prev) => (prev === m.id ? null : m.id)); } : undefined} className={`group relative max-w-[88%] rounded-md px-3 py-2 text-xs shadow-sm sm:max-w-[78%] ${m.sender === 'system' ? 'w-full rounded-md bg-slate-200/80 py-1.5 text-center text-[11px] italic text-slate-500 shadow-none dark:bg-slate-800 dark:text-slate-400' : m.sender === 'agent' ? `${continues ? '' : 'rounded-br-sm'} bg-[#0b93f6] text-white ${bubbleSpacingClass}` : m.sender === 'bot' ? `${continues ? '' : 'rounded-bl-sm'} border border-indigo-100 bg-indigo-50 text-slate-800 dark:border-indigo-900/60 dark:bg-indigo-950/50 dark:text-slate-100 ${bubbleSpacingClass}` : `${continues ? '' : 'rounded-bl-sm'} border border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 ${bubbleSpacingClass}`} ${m.sender !== 'system' ? 'border border-black/5' : ''} ${m.localPending ? 'opacity-75' : ''} transition-opacity`}>{m.sender !== 'system' && !continues ? <div className={`mb-1 flex max-w-[260px] items-center gap-1 truncate text-[10px] font-bold uppercase tracking-wide ${m.sender === 'agent' ? 'text-blue-100/90' : m.sender === 'bot' ? 'text-indigo-600 dark:text-indigo-300' : 'text-blue-600 dark:text-blue-400'}`}>{m.sender === 'bot' ? <Workflow size={11} className="shrink-0" /> : null}<span className="truncate">{m.sender === 'agent' ? 'Você' : m.sender === 'user' ? selectedChatName : m.sender === 'bot' ? (selectedChat.flowName ? `Fluxo - ${selectedChat.flowName}` : 'Fluxo') : m.sender.toUpperCase()}</span></div> : null}{m.replyTo ? <button type="button" onClick={() => scrollToMessage(m.replyTo.messageId)} className={`mb-1.5 block w-full max-w-full rounded-sm border-l-2 px-2 py-1 text-left text-[11px] transition-opacity hover:opacity-80 ${m.sender === 'agent' ? 'border-white/60 bg-white/15 text-white/90' : 'border-blue-400 bg-blue-50 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300'}`}><div className="truncate font-semibold opacity-80">{m.replyTo.sender === 'agent' ? 'Você' : m.replyTo.sender === 'user' ? selectedChatName : (m.replyTo.sender || 'Mensagem')}</div><div className="truncate opacity-90">{m.replyTo.hasMedia && !m.replyTo.preview ? '[mídia]' : (m.replyTo.preview || '[mensagem]')}</div></button> : null}<ChatMessageContent message={m} />{m.sender !== 'system' ? <button type="button" onClick={() => setReplyingTo({ id: m.id, sender: m.sender, preview: (m.text || (m.media ? `[${m.media.type || 'mídia'}]` : '') || '').slice(0, 120) })} title="Responder" className={`absolute -top-2 ${m.sender === 'agent' ? 'left-1' : 'right-1'} opacity-0 group-hover:opacity-100 flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-500 shadow ring-1 ring-black/5 transition-opacity hover:text-blue-600 dark:bg-slate-700 dark:text-slate-300`}><CornerUpLeft size={12} /></button> : null}{showMeta ? <span className={`absolute bottom-2 ${hasStatus ? 'right-8' : 'right-3'} text-[10px] ${timeClass}`}>{formatTime(m.timestamp)}</span> : null}{showMeta ? renderMessageDeliveryStatus(m) : null}</div></div>; })}<div ref={chatEndRef} /></div></div><button type="button" onClick={() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })} title="Ir para a última mensagem" aria-label="Ir para a última mensagem" tabIndex={showJumpToEnd ? 0 : -1} className={`absolute bottom-3 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-md transition-all duration-200 hover:bg-blue-50 hover:text-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-blue-300 ${showJumpToEnd ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}><ChevronDown size={18} /></button></div>{!isMobileView ? <div className={`hidden lg:block overflow-hidden transition-[width,opacity] duration-300 ease-out ${isSidePanelCollapsed ? 'w-0 opacity-0' : 'w-[260px] opacity-100'}`}><aside className="h-full w-[260px] border-l border-slate-200 bg-white/90 p-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90"><div className={`space-y-4 transition-opacity duration-200 ${isSidePanelCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100 delay-75'}`}>{renderInfoPanel()}{renderQuickRepliesPanel()}</div></aside></div> : null}</div></div>
            <form onSubmit={handleSend} className="border-t border-slate-200 bg-white/90 px-2.5 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-3 lg:px-4">{replyingTo ? <div className="mx-auto mb-1.5 flex max-w-2xl items-center gap-2 rounded-xl border-l-4 border-blue-500 bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800"><CornerUpLeft size={14} className="shrink-0 text-blue-500" /><div className="min-w-0 flex-1"><div className="truncate text-[11px] font-semibold text-blue-600 dark:text-blue-400">Respondendo a {replyingTo.sender === 'agent' ? 'você' : replyingTo.sender === 'user' ? selectedChatName : (replyingTo.sender || 'mensagem')}</div><div className="truncate text-xs text-slate-500 dark:text-slate-400">{replyingTo.preview || '[mensagem]'}</div></div><button type="button" onClick={() => setReplyingTo(null)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700"><XIcon size={14} /></button></div> : null}<div className="mx-auto flex max-w-2xl items-end gap-1.5">{voice.state !== 'idle' ? <><button type="button" onClick={voice.cancel} title="Descartar áudio" aria-label="Descartar áudio" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-900/30 dark:hover:text-red-300"><Trash2 size={16} /></button><div className="flex h-9 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-xs dark:border-slate-700 dark:bg-slate-800"><span className={`h-2 w-2 shrink-0 rounded-full bg-red-500 ${voice.state === 'recording' ? 'animate-pulse' : 'opacity-40'}`} /><span className="font-medium text-slate-700 dark:text-slate-200">{voice.state === 'recording' ? 'Gravando' : 'Abrindo o microfone...'}</span><span className="ml-auto tabular-nums text-slate-500 dark:text-slate-400">{formatVoiceTime(voice.seconds)} / {formatVoiceTime(VOICE_NOTE_MAX_SECONDS)}</span></div><button type="button" onClick={voice.send} disabled={voice.state !== 'recording'} title="Enviar áudio" aria-label="Enviar áudio" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Send size={15} /></button></> : <><button type="button" onClick={openMediaPicker} disabled={selectedChatReplyLocked} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"><Paperclip size={15} /></button><div className="flex flex-1 items-end rounded-2xl border border-slate-200 bg-slate-50 px-1 shadow-sm dark:border-slate-700 dark:bg-slate-800"><textarea ref={agentInputRef} rows={1} className="max-h-28 min-h-[36px] w-full resize-none bg-transparent px-3 py-2 text-xs leading-4 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-white dark:placeholder:text-slate-500 custom-scrollbar" value={agentInput} onChange={(e) => setAgentInput(e.target.value)} onKeyDown={handleAgentInputKeyDown} placeholder={selectedChat.outreachPendingReply === true ? 'Aguardando a primeira resposta do cliente...' : selectedChat.status === 'waiting' ? 'Puxe o atendimento para responder...' : 'Digite sua mensagem...'} disabled={selectedChatReplyLocked} /></div>{agentInput.trim() ? <button type="submit" disabled={selectedChatReplyLocked} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Send size={15} /></button> : <button type="button" onClick={startVoiceNote} disabled={selectedChatReplyLocked || voiceSending} title="Gravar áudio" aria-label="Gravar áudio" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{voiceSending ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}</button>}</>}</div><div className="mx-auto mt-1 max-w-3xl pl-14 text-[10px] font-medium text-slate-400 dark:text-slate-500">Enter envia • Shift + Enter quebra linha</div></form>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center text-slate-400 dark:text-slate-500"><Headset size={40} className="mb-3 opacity-20" /><h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Area de atendimento</h3><p className="mt-1.5 max-w-sm text-xs">Selecione um cliente para abrir a conversa.</p></div>
        )}
        {isMobileView && mobilePanelOpen && selectedChat ? <div className="ui-overlay-fade fixed inset-0 z-40 bg-slate-950/50 lg:hidden" onClick={() => setMobilePanelOpen(false)}><div className="ui-sheet-surface absolute inset-x-0 bottom-0 max-h-[78vh] rounded-t-[28px] bg-white p-4 shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}><div className="mx-auto mb-4 h-1.5 w-14 rounded-full bg-slate-200 dark:bg-slate-700" /><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900 dark:text-white">{mobilePanelTab === 'info' ? 'Info do cliente' : 'Mensagens rapidas'}</div><div className="text-xs text-slate-500 dark:text-slate-400">{selectedChatName}</div></div><button type="button" onClick={() => setMobilePanelOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-200"><XCircle size={18} /></button></div><div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800"><button type="button" onClick={() => setMobilePanelTab('info')} className={`rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${mobilePanelTab === 'info' ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>Info</button><button type="button" onClick={() => setMobilePanelTab('quick')} className={`rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${mobilePanelTab === 'quick' ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>Rapidas</button></div><div className="mt-4 max-h-[56vh] overflow-y-auto custom-scrollbar pr-1">{mobilePanelTab === 'info' ? renderInfoPanel() : renderQuickRepliesPanel()}</div></div></div> : null}
        {transferModal.open ? <div className="ui-overlay-fade fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-4 backdrop-blur-sm lg:items-center" onClick={closeTransferModal}><div className="ui-responsive-modal w-full max-w-xl rounded-[28px] bg-white p-5 shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><h3 className="text-lg font-bold text-slate-900 dark:text-white">Transferir atendimento</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Encaminhe {selectedChatName} para uma fila ou diretamente para outro agente.</p></div><button type="button" onClick={closeTransferModal} disabled={transferModal.submitting} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200"><XCircle size={18} /></button></div>{transferModal.loading ? <div className="mt-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"><Loader2 size={18} className="animate-spin text-blue-500" />Carregando destinos...</div> : <div className="mt-5 space-y-4"><div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800"><button type="button" onClick={() => setTransferModal((prev) => ({ ...prev, mode: 'queue' }))} className={`rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${transferModal.mode === 'queue' ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>Fila</button><button type="button" onClick={() => setTransferModal((prev) => ({ ...prev, mode: 'agent' }))} className={`rounded-2xl px-3 py-2 text-sm font-semibold transition-colors ${transferModal.mode === 'agent' ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-700 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>Agente</button></div>{transferModal.mode === 'queue' ? <div><label className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-100">Fila de destino</label><select value={transferModal.queue} onChange={(e) => setTransferModal((prev) => ({ ...prev, queue: e.target.value }))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white">{transferModal.queues.length === 0 ? <option value="">Nenhuma fila disponivel</option> : transferModal.queues.map((queue) => <option key={queue.id || queue.name} value={queue.name}>{queue.name}</option>)}</select></div> : <div><label className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-100">Agente de destino</label><select value={transferModal.agentId} onChange={(e) => setTransferModal((prev) => ({ ...prev, agentId: e.target.value }))} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white">{transferModal.agents.length === 0 ? <option value="">Nenhum agente disponivel</option> : transferModal.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.username}{agent.queues?.length ? ` - ${agent.queues.join(', ')}` : ''}</option>)}</select></div>}<div><label className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-100">Motivo opcional</label><textarea rows={3} value={transferModal.reason} onChange={(e) => setTransferModal((prev) => ({ ...prev, reason: e.target.value }))} placeholder="Ex: encaminhando para especialista..." className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white" /></div><div className="flex flex-col gap-3 sm:flex-row"><button type="button" onClick={closeTransferModal} disabled={transferModal.submitting} className="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button><button type="button" onClick={handleTransferChat} disabled={transferModal.submitting || (transferModal.mode === 'queue' ? !transferModal.queue : !transferModal.agentId)} className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{transferModal.submitting ? <Loader2 size={16} className="animate-spin" /> : <ArrowRightLeft size={16} />}{transferModal.submitting ? 'Transferindo...' : 'Transferir'}</button></div></div>}</div></div> : null}
        {showQuickModal ? <div className="ui-overlay-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowQuickModal(false)}><div className="ui-modal-surface w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}><h3 className="mb-3 text-lg font-bold text-slate-900 dark:text-white">Mensagem rapida</h3><textarea className="min-h-[160px] w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white" value={quickDraft} onChange={(e) => setQuickDraft(e.target.value)} /><div className="mt-4 flex gap-3"><button type="button" onClick={() => setShowQuickModal(false)} className="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button><button type="button" onClick={handleQuickSend} disabled={selectedChatReplyLocked} className="flex-1 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Enviar</button></div></div></div> : null}
        {bulkPickupModal.open ? <div className="ui-overlay-fade fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-4 backdrop-blur-sm lg:items-center" onClick={closeBulkPickupModal}><div className="ui-responsive-modal w-full max-w-2xl rounded-[28px] bg-white p-5 shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><h3 className="text-lg font-bold text-slate-900 dark:text-white">Puxar todos em espera</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Assume {waitingChats.length} atendimento(s) das suas filas. Escreva a primeira mensagem para todos ou deixe vazio para nao enviar nada.</p></div><button type="button" onClick={closeBulkPickupModal} disabled={bulkPickupModal.loading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200"><XCircle size={18} /></button></div>{appTemplates.length > 0 ? <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"><div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Templates da aplicacao</div><div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">{appTemplates.map((tpl) => <button key={`bulk_tpl_${tpl.id}`} type="button" onClick={() => setBulkPickupModal((prev) => ({ ...prev, message: renderTemplateText(tpl.text || '') }))} className="min-w-[180px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-orange-300 hover:bg-orange-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-orange-700 dark:hover:bg-orange-900/20"><div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{tpl.name}</div><div className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{tpl.text}</div></button>)}</div></div> : <div className="mt-4 rounded-2xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-400 dark:border-slate-700">Nenhum template proprio da aplicacao encontrado.</div>}<div className="mt-4"><label className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-100">Mensagem inicial opcional</label><textarea rows={7} value={bulkPickupModal.message} onChange={(e) => setBulkPickupModal((prev) => ({ ...prev, message: e.target.value }))} placeholder="Ex: Oi, tudo bem? Vou assumir seu atendimento por aqui. Deixe vazio para puxar sem enviar mensagem." className="min-h-[180px] w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-orange-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white" /></div><div className="mt-4 flex flex-col gap-3 sm:flex-row"><button type="button" onClick={closeBulkPickupModal} disabled={bulkPickupModal.loading} className="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button><button type="button" onClick={handleBulkPickup} disabled={bulkPickupModal.loading || waitingChats.length === 0} className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50">{bulkPickupModal.loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />}{bulkPickupModal.loading ? 'Puxando...' : 'Puxar todos'}</button></div></div></div> : null}
        {mediaModal.open ? <div className="ui-overlay-fade fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-4 backdrop-blur-sm lg:items-center" onClick={() => !mediaModal.uploading && closeMediaModal()}><div className="ui-responsive-modal w-full max-w-xl overflow-hidden rounded-[28px] bg-white shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}><div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800"><div className="flex items-center justify-between gap-3"><div><div className="text-lg font-semibold text-slate-900 dark:text-white">Enviar anexo</div><div className="text-sm text-slate-500 dark:text-slate-400">Confira o preview antes de enviar.</div></div><button type="button" onClick={closeMediaModal} disabled={mediaModal.uploading} className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-600 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200"><XCircle size={18} /></button></div></div><div className="space-y-4 p-5"><div className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">{mediaModal.previewKind === 'image' ? <img src={mediaModal.previewUrl} alt={mediaModal.file?.name || 'Preview'} className="max-h-[360px] w-full object-contain bg-black/5" /> : mediaModal.previewKind === 'video' ? <video controls className="max-h-[360px] w-full bg-black" src={mediaModal.previewUrl} /> : mediaModal.previewKind === 'audio' ? <div className="space-y-4 p-5"><div className="flex items-center gap-3 text-slate-700 dark:text-slate-200"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300"><AudioLines size={22} /></div><div><div className="font-semibold">Audio</div><div className="text-sm text-slate-500 dark:text-slate-400">{mediaModal.file?.name}</div></div></div><audio controls className="w-full" src={mediaModal.previewUrl} /></div> : <div className="flex items-center gap-4 p-5"><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200">{mediaModal.previewKind === 'image' ? <ImageIcon size={24} /> : mediaModal.previewKind === 'video' ? <Video size={24} /> : <FileText size={24} />}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-900 dark:text-white">{mediaModal.file?.name || 'Arquivo'}</div><div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatFileSize(mediaModal.file?.size || 0)}</div></div></div>}</div><div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-800"><div className="font-semibold text-slate-800 dark:text-slate-100">{mediaModal.file?.name || 'Arquivo'}</div><div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{mediaModal.file?.type || 'application/octet-stream'} • {formatFileSize(mediaModal.file?.size || 0)}</div></div><div><label className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-100">Legenda opcional</label><textarea rows={3} value={mediaModal.caption} onChange={(e) => setMediaModal((prev) => ({ ...prev, caption: e.target.value }))} placeholder="Escreva uma legenda, se quiser..." className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white" /></div><div className="flex gap-3"><button type="button" onClick={closeMediaModal} disabled={mediaModal.uploading} className="flex-1 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Cancelar</button><button type="button" onClick={handleSendMedia} disabled={mediaModal.uploading} className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{mediaModal.uploading ? <Loader2 size={16} className="animate-spin" /> : <Send size={14} />}{mediaModal.uploading ? 'Enviando...' : 'Enviar arquivo'}</button></div></div></div></div> : null}
      </main>
      ) : null}
      <ChatMediaLightbox
        open={mediaViewer.open}
        items={chatMediaItems}
        index={mediaViewer.index}
        onIndexChange={(index) => setMediaViewer((previous) => ({ ...previous, index }))}
        onClose={() => setMediaViewer({ open: false, index: 0 })}
      />
    </div>
    </div>
  );
};

export default AgentWorkspace;
