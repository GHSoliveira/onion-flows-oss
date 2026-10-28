import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarRecursos, lerMemoriaDisponivelMb } from '../src/services/hostResources.js';

const limites = { memoriaMinimaMb: 200, cargaMaxima: 1.5 };

test('recursos folgados: ok', () => {
  assert.deepEqual(avaliarRecursos({ memoriaDisponivelMb: 475, carga5min: 0.09 }, limites), { ok: true, problemas: [] });
});

test('memoria abaixo do minimo ou carga acima do maximo: alerta com o motivo', () => {
  assert.deepEqual(avaliarRecursos({ memoriaDisponivelMb: 150, carga5min: 0.2 }, limites).problemas, ['memoria_baixa']);
  assert.deepEqual(avaliarRecursos({ memoriaDisponivelMb: 400, carga5min: 2.1 }, limites).problemas, ['carga_alta']);
  assert.equal(avaliarRecursos({ memoriaDisponivelMb: 199, carga5min: 1.6 }, limites).ok, false);
  // No limite exato ainda e normal.
  assert.equal(avaliarRecursos({ memoriaDisponivelMb: 200, carga5min: 1.5 }, limites).ok, true);
});

test('leitura de memoria devolve um numero em MB', () => {
  const mb = lerMemoriaDisponivelMb();
  assert.ok(Number.isInteger(mb) && mb > 0);
});
