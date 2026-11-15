import test from 'node:test';
import assert from 'node:assert/strict';
import { durationField } from './tools.js';

const field = (input, label = input) => ({ kind: 'number', input, label, nodeTitle: 'Nó' });

test('campo de duração: seconds e duration valem', () => {
  assert.equal(durationField({ fields: [field('steps'), field('seconds')] }).input, 'seconds');
  assert.equal(durationField({ fields: [field('duration')] }).input, 'duration');
});

test('campo de duração: início, fim e crossfade de um trecho não são duração', () => {
  // trama_editar_trecho_musica: start_seconds 52.75 virava "o pedido era 52.75s".
  assert.equal(durationField({ fields: [field('start_seconds'), field('end_seconds'), field('fade_seconds')] }), undefined);
  assert.equal(durationField({ fields: [field('start_seconds'), field('seconds')] }).input, 'seconds');
});
