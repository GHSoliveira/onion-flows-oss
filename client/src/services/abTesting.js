const ABTestService = {
  tests: [],

  createTest(flowId, variants, targetAudience, startDate, endDate) {
    const test = {
      id: `ab_test_${Date.now()}`,
      flowId,
      variants: variants.map((v, i) => ({
        ...v,
        id: `variant_${i}`,
        traffic: v.traffic || 1 / variants.length,
      })),
      targetAudience: targetAudience || 'all',
      startDate,
      endDate,
      status: 'running',
      stats: {
        total: 0,
        variants: variants.map(() => ({
          participants: 0,
          conversions: 0,
          completionRate: 0,
          avgTimeToComplete: 0,
          satisfaction: 0,
        })),
      },
      createdAt: new Date().toISOString(),
    };

    this.tests.push(test);
    this.saveTests();
    return test;
  },

  getTests(flowId = null) {
    if (flowId) {
      return this.tests.filter(t => t.flowId === flowId);
    }
    return this.tests;
  },

  getTest(testId) {
    return this.tests.find(t => t.id === testId);
  },

  assignVariant(testId, userId) {
    const test = this.getTest(testId);
    if (!test || test.status !== 'running') {
      return null;
    }

    const stored = localStorage.getItem(`ab_test_${testId}_${userId}`);
    if (stored) {
      return test.variants.find(v => v.id === stored);
    }

    const random = Math.random();
    let cumulative = 0;
    let assignedVariant = test.variants[0];

    for (const variant of test.variants) {
      cumulative += variant.traffic;
      if (random <= cumulative) {
        assignedVariant = variant;
        break;
      }
    }

    localStorage.setItem(`ab_test_${testId}_${userId}`, assignedVariant.id);
    return assignedVariant;
  },

  recordInteraction(testId, variantId, interactionType, data = {}) {
    const test = this.getTest(testId);
    if (!test) return;

    test.stats.total++;

    const variantStats = test.stats.variants.find(v => v.id === variantId);
    if (variantStats) {
      variantStats.participants++;

      switch (interactionType) {
        case 'conversion':
          variantStats.conversions++;
          variantStats.completionRate = (variantStats.conversions / variantStats.participants * 100).toFixed(2);
          break;
        case 'completion':
          if (data.time) {
            const currentAvg = parseFloat(variantStats.avgTimeToComplete) || 0;
            variantStats.avgTimeToComplete = ((currentAvg * (variantStats.participants - 1) + data.time) / variantStats.participants).toFixed(2);
          }
          break;
        case 'satisfaction':
          const currentSat = parseFloat(variantStats.satisfaction) || 0;
          const count = data.count || 1;
          variantStats.satisfaction = ((currentSat * (variantStats.conversions - count) + data.rating) / variantStats.conversions).toFixed(2);
          break;
      }

      this.saveTests();
    }

    return test.stats;
  },

  calculateWinner(testId) {
    const test = this.getTest(testId);
    if (!test || test.stats.total === 0) {
      return null;
    }

    const variantScores = test.variants.map(variant => {
      const stats = test.stats.variants.find(v => v.id === variant.id);

      const conversionScore = parseFloat(stats.completionRate) || 0;
      const timeScore = 100 - (parseFloat(stats.avgTimeToComplete) || 0);
      const satisfactionScore = parseFloat(stats.satisfaction) * 10 || 0;

      const totalScore = (conversionScore * 0.5) + (timeScore * 0.3) + (satisfactionScore * 0.2);

      return {
        variantId: variant.id,
        variantName: variant.name,
        score: totalScore,
        metrics: stats,
      };
    });

    variantScores.sort((a, b) => b.score - a.score);

    const winner = variantScores[0];
    const runnerUp = variantScores[1];

    const confidence = runnerUp
      ? ((winner.score - runnerUp.score) / winner.score * 100).toFixed(2)
      : 100;

    return {
      testId,
      winner: winner.variantId,
      winnerScore: winner.score,
      confidence,
      ranking: variantScores,
      recommendation: confidence > 20 ? winner.variantId : 'needs_more_data',
    };
  },

  endTest(testId, winnerVariantId = null) {
    const test = this.getTest(testId);
    if (!test) return null;

    const recommendation = this.calculateWinner(testId);
    test.status = 'completed';
    test.endDate = new Date().toISOString();
    test.winner = winnerVariantId || recommendation?.winner;
    test.recommendation = recommendation;

    this.saveTests();
    return test;
  },

  pauseTest(testId) {
    const test = this.getTest(testId);
    if (test) {
      test.status = 'paused';
      this.saveTests();
      return test;
    }
    return null;
  },

  resumeTest(testId) {
    const test = this.getTest(testId);
    if (test) {
      test.status = 'running';
      this.saveTests();
      return test;
    }
    return null;
  },

  deleteTest(testId) {
    const index = this.tests.findIndex(t => t.id === testId);
    if (index !== -1) {
      return this.tests.splice(index, 1)[0];
    }
    return null;
  },

  saveTests() {
    localStorage.setItem('ab_tests', JSON.stringify(this.tests));
  },

  loadTests() {
    const saved = localStorage.getItem('ab_tests');
    if (saved) {
      this.tests = JSON.parse(saved);
    }
  },
};

ABTestService.loadTests();

export default ABTestService;
