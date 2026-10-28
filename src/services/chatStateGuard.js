import adapter from '../../db/DatabaseAdapter.js';

const logRepair = async (payload) => {
  try {
    const { createLog } = await import('./logs.js');
    await createLog('CHAT_STATE_REPAIRED', payload, 'system');
  } catch (error) {
    console.warn('[CHAT_STATE_GUARD] Falha ao registrar reparo:', error?.message || error);
  }
};

const VALID_STATUSES = new Set(['bot', 'waiting', 'open', 'closed']);

const clearDelayState = (chat) => {
  chat.delayNodeId = null;
  chat.delayNextNodeId = null;
  chat.delayUntil = null;
};

const clearCurrentNodeState = (chat) => {
  chat.currentNodeId = null;
  chat.currentNodeEnteredAt = null;
  chat.sequentialContext = null;
  chat.holderContext = null;
  chat.inputAttempts = {};
  clearDelayState(chat);
};

const toUniqueList = (values, limit = 100) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result.slice(-limit);
};

const ensureObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const pushIssue = (issues, code, detail = null) => {
  issues.push(detail ? `${code}:${detail}` : code);
};

export const sanitizeChatState = (chat) => {
  if (!chat || typeof chat !== 'object') {
    return { chat, changed: false, issues: [] };
  }

  const next = { ...chat };
  const issues = [];
  let changed = false;
  const apply = (condition, mutator, code, detail = null) => {
    if (!condition) return;
    mutator();
    changed = true;
    pushIssue(issues, code, detail);
  };

  apply(!VALID_STATUSES.has(next.status), () => {
    next.status = next.agentId ? 'open' : 'bot';
  }, 'invalid_status', String(next.status || 'null'));

  apply(!Array.isArray(next.messages), () => {
    next.messages = [];
  }, 'messages_defaulted');

  apply(!next.vars || typeof next.vars !== 'object' || Array.isArray(next.vars), () => {
    next.vars = {};
  }, 'vars_defaulted');

  apply(next.variables && (typeof next.variables !== 'object' || Array.isArray(next.variables)), () => {
    next.variables = {};
  }, 'variables_defaulted');

  apply(!next.inputAttempts || typeof next.inputAttempts !== 'object' || Array.isArray(next.inputAttempts), () => {
    next.inputAttempts = {};
  }, 'input_attempts_defaulted');

  apply(!next.currentNodeId && Object.keys(next.inputAttempts || {}).length > 0, () => {
    next.inputAttempts = {};
  }, 'orphan_input_attempts_cleared');

  const normalizedProcessedIds = toUniqueList(next.processedMessageIds, 100);
  apply(
    JSON.stringify(normalizedProcessedIds) !== JSON.stringify(Array.isArray(next.processedMessageIds) ? next.processedMessageIds : []),
    () => {
      next.processedMessageIds = normalizedProcessedIds;
    },
    'processed_ids_sanitized'
  );

  const hasDelayState = Boolean(next.delayNodeId || next.delayNextNodeId || next.delayUntil);
  apply(
    hasDelayState && (!next.delayNodeId || !next.delayNextNodeId || !next.delayUntil),
    () => {
      clearDelayState(next);
    },
    'partial_delay_state_cleared'
  );

  apply(next.currentNodeId && !next.currentNodeEnteredAt, () => {
    next.currentNodeEnteredAt = new Date().toISOString();
  }, 'node_entered_at_recovered');

  apply(!next.currentNodeId && next.currentNodeEnteredAt, () => {
    next.currentNodeEnteredAt = null;
  }, 'orphan_node_entered_at_cleared');

  apply(!next.currentNodeId && next.sequentialContext, () => {
    next.sequentialContext = null;
  }, 'orphan_sequential_context_cleared');

  apply(!next.currentNodeId && next.holderContext, () => {
    next.holderContext = null;
  }, 'orphan_holder_context_cleared');

  if (next.status === 'bot') {
    apply(Boolean(next.agentId || next.agentName), () => {
      next.agentId = null;
      next.agentName = null;
    }, 'bot_agent_binding_cleared');

    apply(Boolean(next.waitingSince), () => {
      next.waitingSince = null;
    }, 'bot_waiting_since_cleared');

    apply(next.activeOutreach === true && next.attendanceDeferred !== true, () => {
      next.activeOutreach = false;
    }, 'bot_active_outreach_cleared');

    apply(next.outreachPendingReply === true && next.attendanceDeferred !== true, () => {
      next.outreachPendingReply = false;
    }, 'bot_outreach_pending_cleared');
  }

  if (next.status === 'waiting') {
    apply(Boolean(next.agentId || next.agentName), () => {
      next.agentId = null;
      next.agentName = null;
    }, 'waiting_agent_binding_cleared');

    apply(Boolean(next.currentNodeId || next.currentNodeEnteredAt || next.delayUntil), () => {
      clearCurrentNodeState(next);
      next.flowStarted = false;
    }, 'waiting_runtime_cleared');

    apply(next.resumePending === true, () => {
      next.resumePending = false;
    }, 'waiting_resume_pending_cleared');
  }

  if (next.status === 'open') {
    apply(Boolean(next.waitingSince), () => {
      next.waitingSince = null;
    }, 'open_waiting_since_cleared');

    apply(Boolean(next.currentNodeId || next.currentNodeEnteredAt || next.delayUntil), () => {
      clearCurrentNodeState(next);
      next.flowStarted = false;
    }, 'open_runtime_cleared');

    apply(next.resumePending === true, () => {
      next.resumePending = false;
    }, 'open_resume_pending_cleared');
  }

  if (next.status === 'closed') {
    apply(
      Boolean(
        next.currentNodeId
        || next.currentNodeEnteredAt
        || next.flowStarted
        || next.resumePending
        || next.outreachPendingReply
        || next.delayUntil
      ),
      () => {
        clearCurrentNodeState(next);
        next.flowStarted = false;
        next.resumePending = false;
        next.outreachPendingReply = false;
      },
      'closed_runtime_cleared'
    );
  } else {
    apply(Boolean(next.closedAt), () => {
      next.closedAt = null;
    }, 'stale_closed_at_cleared');
  }

  apply(next.activeOutreach === true && next.attendanceDeferred !== true && !next.queue, () => {
    next.queue = 'ATIVO';
  }, 'active_outreach_queue_set');

  apply(next.outreachPendingReply === true && !(
    next.activeOutreach === true
    && (next.status === 'open' || (next.status === 'bot' && next.attendanceDeferred === true))
  ), () => {
    next.outreachPendingReply = false;
  }, 'invalid_outreach_pending_cleared');

  apply(Boolean(next.secureVars && typeof next.secureVars !== 'object'), () => {
    next.secureVars = {};
  }, 'secure_vars_defaulted');

  const secureNames = toUniqueList(next.secureVarNames, 100);
  apply(
    JSON.stringify(secureNames) !== JSON.stringify(Array.isArray(next.secureVarNames) ? next.secureVarNames : []),
    () => {
      next.secureVarNames = secureNames;
    },
    'secure_var_names_sanitized'
  );

  next.vars = ensureObject(next.vars);
  next.variables = ensureObject(next.variables);
  next.secureVars = ensureObject(next.secureVars);

  if (changed) {
    next.updatedAt = new Date().toISOString();
  }

  return { chat: next, changed, issues };
};

