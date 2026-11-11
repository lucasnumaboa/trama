// Troca de personagem em vídeo (MiniMax H3 + LoRA de troca).
// O workflow aceita de 2 a 15 s de vídeo a 24 fps; vídeos maiores vão em blocos.
// Consistência entre blocos: mesma foto, mesmo prompt e mesma seed em todos, e o som
// do vídeo original por cima do resultado (sem emenda no áudio).
// Mais de uma troca: uma por vez, cada passada parte do resultado da anterior.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run, download, publish, probe } from './media.js';
import { describeByName, runWorkflow } from './exec.js';

export const SWAP_WORKFLOW = 'trama_trocar_personagem_video.json';
export const MAX_CHUNK = 15;
export const DEFAULT_CHUNK = 10;
const MIN_CHUNK = 2;

/** Opção do ResolutionSelector mais perto do formato do vídeo. */
export function nearestAspect(width, height, options) {
  const ratio = width / height;
  let best = null;
  for (const o of options) {
    const m = /^(\d+):(\d+)/.exec(o);
    if (!m) continue;
    const diff = Math.abs(Math.log((Number(m[1]) / Number(m[2])) / ratio));
    if (!best || diff < best.diff) best = { option: o, diff };
  }
  return best?.option;
}

/**
 * Blocos iguais de no máximo `max` segundos. Um resto curto demais (menos de 2 s)
 * não sobra: o vídeo é dividido em partes iguais.
 */
export function planChunks(duration, max = DEFAULT_CHUNK) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error('Não consegui medir a duração do vídeo.');
  if (d < MIN_CHUNK) throw new Error(`O vídeo tem ${d.toFixed(1)} s; a troca de personagem precisa de pelo menos ${MIN_CHUNK} s.`);
  const size = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Number(max) || DEFAULT_CHUNK));
  const n = Math.ceil(d / size - 1e-6);
  // Inícios arredondados; cada bloco vai até o início do próximo (a soma fecha a duração).
  const starts = Array.from({ length: n + 1 }, (_, i) => (i === n ? d : Math.round((i * d * 1000) / n) / 1000));
  return starts.slice(0, n).map((start, i) => ({ index: i, start, dur: Math.round((starts[i + 1] - start) * 1000) / 1000 }));
}

/**
 * Prompt da troca: quem sai (target, onde está), quem entra (<Picture 1> + ficha) e quem
 * fica. Nomear as outras pessoas evita o erro visto no primeiro teste: com a foto de um
 * anão de óculos, o modelo apagou o lutador pedido e trocou o homem de óculos ao lado.
 */
export function swapPrompt(target, { brief, keep, where, others = [] } = {}) {
  const clean = (t) => String(t || '').trim().replace(/[.\s]+$/, '');
  const the = (t) => (/^(the|a|an)\s/i.test(t) ? t : `the ${t}`);
  const who = the(clean(target) || 'main person');
  const stay = others.map(clean).filter(Boolean).map(the);
  return [
    `Replace only ${who}${where ? ` (${clean(where)})` : ''} in the <Video 1> with the character in <Picture 1>.`,
    `The new character takes exactly that person's place in the frame, with the same position, scale, pose, movement, expression, lip movement and timing.`,
    `Keep the replacement character's identity, face, hair, body, outfit, and art style from <Picture 1>${brief ? ` (${clean(brief)})` : ''}, identical in every frame.`,
    stay.length
      ? `Do not replace, remove or change anyone else: ${stay.join(', ')} ${stay.length === 1 ? 'stays' : 'stay'} exactly as in the <Video 1>.`
      : 'Do not replace, remove or change anyone else.',
    "Preserve the source video's camera, background, lighting and objects exactly.",
    keep ? clean(keep) + '.' : '',
    'Do not show the reference sheet or its background.',
  ].filter(Boolean).join(' ');
}

/** A pessoa do video_people que o target descreve (pelo rótulo). */
export function matchPerson(people = [], target = '') {
  const norm = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(target);
  if (!t) return null;
  return people.find((p) => norm(p.label) === t) || people.find((p) => norm(p.label).includes(t) || t.includes(norm(p.label))) || null;
}

/** Campos do workflow de troca, achados pelo papel (não pelo número do nó). */
export function swapFields(d) {
  const field = (test) => d.fields.find(test);
  const f = {
    prompt: field((x) => x.kind === 'text' && !x.internal),
    duration: field((x) => x.kind === 'number' && /dura|second|segundo/i.test(`${x.label} ${x.nodeTitle}`)),
    aspect: field((x) => x.input === 'aspect_ratio'),
    seed: field((x) => x.kind === 'seed'),
    refSize: field((x) => x.input === 'ref_image_size'),
    video: d.mediaInputs.find((m) => m.kind === 'video'),
    photo: d.mediaInputs.find((m) => m.kind === 'image' && m.refNumber === 1) || d.mediaInputs.find((m) => m.kind === 'image'),
  };
  const missing = ['prompt', 'duration', 'video', 'photo'].filter((k) => !f[k]);
  if (missing.length) throw new Error(`O workflow ${d.name} não tem: ${missing.join(', ')}. Ele precisa de um vídeo, uma foto, o prompt e a duração.`);
  return f;
}

