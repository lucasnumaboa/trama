// Elenco: personagens vão para as referências do workflow e a ficha entra no prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describeWorkflow, referenceInfo } from './describe.js';
import { placeCharacters, upsertCharacter, findCharacter, mentionedCharacters, removeCharacter } from './cast.js';
import { parseBrief, splitReading } from './vision.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const objectInfo = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'object_info.json.gz'))));
const describe = (name) => describeWorkflow(name, JSON.parse(fs.readFileSync(path.join(dir, 'workflows', name), 'utf8')), objectInfo);

const char = (name, i) => ({ name, brief: `${name} brief`, asset: { id: `asset_0000000${i}`, kind: 'image', file: { filename: `${name}.png` } } });

test('H3 reference workflow exposes its 2 slots and 7 extra references', () => {
  const d = describe('trama_video_h3_referencia.json');
  assert.equal(d.references.tagStyle, 'picture');
  assert.equal(d.references.maxImages, 9);
  assert.deepEqual(d.mediaInputs.map((m) => m.refNumber), [1, 2]);
  assert.equal(d.references.grow.keyPrefix, 'ref_images.ref_image_');
  assert.equal(d.references.grow.nextIndex, 2);
  assert.equal(d.references.grow.extra, 7);
});

test('workflows citing <image1> in the notes use that tag; no autogrow means no extra refs', () => {
  const media = [{ id: 'media:1', nodeId: '1', kind: 'image' }, { id: 'media:2', nodeId: '2', kind: 'image' }];
  const r = referenceInfo({ 1: { class_type: 'LoadImage', inputs: {} }, 2: { class_type: 'LoadImage', inputs: {} } }, {}, media, ['cite as `<image1>` and `<image2>`']);
  assert.equal(r.tagStyle, 'image');
  assert.equal(r.grow, null);
  assert.equal(r.maxImages, 2);
  assert.deepEqual(media.map((m) => m.refNumber), [1, 2]);
});

test('five characters plus a setting image: free slot first, then extra references', () => {
  const d = describe('trama_video_h3_referencia.json');
  const cast = ['Kenji', 'Taro', 'Ren', 'Goro', 'Mame'].map(char);
  const out = placeCharacters(d, { 'media:137': 'asset_arena000' }, cast, '<Picture 1> is the arena. @Kenji kicks @Taro while @Mame watches.');
  assert.deepEqual(Object.keys(out.slots), ['media:139']);
  assert.equal(out.slots['media:139'].id, cast[0].asset.id);
  assert.equal(out.extra.length, 4);
  assert.deepEqual(out.refs.map((r) => r.n), [2, 3, 4, 5, 6]);
  assert.match(out.prompt, /<Picture 2> kicks <Picture 3> while <Picture 6> watches/);
  assert.match(out.prompt, /^Characters/);
  assert.match(out.prompt, /<Picture 5> is Goro: Goro brief/);
  assert.match(out.prompt, /<Picture 1> is the arena/);
});

test('a character already passed as an input keeps that slot number', () => {
  const d = describe('trama_video_h3_referencia.json');
  const kenji = char('Kenji', 1);
  const out = placeCharacters(d, { 'media:137': kenji.asset.id, 'media:139': 'asset_arena000' }, [kenji], '@Kenji bows');
  assert.deepEqual(out.slots, {});
  assert.equal(out.extra.length, 0);
  assert.match(out.prompt, /<Picture 1> bows/);
});

test('too many characters for the workflow is an error with the limit', () => {
  const d = describe('trama_video_h3_referencia.json');
  const cast = Array.from({ length: 10 }, (_, i) => char(`C${i}`, i));
  assert.throws(() => placeCharacters(d, {}, cast, 'x'), /no máximo 9/);
  const q = { name: 'q', mediaInputs: [{ id: 'media:1', kind: 'image', refNumber: 1 }, { id: 'media:2', kind: 'image', refNumber: 2 }], references: { tagStyle: 'image', maxImages: 2, grow: null } };
  assert.throws(() => placeCharacters(q, {}, cast.slice(0, 3), 'x'), /no máximo 2/);
  assert.match(placeCharacters(q, {}, cast.slice(0, 2), '@C1 hugs @C0').prompt, /<image2> hugs <image1>/);
});

test('text-only workflow refuses cast characters', () => {
  const d = describe('trama_video_h3_texto.json');
  assert.throws(() => placeCharacters(d, {}, [char('Kenji', 1)], '@Kenji runs'), /não recebe imagens de referência/);
});

test('user notes come first in the brief; names match with accents and @', () => {
  const p = { assets: [] };
  upsertCharacter(p, { name: 'Mamé', assetId: 'asset_1', sheet: 's', brief: 'stocky man, glasses', notes: 'very short, pointed ears.' });
  assert.equal(findCharacter(p, '@mame').brief, 'very short, pointed ears; stocky man, glasses');
  upsertCharacter(p, { name: 'mamé', assetId: 'asset_2', sheet: 's2', brief: 'b2' });
  assert.equal(p.cast.length, 1);
  assert.equal(p.cast[0].assetId, 'asset_2');
  assert.deepEqual(mentionedCharacters(p, 'then Mame waves').map((c) => c.name), ['mamé']);
  assert.deepEqual(mentionedCharacters(p, 'a mamey fruit'), []);
  assert.ok(removeCharacter(p, 'Mamé'));
  assert.equal(p.cast.length, 0);
});

