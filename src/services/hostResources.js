import fs from 'node:fs';
import os from 'node:os';

// Recursos da maquina para o monitor de uptime: memoria disponivel e carga
// media de 5 minutos. Painel e API moram na mesma VPS pequena; isto avisa
// antes de a falta de memoria ou de CPU virar lentidao no atendimento.

const numero = (valor, padrao) => (Number.isFinite(Number(valor)) && Number(valor) > 0 ? Number(valor) : padrao);

export const LIMITES = Object.freeze({
  memoriaMinimaMb: numero(process.env.HEALTH_MEMORIA_MINIMA_MB, 200),
  cargaMaxima: numero(process.env.HEALTH_CARGA_MAXIMA, 1.5)
});

// MemAvailable conta o cache que o sistema devolve quando precisa; freemem nao.
export const lerMemoriaDisponivelMb = () => {
  try {
    const achado = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (achado) return Math.round(Number(achado[1]) / 1024);
  } catch {
    // fora do Linux (testes no Windows): cai no valor do Node
  }
  return Math.round(os.freemem() / 1048576);
};

export const avaliarRecursos = ({ memoriaDisponivelMb, carga5min }, limites = LIMITES) => {
  const problemas = [];
  if (memoriaDisponivelMb < limites.memoriaMinimaMb) problemas.push('memoria_baixa');
  if (carga5min > limites.cargaMaxima) problemas.push('carga_alta');
  return { ok: problemas.length === 0, problemas };
};

export const recursosAgora = () => avaliarRecursos({
  memoriaDisponivelMb: lerMemoriaDisponivelMb(),
  carga5min: os.loadavg()[1]
});