export const sanitizeChatCollection = (chats) => {
  let changed = false;
  const repairs = [];
  const nextChats = (Array.isArray(chats) ? chats : []).map((chat) => {
    const result = sanitizeChatState(chat);
    if (result.changed) {
      changed = true;
      repairs.push({
        chatId: result.chat?.id || null,
        tenantId: result.chat?.tenantId || null,
        issues: result.issues
      });
    }
    return result.chat;
  });

  return { chats: nextChats, changed, repairs };
};

export const repairChatStateById = async (chatId, { log = true } = {}) => {
  if (!chatId) return null;
  const allChats = await adapter.getCollection('activeChats');
  const index = allChats.findIndex((chat) => String(chat.id || '') === String(chatId));
  if (index === -1) return null;

  const result = sanitizeChatState(allChats[index]);
  if (!result.changed) return result.chat;

  allChats[index] = result.chat;
  await adapter.saveCollection('activeChats', allChats);

  if (log) {
    await logRepair({
      chatId: result.chat?.id || null,
      tenantId: result.chat?.tenantId || null,
      issues: result.issues
    });
  }

  return result.chat;
};

export const repairAllChatStates = async ({ log = true } = {}) => {
  const allChats = await adapter.getCollection('activeChats');
  const result = sanitizeChatCollection(allChats);
  if (!result.changed) {
    return { repaired: 0, repairs: [] };
  }

  await adapter.saveCollection('activeChats', result.chats);

  if (log) {
    for (const repair of result.repairs) {
      await logRepair(repair);
    }
  }

  return {
    repaired: result.repairs.length,
    repairs: result.repairs
  };
};
