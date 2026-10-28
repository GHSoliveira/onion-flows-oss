const sentimentAnalysis = {
  positive: ['bom', 'ótimo', 'excelente', 'legal', 'gostei', 'ajudou', 'obrigado', 'perfeito', 'maravilhoso', 'ótimo serviço', 'excelente atendimento', 'muito bom'],
  negative: ['ruim', 'péssimo', 'horrível', 'detestei', 'não gostei', 'não ajudou', 'lento', 'burocracia', 'complicado', 'péssimo serviço', 'atendimento ruim', 'lento demais', 'insatisfeito', 'reclamação'],
  neutral: ['ok', 'entendido', 'valeu', 'certo', 'sim', 'não', 'talvez', 'obrigado', 'de nada'],
};

const analyzeSentiment = (text) => {
  const lowerText = text.toLowerCase();
  let score = 0;
  let matchedKeywords = [];

  for (const keyword of sentimentAnalysis.positive) {
    if (lowerText.includes(keyword)) {
      score += 1;
      matchedKeywords.push({ keyword, type: 'positive' });
    }
  }

  for (const keyword of sentimentAnalysis.negative) {
    if (lowerText.includes(keyword)) {
      score -= 1;
      matchedKeywords.push({ keyword, type: 'negative' });
    }
  }

  for (const keyword of sentimentAnalysis.neutral) {
    if (lowerText.includes(keyword)) {
      matchedKeywords.push({ keyword, type: 'neutral' });
    }
  }

  let sentiment;
  if (score > 0) {
    sentiment = 'positive';
  } else if (score < 0) {
    sentiment = 'negative';
  } else {
    sentiment = 'neutral';
  }

  const confidence = Math.min(Math.abs(score) / 2, 1);

  return {
    sentiment,
    score,
    confidence,
    matchedKeywords,
  };
};

const analyzeChatSentiment = (messages) => {
  const analyses = messages.map(msg => analyzeSentiment(msg.text));

  const totalSentiment = analyses.reduce((acc, curr) => acc + curr.score, 0);
  const avgSentiment = totalSentiment / analyses.length;

  const positiveCount = analyses.filter(a => a.sentiment === 'positive').length;
  const negativeCount = analyses.filter(a => a.sentiment === 'negative').length;
  const neutralCount = analyses.filter(a => a.sentiment === 'neutral').length;

  let overallSentiment;
  if (avgSentiment > 0) {
    overallSentiment = 'positive';
  } else if (avgSentiment < 0) {
    overallSentiment = 'negative';
  } else {
    overallSentiment = 'neutral';
  }

  return {
    overall: overallSentiment,
    averageScore: avgSentiment,
    confidence: Math.min(Math.abs(avgSentiment) / 2, 1),
    distribution: {
      positive: (positiveCount / analyses.length * 100).toFixed(1),
      negative: (negativeCount / analyses.length * 100).toFixed(1),
      neutral: (neutralCount / analyses.length * 100).toFixed(1),
    },
    messageAnalyses: analyses,
  };
};

const suggestTagsBasedOnSentiment = (text, sentiment) => {
  const tagSuggestions = [];

  if (sentiment === 'negative') {
    tagSuggestions.push({ tag: 'insatisfação', reason: 'Sentimento negativo detectado' });
    tagSuggestions.push({ tag: 'reclamação', reason: 'Contém palavras de reclamação' });
  } else if (sentiment === 'positive') {
    tagSuggestions.push({ tag: 'elogio', reason: 'Sentimento positivo detectado' });
    tagSuggestions.push({ tag: 'satisfeito', reason: 'Contém palavras positivas' });
  }

  if (text.toLowerCase().includes('urgente') || text.toLowerCase().includes('emergência')) {
    tagSuggestions.push({ tag: 'urgente', reason: 'Palavra urgente detectada' });
  }

  return tagSuggestions;
};

export { analyzeSentiment, analyzeChatSentiment, suggestTagsBasedOnSentiment };
export default { analyzeSentiment, analyzeChatSentiment, suggestTagsBasedOnSentiment };
