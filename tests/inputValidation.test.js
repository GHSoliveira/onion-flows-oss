import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputValue } from '../src/utils/inputValidation.js';

test('validacao ausente preserva exatamente o valor legado', () => {
  const raw = '  Texto sem normalizar  ';
  assert.deepEqual(validateInputValue({ value: raw }), {
    valid: true,
    value: raw,
    type: 'none'
  });
});

test('normaliza telefone, CPF e CNPJ para digitos', () => {
  assert.deepEqual(validateInputValue({ value: '(11) 91234-5678', validationType: 'phone' }).value, '11912345678');
  assert.deepEqual(validateInputValue({ value: '529.982.247-25', validationType: 'cpf' }), {
    valid: true,
    value: '52998224725',
    type: 'cpf'
  });
  assert.deepEqual(validateInputValue({ value: '04.252.011/0001-10', validationType: 'cnpj' }), {
    valid: true,
    value: '04252011000110',
    type: 'cnpj'
  });
});

test('normaliza numero e data para valores estruturados', () => {
  assert.equal(validateInputValue({ value: '12,50', validationType: 'number' }).value, 12.5);
  assert.deepEqual(validateInputValue({ value: '29/02/2024', validationType: 'date' }), {
    valid: true,
    value: '2024-02-29',
    type: 'date'
  });
  assert.equal(validateInputValue({ value: '29/02/2023', validationType: 'date' }).valid, false);
});

test('regex invalida, muito longa ou com entrada excessiva falha de forma segura', () => {
  assert.equal(validateInputValue({ value: 'abc', validationType: 'regex', validationPattern: '[' }).valid, false);
  assert.equal(validateInputValue({ value: 'abc', validationType: 'regex', validationPattern: 'a'.repeat(201) }).valid, false);
  assert.equal(validateInputValue({ value: 'a'.repeat(1001), validationType: 'regex', validationPattern: '^a+$' }).valid, false);
  assert.equal(validateInputValue({ value: 'ABC-123', validationType: 'regex', validationPattern: '^[A-Z]{3}-\\d{3}$' }).valid, true);
});

