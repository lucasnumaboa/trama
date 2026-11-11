import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, verdictPrompt } from './review.js';

test('lê o veredito do revisor (graves e menores)', () => {
  assert.deepEqual(parseVerdict('{"problems": [], "minor": []}'), { ok: true, problems: [], minor: [] });
  assert.deepEqual(parseVerdict('```json\n{"problems": ["O Ronin aparece duas vezes", " "], "minor": ["banner incompleto"]}\n```'), {
    ok: false,
    problems: ['O Ronin aparece duas vezes'],
    minor: ['banner incompleto'],
  });
  // Só problemas menores: a cena passa, com aviso.
  assert.deepEqual(parseVerdict('{"problems": [], "minor": ["de frente em vez de costas"]}'), { ok: true, problems: [], minor: ['de frente em vez de costas'] });
  // "ok": false explícito reprova mesmo sem lista; "ok": true com graves também reprova.
  assert.equal(parseVerdict('{"ok": false}').ok, false);
  assert.deepEqual(parseVerdict('Resposta: {"ok": true, "problems": ["saiu vertical"]}'), { ok: false, problems: ['saiu vertical'], minor: [] });
  assert.equal(parseVerdict('sem json'), null);
  assert.equal(parseVerdict('{quebrado'), null);
});

test('mensagem do revisor tem o pedido, o elenco e o formato real', () => {
  const m = verdictPrompt({ request: 'horizontal 16:9, <image1> e <image2>', characters: ['Shogun', 'Ronin'], width: 1088, height: 1440, kind: 'image', seen: 'PERSON 1: ...' });
  assert.match(m, /PEDIDO ENVIADO AO GERADOR \(imagem\):\nhorizontal 16:9/);
  assert.match(m, /PERSONAGENS DO ELENCO NESTA CENA: Shogun, Ronin/);
  assert.match(m, /TAMANHO REAL DO RESULTADO: 1088x1440 \(vertical\)/);
  assert.match(verdictPrompt({ width: 1728, height: 960, kind: 'video', seen: 'x' }), /1728x960 \(horizontal\)[\s\S]*três quadros/);
  assert.match(verdictPrompt({ width: 1024, height: 1024, seen: 'x' }), /\(quadrado\)/);
});
