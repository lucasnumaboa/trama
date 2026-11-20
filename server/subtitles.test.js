import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtitleBlocks, buildAss, wrapTwoLines } from './subtitles.js';

test('quebra em duas linhas equilibradas', () => {
  assert.deepEqual(wrapTwoLines('curto', 42), ['curto']);
  const [a, b] = wrapTwoLines('uma frase bem comprida que precisa ser dividida em duas linhas parecidas', 42);
  assert.ok(Math.abs(a.length - b.length) < 15, `${a} | ${b}`);
});

test('blocos seguem o tempo das palavras e não se sobrepõem', () => {
  const seg = {
    start: 0, end: 6, text: '',
    words: 'Olá pessoal, hoje eu vou mostrar como fazer um bolo de chocolate bem fofinho e rápido para o café da tarde de domingo.'
      .split(' ').map((w, i) => [i * 0.3, i * 0.3 + 0.25, w]),
  };
  const blocks = subtitleBlocks([seg, { start: 9, end: 9.2, text: 'Tchau!' }], { maxChars: 30 });
  assert.ok(blocks.length >= 3);
  for (const b of blocks) assert.ok(b.lines.length <= 2 && b.lines.every((l) => l.length <= 45), JSON.stringify(b));
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i - 1].end <= blocks[i].start, 'sobreposição');
  const last = blocks[blocks.length - 1];
  assert.equal(last.lines[0], 'Tchau!');
  assert.ok(last.end - last.start >= 0.69, 'tempo mínimo na tela');
});

test('frase sem palavras divide o tempo pelo texto', () => {
  const blocks = subtitleBlocks([{ start: 2, end: 4, text: 'Bom dia a todos' }]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, 2);
  assert.ok(Math.abs(blocks[0].end - 4) < 1e-6);
});

test('ASS no tamanho do vídeo, com chaves escapadas', () => {
  const ass = buildAss([{ start: 1.5, end: 3.25, lines: ['linha {um}', 'linha dois'] }], { width: 1080, height: 1920, position: 'top', color: '#ffff00' });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:03\.25,Default,,0,0,0,,linha \\\{um\\\}\\Nlinha dois/);
  assert.match(ass, /,8,\d+,\d+,\d+,1$/m); // alinhamento no topo
  assert.match(ass, /&H0000FFFF/); // amarelo em BGR
});
