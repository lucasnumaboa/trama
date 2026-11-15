import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStyle, isFlatDrawing, STYLE_VERSION, TOON_PROMPT } from './drawing.js';

test('lê o relatório do TramaImageStyle no histórico do ComfyUI', () => {
  const history = { outputs: { 2: { text: ['{"flat": true, "midtones": 0.039, "mean_saturation": 0.024}'] } } };
  assert.deepEqual(parseStyle(history), { flat: true, midtones: 0.039, mean_saturation: 0.024 });
  assert.throws(() => parseStyle({ outputs: {} }), /não devolveu/);
});

test('usa a medida guardada no card enquanto o arquivo for o mesmo', async () => {
  const asset = { file: { filename: 'a.png' }, drawingStyle: { version: STYLE_VERSION, file: 'a.png', flat: true } };
  assert.equal(await isFlatDrawing(asset), true);
});

test('o pedido de conversão mantém as cores e o branco', () => {
  assert.match(TOON_PROMPT, /same colors/);
  assert.match(TOON_PROMPT, /white or light area stays white/);
});

test('nome de workflow sem .json ganha a extensão', async () => {
  const { workflowFile } = await import('./comfy.js');
  assert.equal(workflowFile('trama_3d_animar'), 'trama_3d_animar.json');
  assert.equal(workflowFile('trama_3d_rig.json'), 'trama_3d_rig.json');
  assert.equal(workflowFile('xjson'), 'xjson.json');
});