/** Argumentos do ffmpeg para um bloco: corta, passa para 24 fps e garante uma faixa de áudio. */
export function chunkArgs(src, chunk, out, { hasAudio }) {
  const args = ['-y', '-hide_banner', '-v', 'error', '-ss', String(chunk.start), '-t', String(chunk.dur), '-i', src];
  // O workflow tira o som do bloco para o vídeo final: sem áudio, entra silêncio.
  if (!hasAudio) args.push('-f', 'lavfi', '-t', String(chunk.dur), '-i', 'anullsrc=r=44100:cl=stereo');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  args.push('-vf', 'fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out);
  return args;
}

/**
 * Junta os blocos gerados, cada um cortado na duração do seu pedaço (o modelo
 * arredonda os quadros para cima), e põe o som do vídeo original.
 */
export function assembleArgs(parts, chunks, audioSrc, out, { width, height }) {
  const args = ['-y', '-hide_banner', '-v', 'error'];
  parts.forEach((p, i) => args.push('-t', String(chunks[i].dur), '-i', p));
  if (audioSrc) args.push('-i', audioSrc);
  const W = Math.round(width / 2) * 2;
  const H = Math.round(height / 2) * 2;
  const v = parts.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`).join(';');
  const graph = parts.length > 1 ? `${v};${parts.map((_, i) => `[v${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[v]` : v.replace('[v0]', '[v]');
  args.push('-filter_complex', graph, '-map', '[v]');
  if (audioSrc) args.push('-map', `${parts.length}:a:0`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  return args;
}

/**
 * @param {object} o
 * @param {object} o.source     arquivo do vídeo (ComfyUI)
 * @param {Array<{target: string, photo: object, extraPhotos?: object[], brief?: string}>} o.swaps
 * @param {number} o.seed
 * @param {number} [o.chunkSeconds]
 * @param {'match'|'max'} [o.fidelity]
 * @param {(p: {progress: number, detail: string}) => void} [o.onProgress]
 * @param {(plan: {chunks, aspect, duration, runs}) => void} [o.onPlan]  chamado depois de dividir em blocos
 * @returns {{ file, info, chunks, aspect, seed, prompts, partFiles }}
 */
export async function swapVideo({ source, swaps, seed, chunkSeconds, fidelity, onProgress = () => {}, onPlan = () => {}, signal }) {
  if (!swaps?.length) throw new Error('Diga quem sai e quem entra (swaps).');
  const d = await describeByName(SWAP_WORKFLOW);
  const f = swapFields(d);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-swap-'));
  try {
    const src = await download(source, dir);
    const info = await probe(src);
    if (!info.width || !info.height) throw new Error('Não consegui ler a imagem do vídeo.');
    const chunks = planChunks(info.duration, chunkSeconds);
    const aspect = f.aspect?.options ? nearestAspect(info.width, info.height, f.aspect.options) : undefined;
    const total = swaps.length * chunks.length;
    onPlan({ chunks, aspect, duration: info.duration, runs: total });
    const prompts = swaps.map((s) => swapPrompt(s.target, { brief: s.brief, keep: s.keep, where: s.where, others: s.others }));
    const partFiles = [];
    let current = src;
    let done = 0;

    for (const [si, s] of swaps.entries()) {
      const outs = [];
      for (const c of chunks) {
        const head = `${swaps.length > 1 ? `Troca ${si + 1}/${swaps.length} · ` : ''}${chunks.length > 1 ? `bloco ${c.index + 1}/${chunks.length}` : 'trocando'}`;
        onProgress({ progress: done / total, detail: `${head}: preparando` });
        const local = path.join(dir, `chunk-${si}-${c.index}-${randomUUID().slice(0, 6)}.mp4`);
        await run('ffmpeg', chunkArgs(current, c, local, { hasAudio: (await probe(current)).has_audio }), signal);
        const chunkFile = await publish(local);

        const values = { [f.prompt.id]: prompts[si], [f.duration.id]: Math.max(MIN_CHUNK, Math.round(c.dur * 100) / 100) };
        if (aspect) values[f.aspect.id] = aspect;
        if (f.seed) values[f.seed.id] = seed;
        if (f.refSize && fidelity) values[f.refSize.id] = fidelity;
        const { files } = await runWorkflow({
          name: d.name,
          values,
          media: { [f.video.id]: chunkFile, [f.photo.id]: s.photo },
          extraRefs: s.extraPhotos || [],
          signal,
          onProgress: ({ progress, detail }) => {
            onProgress({ progress: (done + (Number.isFinite(progress) ? progress : 0)) / total, detail: `${head}${detail ? `: ${detail}` : ''}` });
          },
        });
        const video = files.find((x) => x.kind === 'video');
        if (!video) throw new Error(`O bloco ${c.index + 1} terminou sem vídeo.`);
        partFiles.push({ swap: si, chunk: c.index, file: { filename: video.filename, subfolder: video.subfolder, type: video.type } });
        outs.push(await download(video, dir));
        done += 1;
      }
      onProgress({ progress: done / total, detail: 'Juntando os blocos' });
      const joined = path.join(dir, `swap-${si}-${randomUUID().slice(0, 6)}.mp4`);
      // Fica na resolução que o modelo gerou (esticar até a do original só borraria).
      const size = await probe(outs[0]);
      await run('ffmpeg', assembleArgs(outs, chunks, info.has_audio ? src : null, joined, { width: size.width, height: size.height }), signal);
      current = joined;
    }

    const file = await publish(current);
    return { file, info, chunks, aspect, seed, prompts, partFiles };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