test('parseBrief reads the BRIEF line', () => {
  assert.equal(parseBrief('HAIR: black\nBRIEF: very short man, round glasses, goatee\n'), 'very short man, round glasses, goatee');
  assert.equal(parseBrief('**BRIEF:** tall woman'), 'tall woman');
});

test('one reading gives the scene and the main character sheet', () => {
  const text = `A man sits on a tatami mat holding a pipe.\nSetting: rustic room.\n\nCHARACTER SHEET\nHEIGHT & PROPORTIONS: average\nGLASSES: thick black\nMUST KEEP: glasses, pipe, torn kimono\nBRIEF: heavyset man, thick glasses, torn blue kimono.`;
  const r = splitReading(text);
  assert.match(r.vision, /tatami/);
  assert.doesNotMatch(r.vision, /CHARACTER SHEET/);
  assert.equal(r.character.brief, 'heavyset man, thick glasses, torn blue kimono. Must keep: glasses, pipe, torn kimono');
  assert.match(r.character.sheet, /^HEIGHT/);
  assert.equal(splitReading('A crowd at a market.\n\n**CHARACTER SHEET:** none').character, null);
  assert.equal(splitReading('Just a landscape.').character, null);
});

test('a cast name that is also a common word only counts as a proper noun or @mention', () => {
  const p = { assets: [] };
  upsertCharacter(p, { name: 'Sumo', assetId: 'asset_1', sheet: 's', brief: 'huge wrestler' });
  assert.deepEqual(mentionedCharacters(p, 'two men fight in a sumo ring, rain falls'), []);
  assert.deepEqual(mentionedCharacters(p, 'Sumo grabs the vendor').map((c) => c.name), ['Sumo']);
  assert.deepEqual(mentionedCharacters(p, 'then @sumo lifts him').map((c) => c.name), ['Sumo']);
});

test('abbreviated slot names resolve to the workflow slot', async () => {
  const { resolveSlots } = await import('./tools.js');
  const d = describe('trama_video_h3_referencia.json');
  const [s1, s2] = d.mediaInputs.map((m) => m.id);
  const p = { assets: [{ id: 'asset_a', kind: 'image' }, { id: 'asset_b', kind: 'image' }, { id: 'asset_v', kind: 'video' }] };
  assert.deepEqual(resolveSlots(p, d, { media: 'asset_a' }), { [s1]: 'asset_a' });
  assert.deepEqual(resolveSlots(p, d, { [s1]: 'asset_a', media: 'asset_b' }), { [s1]: 'asset_a', [s2]: 'asset_b' });
  assert.deepEqual(resolveSlots(p, d, { [s2.replace('media:', '')]: 'asset_b' }), { [s2]: 'asset_b' });
  // vídeo num workflow só de imagens: fica como veio e o erro normal explica
  assert.deepEqual(resolveSlots(p, d, { media: 'asset_v' }), { media: 'asset_v' });
});

test('slot and field names copied from another workflow land on this one when there is no doubt', async () => {
  const { resolveSlots, resolveValues } = await import('./tools.js');
  // Formato do trama_editar_imagem_qwen_2_1 (o object_info da fixture não tem os nós do Qwen 2.1).
  const d = {
    mediaInputs: [{ id: 'media:470', nodeId: '470', kind: 'image', title: 'Load Image' }],
    fields: [
      { id: '459:456.width', input: 'width', kind: 'number', nodeTitle: 'Latent' },
      { id: '459:456.height', input: 'height', kind: 'number', nodeTitle: 'Latent' },
      { id: '459:474.negative_prompt', input: 'negative_prompt', kind: 'text', nodeTitle: 'Encode' },
      { id: '459:500.prompt', input: 'prompt', kind: 'text', nodeTitle: 'Generate Text' },
    ],
  };
  const slot = 'media:470';
  const pid = '459:500.prompt';
  const p = { assets: [{ id: 'asset_a', kind: 'image' }, { id: 'asset_v', kind: 'video' }] };
  // "media:7" é o slot do workflow H3; aqui só existe uma entrada de imagem
  assert.deepEqual(resolveSlots(p, d, { 'media:7': 'asset_a' }), { [slot]: 'asset_a' });
  // tipo errado continua como veio (o erro normal explica)
  assert.deepEqual(resolveSlots(p, d, { 'media:7': 'asset_v' }), { 'media:7': 'asset_v' });
  assert.deepEqual(resolveValues(d, { prompt: 'x' }), { [pid]: 'x' });
  assert.deepEqual(resolveValues(d, { '8.prompt': 'x', '8.height': 576 }), { [pid]: 'x', '459:456.height': 576 });
  // o id certo ganha de um apelido repetido; campo desconhecido fica como veio
  assert.deepEqual(resolveValues(d, { [pid]: 'certo', prompt: 'apelido', '19.value': 5 }), { [pid]: 'certo', prompt: 'apelido', '19.value': 5 });
});
