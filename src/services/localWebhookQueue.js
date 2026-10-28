// Fila em memoria para quando nao ha Redis (producao hoje). Antes o webhook ia
// direto para um setImmediate, sem limite: numa rajada de centenas de mensagens
// todas disputavam o pool do banco, estouravam o tempo de conexao e a mensagem
// se perdia em silencio, porque a Meta ja tinha recebido 200 e nao reenvia.
// Aqui no maximo `concurrency` rodam juntas; as outras esperam a vez sem segurar
// conexao. Falha transitoria de banco tenta de novo (o handler ignora mensagem
// repetida pelo id da Meta, entao repetir nao duplica).

const TRANSIENT = /timeout exceeded when trying to connect|Connection terminated|ECONNRESET|ECONNREFUSED|too many clients|EMAXCONN/i;

export const isTransientDbError = (error) => TRANSIENT.test(String(error?.message || error || ''));

export const createLocalQueue = ({
  concurrency = 5,
  handler,
  maxAttempts = 3,
  retryDelayMs = 500,
  isRetryable = isTransientDbError,
  onFailure = () => {}
}) => {
  const pending = [];
  let active = 0;

  const run = async (job) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await handler(job);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryable(error)) {
          onFailure(error, job, attempt);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  };

  const drain = () => {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active += 1;
      run(job).finally(() => {
        active -= 1;
        drain();
      });
    }
  };

  return {
    push(job) {
      pending.push(job);
      drain();
    },
    stats: () => ({ active, pending: pending.length, concurrency })
  };
};
