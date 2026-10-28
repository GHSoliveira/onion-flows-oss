import adapter from '../../db/DatabaseAdapter.js';

const normalizeVarName = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '_');

const buildRootVarNameSet = (definitions) => new Set(
  (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition?.isRoot === true && definition?.enabled !== false)
    .flatMap((definition) => {
      const name = String(definition?.name || '').trim();
      if (!name) return [];
      return [name, normalizeVarName(name)];
    })
);

const buildBlockedVarNameSet = (chat) => new Set(
  [
    ...Object.keys(chat?.secureVars || {}),
    ...(Array.isArray(chat?.secureVarNames) ? chat.secureVarNames : [])
  ]
    .map((name) => normalizeVarName(name))
    .filter(Boolean)
);

const sanitizeVarBag = (vars, allowedNames, blockedNames) => {
  if (!vars || typeof vars !== 'object') return {};
  return Object.fromEntries(
    Object.entries(vars).filter(([key]) => {
      const normalizedKey = normalizeVarName(key);
      if (!normalizedKey) return false;
      if (blockedNames.has(normalizedKey)) return false;
      return allowedNames.has(key) || allowedNames.has(normalizedKey);
    })
  );
};

const extractFirstMediaUrl = (value) => {
  const source = String(value || '').trim();
  if (!source) return '';
  const match = source.match(/(https?:\/\/[^\s]+|\/uploads\/[^\s]+)/i);
  return match ? match[1] : '';
};

const looksLikeFileName = (value) => (
  /^[^\\/:*?"<>|]+\.[a-z0-9]{2,8}$/i.test(String(value || '').trim())
);

const inferMediaTypeByMime = (value) => {
  const mime = String(value || '').trim().toLowerCase();
  if (!mime) return null;
  if (mime === 'image' || mime.startsWith('image/')) return 'image';
  if (mime === 'video' || mime.startsWith('video/')) return 'video';
  if (mime === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (mime === 'document' || mime === 'file' || mime === 'application' || mime.startsWith('application/')) return 'document';
  return null;
};

const inferMediaTypeByUrl = (value) => {
  const url = String(value || '').trim().toLowerCase();
  if (!url) return null;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/.test(url)) return 'image';
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/.test(url)) return 'video';
  if (/\.(mp3|ogg|wav|m4a|aac|opus|oga|weba)(\?.*)?$/.test(url)) return 'audio';
  return null;
};

const inferMediaTypeByFileName = (value) => {
  const fileName = String(value || '').trim().toLowerCase();
  if (!fileName) return null;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(fileName)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(fileName)) return 'video';
  if (/\.(mp3|ogg|wav|m4a|aac|opus|oga|weba)$/.test(fileName)) return 'audio';
  return null;
};

const inferMediaTypeByToken = (value) => {
  const source = String(value || '').trim().toLowerCase();
  if (!source) return null;
  if (source.startsWith('[image]')) return 'image';
  if (source.startsWith('[video]')) return 'video';
  if (source.startsWith('[audio]') || source.startsWith('[voice]')) return 'audio';
  if (source.startsWith('[document]')) return 'document';
  return null;
};

const normalizeMessageMedia = (message) => {
  if (!message || typeof message !== 'object') return message;

  const text = String(message.text || '').trim();
  const mediaSource = message.media ?? message.attachment ?? null;
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
      if (rawValue) {
        media = { url: rawValue };
      }
    }
  }

  const mediaUrl = (
    media.url
    || media.mediaUrl
    || message.mediaUrl
    || message.fileUrl
    || message.attachmentUrl
    || message.path
    || message.filePath
    || message.storagePath
    || message.meta?.mediaUrl
    || message.meta?.url
    || message.meta?.fileUrl
    || message.meta?.attachmentUrl
    || message.meta?.path
    || message.meta?.filePath
    || message.meta?.storagePath
    || extractFirstMediaUrl(text)
  );

  if (!mediaUrl) {
    return message;
  }

  const mimeType = (
    media.mimeType
    || media.mime_type
    || media.mimetype
    || message.mimeType
    || message.mime_type
    || message.mimetype
    || message.meta?.mimeType
    || message.meta?.mime_type
    || message.meta?.mimetype
    || null
  );

  const fileName = (
    media.fileName
    || media.filename
    || media.file_name
    || message.fileName
    || message.filename
    || message.file_name
    || message.meta?.fileName
    || message.meta?.filename
    || message.meta?.file_name
    || (looksLikeFileName(text) ? text : null)
    || null
  );

  const explicitType = String(
    media.type
    || media.kind
    || media.mediaType
    || media.media_type
    || message.mediaType
    || message.media_type
    || message.messageType
    || message.message_type
    || message.kind
    || message.type
    || ''
  ).trim().toLowerCase();

  const inferredType = (
    inferMediaTypeByToken(text)
    || inferMediaTypeByMime(mimeType)
    || inferMediaTypeByFileName(fileName)
    || inferMediaTypeByUrl(mediaUrl)
  );

  let mediaType = explicitType || inferredType || 'document';
  if (mediaType === 'document' && inferredType && inferredType !== 'document') {
    mediaType = inferredType;
  }

  return {
    ...message,
    media: {
      ...(media && typeof media === 'object' ? media : {}),
      type: mediaType,
      url: String(mediaUrl),
      caption: media.caption || message.caption || message.meta?.caption || '',
      fileName,
      mimeType
    },
    mediaType,
    mediaUrl: String(mediaUrl),
    fileName,
    mimeType
  };
};

