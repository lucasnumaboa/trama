// Checks the converter against the official ComfyUI frontend conversion
// (app.graphToPrompt, frontend 1.48.7). expected.json stores, for each sample
// workflow, the sha256 of a content signature of the official output: every
// node's class_type + non-link inputs (sorted) and the number of links. The
// signature ignores node ids, which the frontend may renumber inside subgraphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { convertWorkflow, mapWidgetValues } from './convert.js';
import { describeWorkflow } from './describe.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const objectInfo = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'object_info.json.gz'))));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'workflows', name), 'utf8'));

function signature(prompt) {
  const nodes = Object.values(prompt)
    .map((x) => x.class_type + JSON.stringify(Object.fromEntries(Object.entries(x.inputs).filter(([, v]) => !Array.isArray(v)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))))
    .sort();
  const links = Object.values(prompt).reduce((s, x) => s + Object.values(x.inputs).filter(Array.isArray).length, 0);
  return createHash('sha256').update(JSON.stringify({ nodes, links })).digest('hex');
}

for (const [name, hash] of Object.entries(expected)) {
  test(`converts like ComfyUI: ${name}`, () => {
    assert.equal(signature(convertWorkflow(load(name), objectInfo).prompt), hash);
  });
}

test('dynamic combo brings the sub-fields of the chosen option', () => {
  const values = mapWidgetValues(objectInfo.TextGenerate, ['hi', 256, 'on', 0.7, 64, 0.95, 0.05, 1.05, 0, 0, false, true], 'TextGenerate');
  assert.equal(values.sampling_mode, 'on');
  assert.equal(values['sampling_mode.temperature'], 0.7);
  assert.equal(values.thinking, false);
  assert.equal(values.use_default_template, true);
});

test('seed with control_after_generate skips the "randomize" value', () => {
  assert.deepEqual(mapWidgetValues(objectInfo.RandomNoise, [42, 'randomize']), { noise_seed: 42 });
});

test('missing advanced widgets fall back to the node defaults', () => {
  const v = mapWidgetValues(objectInfo.LTXVEmptyLatentAudio, [97, 25, 1]);
  assert.deepEqual([v.frames_number, v.frame_rate, v.batch_size], [97, 25, 1]);
});

test('describer exposes media, prompt and output of the voice workflow', () => {
  const d = describeWorkflow('voice', load('trama_trocar_voz.json'), objectInfo);
  assert.deepEqual(d.mediaInputs.map((m) => m.kind), ['audio', 'audio']);
  assert.deepEqual(d.outputs.map((o) => o.kind), ['audio']);
});

test('shared PrimitiveNode becomes a single field with every target', () => {
  const d = describeWorkflow('music', load('trama_musica_com_voz_ace_step.json'), objectInfo);
  const duration = d.fields.find((f) => f.targets?.length === 2);
  assert.ok(duration, 'duration field linked to latent and encoder');
});

test('unknown node gives a clear error', () => {
  const wf = { nodes: [{ id: 1, type: 'NodeThatDoesNotExist', mode: 0, inputs: [], widgets_values: [] }], links: [] };
  assert.throws(() => convertWorkflow(wf, objectInfo), /não existe neste ComfyUI/);
});
