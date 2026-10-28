const tagRules = [
  {
    id: 'urgent',
    keywords: ['urgente', 'emergência', 'rápido', 'preciso', 'já', 'hoje', 'agora'],
    tag: 'urgente',
    priority: 'high',
  },
  {
    id: 'complaint',
    keywords: ['reclamação', 'problema', 'erro', 'falha', 'defeito', 'barrado', 'lento', 'não funciona'],
    tag: 'reclamação',
    priority: 'high',
  },
  {
    id: 'billing',
    keywords: ['fatura', 'conta', 'pagamento', 'cobrança', 'débito', 'boleto', 'plano', 'upgrade', 'downgrade'],
    tag: 'financeiro',
    priority: 'medium',
  },
  {
    id: 'technical',
    keywords: ['velocidade', 'latência', 'ping', 'sinal', 'conexão', 'internet', 'fibra', 'wi-fi', 'roteador', 'modem'],
    tag: 'técnico',
    priority: 'medium',
  },
  {
    id: 'billing',
    keywords: ['fatura', 'conta', 'pagamento', 'cobrança', 'débito', 'boleto'],
    tag: 'financeiro',
    priority: 'medium',
  },
  {
    id: 'support',
    keywords: ['suporte', 'ajuda', 'atendimento', 'falar com', 'atendente', 'humano', 'pessoa'],
    tag: 'suporte',
    priority: 'medium',
  },
  {
    id: 'sales',
    keywords: ['contratar', 'planos', 'serviços', 'novidades', 'promoção', 'oferta', 'desconto'],
    tag: 'vendas',
    priority: 'low',
  },
];

const autoTagMessage = (message) => {
  const lowerMessage = message.toLowerCase();
  const suggestedTags = [];

  for (const rule of tagRules) {
    for (const keyword of rule.keywords) {
      if (lowerMessage.includes(keyword)) {
        suggestedTags.push({
          tag: rule.tag,
          ruleId: rule.id,
          keyword,
          priority: rule.priority,
          reason: `Contém palavra-chave: "${keyword}"`,
        });
        break;
      }
    }
  }

  const uniqueTags = Array.from(new Set(suggestedTags.map(t => t.tag)));

  return {
    suggestedTags,
    uniqueTags,
  };
};

const autoTagChat = (messages) => {
  const allSuggestedTags = [];

  messages.forEach((msg, index) => {
    if (msg.sender === 'user') {
      const result = autoTagMessage(msg.text);
      allSuggestedTags.push({
        messageId: msg.id,
        ...result,
        messageText: msg.text,
      });
    }
  });

  const tagFrequency = {};
  allSuggestedTags.forEach(st => {
    st.uniqueTags.forEach(tag => {
      tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
    });
  });

  const finalTags = Object.entries(tagFrequency)
    .map(([tag, count]) => ({ tag, count, percentage: (count / messages.filter(m => m.sender === 'user').length * 100).toFixed(1) }))
    .sort((a, b) => b.count - a.count);

  return {
    allSuggestions: allSuggestedTags,
    finalTags,
    messageAnalysis: allSuggestedTags,
  };
};

const createTagRule = (rule) => {
  const newRule = {
    id: `custom_${Date.now()}`,
    tag: rule.tag,
    keywords: rule.keywords || [],
    priority: rule.priority || 'medium',
  };

  tagRules.push(newRule);
  return newRule;
};

const updateTagRule = (ruleId, updates) => {
  const index = tagRules.findIndex(r => r.id === ruleId);
  if (index !== -1) {
    tagRules[index] = { ...tagRules[index], ...updates };
    return tagRules[index];
  }
  return null;
};

const deleteTagRule = (ruleId) => {
  const index = tagRules.findIndex(r => r.id === ruleId);
  if (index !== -1) {
    return tagRules.splice(index, 1)[0];
  }
  return null;
};

const getTagRules = () => tagRules;

export { autoTagMessage, autoTagChat, createTagRule, updateTagRule, deleteTagRule, getTagRules };
export default { autoTagMessage, autoTagChat, createTagRule, updateTagRule, deleteTagRule, getTagRules };
