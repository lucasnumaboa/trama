import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { planChunks, nearestAspect, swapPrompt, matchPerson, swapFields, chunkArgs, assembleArgs } from './swap.js';
import { parsePeople } from './vision.js';
import { describeWorkflow } from './describe.js';
import { run, probe } from './media.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const objectInfo = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures/object_info.json.gz'))));
const ASPECTS = ['1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Photo)', '3:4 (Portrait Standard)', '4:3 (Standard)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)', '21:9 (Ultrawide)'];

test('blocos: iguais, até o máximo, sem resto curto', () => {
  assert.deepEqual(planChunks(8).map((c) => c.dur), [8]);
  const c23 = planChunks(23);
  assert.equal(c23.length, 3);
  assert.ok(c23.every((c) => c.dur <= 10 && c.dur > 7));
  assert.equal(+c23.reduce((s, c) => s + c.dur, 0).toFixed(3), 23);
  assert.equal(c23[1].start, c23[0].dur);
  // 10,5 s não vira 10 + 0,5: vira dois blocos de 5,25.
  assert.deepEqual(planChunks(10.5).map((c) => c.dur), [5.25, 5.25]);
  assert.equal(planChunks(40, 15).length, 3);
  assert.equal(planChunks(40, 99).length, 3, 'o bloco não passa de 15 s');
  assert.throws(() => planChunks(1.2), /pelo menos 2 s/);
});

test('formato mais perto do vídeo', () => {
  assert.equal(nearestAspect(1080, 1920, ASPECTS), '9:16 (Portrait Widescreen)');
  assert.equal(nearestAspect(1920, 1080, ASPECTS), '16:9 (Widescreen)');
  assert.equal(nearestAspect(1024, 576, ASPECTS), '16:9 (Widescreen)');
  assert.equal(nearestAspect(720, 720, ASPECTS), '1:1 (Square)');
  assert.equal(nearestAspect(1080, 1350, ASPECTS), '3:4 (Portrait Standard)');
});

test('prompt da troca cita o vídeo, a foto e quem sai', () => {
  const t = swapPrompt('bald man in the blue apron', { brief: 'tall slim woman, red curly hair, green dress.' });
  assert.match(t, /^Replace only the bald man in the blue apron in the <Video 1> with the character in <Picture 1>\./);
  assert.match(t, /\(tall slim woman, red curly hair, green dress\)/);
  assert.match(swapPrompt('the girl on the left'), /Replace only the girl on the left in/);
});

test('prompt nomeia onde está quem sai e quem fica', () => {
  const people = [
    { label: 'the large sumo wrestler', where: 'center-left' },
    { label: 'the man with glasses and blue robe', where: 'center-right' },
    { label: 'the man with sword over shoulder', where: 'right' },
  ];
  const m = matchPerson(people, 'Large sumo wrestler.');
  assert.equal(m, people[0]);
  assert.equal(matchPerson(people, 'sumo wrestler'), people[0], 'rótulo parcial');
  assert.equal(matchPerson(people, 'the woman in red'), null);
  const t = swapPrompt(m.label, { where: m.where, others: people.slice(1).map((p) => p.label) });
  assert.match(t, /Replace only the large sumo wrestler \(center-left\) in the <Video 1>/);
  assert.match(t, /Do not replace, remove or change anyone else: the man with glasses and blue robe, the man with sword over shoulder stay exactly/);
});

test('lê a lista de pessoas do modelo de visão', () => {
  const raw = `**PERSON 1:** "the bald man in the blue apron" | male, about 50, stocky | behind the counter, left | 1,2,3,5 | serves churros
PERSON 2: the young woman in a red jacket | female, 20s, slim, long black hair | right side | 2, 3, 4, 6 | buys and eats
SCENE: night street stall with string lights, static medium shot.`;
  const { people, scene } = parsePeople(raw);
  assert.equal(people.length, 2);
  assert.deepEqual(people[0], { id: 'P1', label: 'the bald man in the blue apron', looks: 'male, about 50, stocky', where: 'behind the counter, left', frames: [1, 2, 3, 5], action: 'serves churros' });
  assert.deepEqual(people[1].frames, [2, 3, 4, 6]);
  assert.match(scene, /^night street stall/);
});

test('workflow de troca: campos achados pelo papel', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/workflows/trama_trocar_personagem_video.json'), 'utf8'));
  const d = describeWorkflow('trama_trocar_personagem_video.json', wf, objectInfo);
  const f = swapFields(d);
  assert.equal(f.video.kind, 'video');
  assert.equal(f.photo.kind, 'image');
  assert.equal(f.photo.refNumber, 1);
  assert.equal(f.prompt.kind, 'text');
  assert.equal(f.duration.default, 5);
  assert.ok(f.aspect.options.includes('16:9 (Widescreen)'));
  assert.equal(f.seed.kind, 'seed');
  assert.deepEqual(f.refSize.options, ['match', 'max']);
  // A foto entra como referência de imagem e o vídeo como referência de vídeo (no workflow
  // antigo h3_troca_personagem_3090 estavam trocados).
  const h3 = Object.values(d.prompt).find((n) => n.class_type === 'MiniMaxH3ReferenceToVideo');
  assert.equal(d.prompt[h3.inputs['ref_images.ref_image_0'][0]].class_type, 'LoadImage');
  assert.equal(d.prompt[h3.inputs['ref_videos.ref_video_0'][0]].class_type, 'GetVideoComponents');
});

test('ffmpeg: corta em blocos a 24 fps e junta com o som original', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-swap-test-'));
  try {
    const src = path.join(dir, 'src.mp4');
    // 7 s, 30 fps, 640x360, com tom de áudio.
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=7', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const chunks = planChunks(7, 4);
    assert.equal(chunks.length, 2);
    const parts = [];
    for (const c of chunks) {
      const out = path.join(dir, `c${c.index}.mp4`);
      await run('ffmpeg', chunkArgs(src, c, out, { hasAudio: true }));
      const i = await probe(out);
      assert.equal(i.fps, 24);
      assert.ok(Math.abs(i.duration - c.dur) < 0.15, `bloco ${c.index}: ${i.duration} vs ${c.dur}`);
      assert.ok(i.has_audio);
      // Simula a saída do modelo: menor e um pouco mais longa (quadros arredondados para cima).
      const gen = path.join(dir, `g${c.index}.mp4`);
      await run('ffmpeg', ['-y', '-v', 'error', '-i', out, '-vf', 'scale=480:272,tpad=stop_mode=clone:stop_duration=0.4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', gen]);
      parts.push(gen);
    }
    const joined = path.join(dir, 'joined.mp4');
    await run('ffmpeg', assembleArgs(parts, chunks, src, joined, { width: 480, height: 272 }));
    const j = await probe(joined);
    assert.ok(Math.abs(j.duration - 7) < 0.2, `duração final ${j.duration}`);
    assert.equal(j.width, 480);
    assert.ok(j.has_audio, 'som original de volta');

    // Vídeo sem som: o bloco ganha silêncio (o workflow precisa de uma faixa de áudio).
    const mute = path.join(dir, 'mute.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mute]);
    const mc = path.join(dir, 'mc.mp4');
    await run('ffmpeg', chunkArgs(mute, planChunks(3)[0], mc, { hasAudio: false }));
    assert.ok((await probe(mc)).has_audio);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