const normalizeChatMessages = (messages) => (
  Array.isArray(messages) ? messages.map((message) => normalizeMessageMedia(message)) : []
);

const migratedTenants = new Set();

const extractTenantSecretVarNames = async (tenantId) => {
  const flows = await adapter.getCollection('flows', tenantId);
  const names = new Set();

  (Array.isArray(flows) ? flows : []).forEach((flow) => {
    const versions = [flow?.draft, flow?.published, flow];
    versions.forEach((version) => {
      const nodes = Array.isArray(version?.nodes) ? version.nodes : [];
      nodes.forEach((node) => {
        if (node?.type !== 'secretNode') return;
        const variableName = String(node?.data?.variableName || '').trim();
        if (variableName) {
          names.add(variableName);
          names.add(normalizeVarName(variableName));
        }
      });
    });
  });

  return names;
};

const findVarEntryByNormalizedName = (vars, normalizedName) => {
  if (!vars || typeof vars !== 'object' || !normalizedName) return null;
  const entry = Object.entries(vars).find(([key]) => normalizeVarName(key) === normalizedName);
  return entry || null;
};

export const migrateTenantSecretVars = async (tenantId) => {
  if (!tenantId || migratedTenants.has(tenantId)) return;

  const secretVarNames = await extractTenantSecretVarNames(tenantId);
  migratedTenants.add(tenantId);
  if (!secretVarNames.size) return;

  const chats = await adapter.getCollection('activeChats', tenantId);
  if (!Array.isArray(chats) || !chats.length) return;

  let changed = false;
  const updatedChats = chats.map((chat) => {
    const nextChat = { ...chat };
    const nextSecureVars = { ...(nextChat.secureVars && typeof nextChat.secureVars === 'object' ? nextChat.secureVars : {}) };
    let chatChanged = false;

    secretVarNames.forEach((secretName) => {
      const normalizedSecretName = normalizeVarName(secretName);
      const varsEntry = findVarEntryByNormalizedName(nextChat.vars, normalizedSecretName);
      if (varsEntry) {
        const [originalKey, value] = varsEntry;
        nextSecureVars[originalKey] = value;
        delete nextChat.vars[originalKey];
        chatChanged = true;
      }

      const variablesEntry = findVarEntryByNormalizedName(nextChat.variables, normalizedSecretName);
      if (variablesEntry) {
        const [originalKey] = variablesEntry;
        delete nextChat.variables[originalKey];
        chatChanged = true;
      }
    });

    if (chatChanged) {
      nextChat.secureVars = nextSecureVars;
      nextChat.secureVarNames = Object.keys(nextSecureVars);
      nextChat.updatedAt = new Date().toISOString();
      changed = true;
    }

    return nextChat;
  });

  if (changed) {
    await adapter.saveCollection('activeChats', updatedChats);
  }
};

export const sanitizeChatForAgent = (chat, variableDefinitions = []) => {
  if (!chat || typeof chat !== 'object') return chat;

  const allowedRootVarNames = buildRootVarNameSet(variableDefinitions);
  const blockedVarNames = buildBlockedVarNameSet(chat);

  const sanitized = {
    ...chat,
    messages: normalizeChatMessages(chat.messages),
    vars: sanitizeVarBag(chat.vars, allowedRootVarNames, blockedVarNames),
    variables: sanitizeVarBag(chat.variables, allowedRootVarNames, blockedVarNames)
  };

  delete sanitized.secureVars;
  delete sanitized.secureVarNames;

  return sanitized;
};

export const sanitizeChatCollectionForAgent = (chats, variableDefinitions = []) => (
  Array.isArray(chats)
    ? chats.map((chat) => sanitizeChatForAgent(chat, variableDefinitions))
    : []
);
