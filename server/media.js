// Edição local com ffmpeg. Os arquivos vêm do ComfyUI e o resultado volta para
// a pasta input dele (assim pode ser usado como entrada de outros workflows).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as comfy from './comfy.js';

export function run(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new Error(`Não consegui rodar ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} falhou: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

// Como run, mas devolve stdout em bytes e o stderr (o ffmpeg escreve análises lá).
function runRaw(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-200000)));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new Error(`Não consegui rodar ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ out: Buffer.concat(chunks), err });
      else reject(new Error(`${cmd} falhou: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Olha um quadro reduzido (64x64): borda uniforme clara/escura em volta do
 * conteúdo e cor dominante do miolo.
 */
async function analyzeVisual(file, isVideo, duration) {
  const at = isVideo && duration ? Math.max(0, duration / 2) : 0;
  const { out } = await runRaw('ffmpeg', ['-v', 'error', ...(isVideo ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=64:64:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (out.length < 64 * 64 * 3) return {};
  const px = (x, y) => {
    const i = (y * 64 + x) * 3;
    return [out[i], out[i + 1], out[i + 2]];
  };
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const ring = [];
  const bins = new Map();
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const p = px(x, y);
      if (x < 2 || x > 61 || y < 2 || y > 61) ring.push(lum(p));
      if (x >= 10 && x < 54 && y >= 10 && y < 54) {
        const key = (p[0] >> 5) * 64 + (p[1] >> 5) * 8 + (p[2] >> 5);
        const bin = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        bin.n += 1;
        bin.r += p[0];
        bin.g += p[1];
        bin.b += p[2];
        bins.set(key, bin);
      }
    }
  }
  const mean = ring.reduce((a, b) => a + b, 0) / ring.length;
  const std = Math.sqrt(ring.reduce((a, b) => a + (b - mean) ** 2, 0) / ring.length);
  const top = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  const dominant = top ? [top.r / top.n, top.g / top.n, top.b / top.n] : [0, 0, 0];
  let border = null;
  if (std < 20 && Math.abs(mean - lum(dominant)) > 60) border = mean > 190 ? 'light' : mean < 40 ? 'dark' : null;
  return { border, dominant_color: hex(...dominant) };
}

/** Trechos de silêncio no começo e no fim (abaixo de -45 dB). */
async function detectSilence(file, duration) {
  const { err } = await runRaw('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.4', '-f', 'null', '-']);
  const spans = [];
  for (const line of err.split('\n')) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (s) spans.push({ start: Number(s[1]), end: null });
    if (e && spans.length) spans[spans.length - 1].end = Number(e[1]);
  }
  for (const sp of spans) if (sp.end === null) sp.end = duration;
  const leading = spans.length && spans[0].start <= 0.05 ? spans[0].end : 0;
  const lastSpan = spans[spans.length - 1];
  const trailing = lastSpan && lastSpan.end >= duration - 0.1 && lastSpan.start > 0.05 ? duration - lastSpan.start : 0;
  const r = (n) => Math.round(n * 100) / 100;
  return { leading: r(leading), trailing: r(trailing), audible_start: r(leading), audible_end: r(duration - trailing) };
}

/** Recorte das bordas uniformes (claras ou escuras) via cropdetect. */
async function detectCrop(file, isVideo, border) {
  // Bordas claras costumam ter sombra suave (cinza claro): tolerância maior para elas.
  // skip=0: imagens têm um quadro só (o padrão ignora os 2 primeiros).
  const filter = border === 'light' ? 'negate,cropdetect=limit=0.35:round=2:reset=0:skip=0' : 'cropdetect=limit=0.1:round=2:reset=0:skip=0';
  const { err } = await runRaw('ffmpeg', ['-hide_banner', '-i', file, ...(isVideo ? ['-t', '2'] : ['-frames:v', '1']), '-vf', filter, '-f', 'null', '-']);
  const all = [...err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;
  let [, w, h, x, y] = all[all.length - 1].map(Number);
  // Cantos arredondados (ícones): se os cantos do recorte continuam claros/escuros
  // como a borda, entra um pouco mais para dentro para eles sumirem.
  const { out } = await runRaw('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=32:32:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  if (out.length >= 1024) {
    const corners = [out[0], out[31], out[31 * 32], out[1023]];
    const like = corners.filter((v) => (border === 'light' ? v > 170 : v < 45)).length;
    if (like >= 3) {
      const inset = Math.round(Math.min(w, h) * 0.065);
      x += inset;
      y += inset;
      w -= inset * 2;
      h -= inset * 2;
    }
  }
  return { w, h, x, y };
}

/** Informações de um arquivo local: tamanho, duração, resolução, fps, áudio. */
export async function probe(file) {
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file]);
  const data = JSON.parse(raw);
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const [num, den] = String(video?.r_frame_rate || '0/1').split('/').map(Number);
  const duration = Number(data.format?.duration);
  return {
    width: video?.width || null,
    height: video?.height || null,
    fps: den ? Math.round((num / den) * 100) / 100 : null,
    duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
    size_mb: Math.round((Number(data.format?.size || fs.statSync(file).size) / 1048576) * 100) / 100,
    has_audio: Boolean(audio),
    video_codec: video?.codec_name || null,
    audio_codec: audio?.codec_name || null,
    format: data.format?.format_name || null,
  };
}

export async function download(file, dir) {
  const res = await comfy.fetchFile(file);
  const ext = path.extname(file.filename) || '.bin';
  const local = path.join(dir, `${randomUUID()}${ext}`);
  fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  return local;
}

export async function publish(localPath) {
  const buffer = fs.readFileSync(localPath);
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const name = await comfy.uploadInput(buffer, `trama_${hash}${path.extname(localPath)}`);
  return { filename: name, subfolder: '', type: 'input', kind: comfy.mediaKind(name), size_mb: Math.round((buffer.length / 1048576) * 100) / 100 };
}

/**
 * Quadros de um vídeo numa imagem só, enviada para a pasta input do ComfyUI.
 * Serve para o modelo de visão "olhar" um vídeo.
 * - padrão: três quadros (início, meio, fim) lado a lado;
 * - count 6 com rows 2: seis quadros em duas fileiras, em ordem (para achar as pessoas).
 */
export async function videoFrames(file, signal, { count = 3, rows = 1, height = 400 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-'));
  try {
    const src = await download(file, dir);
    const { duration } = await probe(src);
    const d = Number(duration) || 1;
    // Distribui os quadros entre 8% e 92% do vídeo (evita o primeiro e o último, que costumam ser transição).
    const times = count === 3 ? [0.12, 0.5, 0.88] : Array.from({ length: count }, (_, i) => 0.08 + (0.84 * i) / Math.max(1, count - 1));
    const at = times.map((f) => (d * f).toFixed(2));
    const target = path.join(dir, `frames-${randomUUID()}.png`);
    const inputs = at.flatMap((t) => ['-ss', t, '-i', src]);
    // Sem números nos quadros: o drawtext do ffmpeg precisa de fontconfig, que falta no Windows.
    const scale = at.map((_, i) => `[${i}:v]scale=-2:${height},setsar=1[f${i}]`).join(';');
    const perRow = Math.ceil(at.length / rows);
    const rowLabels = [];
    const parts = [scale];
    for (let r = 0; r < rows; r++) {
      const ids = at.map((_, i) => i).slice(r * perRow, (r + 1) * perRow);
      if (!ids.length) break;
      const name = rows === 1 ? 'out' : `r${r}`;
      parts.push(ids.length > 1 ? `${ids.map((i) => `[f${i}]`).join('')}hstack=inputs=${ids.length}[${name}]` : `[f${ids[0]}]null[${name}]`);
      rowLabels.push(`[${name}]`);
    }
    if (rows > 1) parts.push(`${rowLabels.join('')}vstack=inputs=${rowLabels.length}[out]`);
    await run('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-frames:v', '1', target], signal);
    return publish(target);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Informações completas de um arquivo local (inclui silêncio, bordas e cor dominante). */
async function inspectLocal(local, kind) {
  const info = await probe(local);
  if (info.has_audio && info.duration) info.silence = await detectSilence(local, info.duration).catch(() => undefined);
  if ((kind === 'image' || kind === 'video') && info.width) Object.assign(info, await analyzeVisual(local, kind === 'video', info.duration).catch(() => ({})));
  return info;
}

/** Lê as informações de um arquivo do ComfyUI. */
export async function mediaInfo(file, kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-'));
  try {
    return await inspectLocal(await download(file, dir), kind || comfy.mediaKind(file.filename));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const OPERATIONS = [
  'concat_videos', 'add_audio', 'extract_audio', 'trim', 'trim_silence', 'resize', 'reformat', 'crop_borders', 'compress',
  'change_fps', 'speed', 'fade', 'volume', 'mute', 'loop', 'convert',
];
// Operações que transformam um único arquivo (o resultado é outra versão dele).
export const SINGLE_INPUT_OPS = new Set(['trim', 'trim_silence', 'resize', 'reformat', 'crop_borders', 'compress', 'change_fps', 'speed', 'fade', 'volume', 'mute', 'loop', 'convert']);

/** Resultado de "nada a fazer": a operação não mudaria o arquivo para melhor. */
export class NoChange extends Error {}

function parseAspect(value) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!m) throw new Error('aspect precisa ser como "9:16", "16:9", "1:1" ou "4:5"');
  return Number(m[1]) / Number(m[2]);
}

// atempo aceita 0.5–2 por etapa; encadeia para fatores maiores.
function atempoChain(factor) {
  const parts = [];
  let f = factor;
  while (f > 2) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.5) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${f.toFixed(4)}`);
  return parts.join(',');
}

export const VIDEO_ENC = ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/**
 * @param {string} op
 * @param {Array<{file, kind}>} assets  na ordem escolhida
 * @param {object} o  opções da operação (ver TOOL_SCHEMAS em tools.js)
 */
export async function editMedia(op, assets, o = {}, signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-'));
  try {
    // O await aqui garante que a pasta temporária só é apagada depois do ffmpeg.
    return await editIn(dir, op, assets, o, signal);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function editIn(dir, op, assets, o, signal) {
  {
    const locals = [];
    for (const a of assets) locals.push(await download(a.file, dir));
    const out = (ext) => path.join(dir, `out-${randomUUID()}.${ext}`);
    const a0 = assets[0];
    const src = locals[0];
    const isVideo = a0?.kind === 'video';
    const isAudio = a0?.kind === 'audio';
    const isImage = a0?.kind === 'image';
    const need = (cond, msg) => {
      if (!cond) throw new Error(msg);
    };
    const ffmpeg = async (args, ext) => {
      const target = out(ext);
      await run('ffmpeg', ['-y', '-hide_banner', ...args, target], signal);
      return publish(target);
    };
    const imageExt = () => (path.extname(a0.file.filename).slice(1).toLowerCase() === 'jpg' ? 'jpg' : 'png');

    if (op === 'concat_videos') {
      need(assets.length >= 2 && assets.every((a) => a.kind === 'video'), 'concat_videos precisa de 2 ou mais vídeos');
      const infos = await Promise.all(locals.map(probe));
      const withAudio = infos.every((i) => i.has_audio);
      const W = even(infos[0].width);
      const H = even(infos[0].height);
      const fps = o.fps || Math.round(infos[0].fps || 24);
      const filters = locals
        .map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`)
        .join(';');
      const streams = locals.map((_, i) => (withAudio ? `[v${i}][${i}:a]` : `[v${i}]`)).join('');
      const graph = `${filters};${streams}concat=n=${locals.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? '[v][a]' : '[v]'}`;
      const args = [...locals.flatMap((l) => ['-i', l]), '-filter_complex', graph, '-map', '[v]'];
      if (withAudio) args.push('-map', '[a]', '-c:a', 'aac');
      return ffmpeg([...args, ...VIDEO_ENC], 'mp4');
    }

    if (op === 'add_audio') {
      const vi = assets.findIndex((a) => a.kind === 'video');
      const ai = assets.findIndex((a, i) => i !== vi && (a.kind === 'audio' || a.kind === 'video'));
      need(vi >= 0 && ai >= 0, 'add_audio precisa de 1 vídeo e 1 áudio');
      const mix = o.mode === 'mix' && (await probe(locals[vi])).has_audio;
      const vol = Number.isFinite(Number(o.volume)) ? Number(o.volume) : 1;
      const args = ['-i', locals[vi], '-i', locals[ai]];
      if (mix) args.push('-filter_complex', `[1:a]volume=${vol}[b];[0:a][b]amix=inputs=2:duration=first:dropout_transition=0[a]`, '-map', '0:v', '-map', '[a]');
      // apad completa com silêncio; -shortest termina junto com o vídeo.
      else args.push('-filter_complex', `[1:a]volume=${vol},apad[a]`, '-map', '0:v', '-map', '[a]', '-shortest');
      return ffmpeg([...args, '-c:v', 'copy', '-c:a', 'aac'], 'mp4');
    }

    if (op === 'extract_audio') {
      need(isVideo, 'extract_audio precisa de 1 vídeo');
      need((await probe(src)).has_audio, 'Esse vídeo não tem áudio');
      return ffmpeg(['-i', src, '-vn', '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
    }

    if (op === 'trim') {
      need(isVideo || isAudio, 'trim precisa de 1 vídeo ou áudio');
      const start = Number(o.start) || 0;
      const end = o.end === undefined || o.end === null || o.end === '' ? null : Number(o.end);
      need(end === null || end > start, 'trim: "end" precisa ser maior que "start"');
      const args = ['-ss', String(start), '-i', src];
      if (end !== null) args.push('-t', String(end - start));
      return isVideo ? ffmpeg([...args, ...VIDEO_ENC, '-c:a', 'aac'], 'mp4') : ffmpeg([...args, '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
    }

    if (op === 'resize') {
      need(isVideo || isImage, 'resize precisa de 1 vídeo ou imagem');
      const info = await probe(src);
      let W;
      let H;
      if (o.width && o.height) [W, H] = [Number(o.width), Number(o.height)];
      else if (o.width) [W, H] = [Number(o.width), (Number(o.width) * info.height) / info.width];
      else if (o.height) [W, H] = [(Number(o.height) * info.width) / info.height, Number(o.height)];
      else if (o.max_side) {
        const k = Number(o.max_side) / Math.max(info.width, info.height);
        [W, H] = [info.width * k, info.height * k];
      } else if (o.scale) [W, H] = [info.width * Number(o.scale), info.height * Number(o.scale)];
      else throw new Error('resize precisa de width, height, max_side ou scale');
      const vf = `scale=${even(W)}:${even(H)}:flags=lanczos`;
      if (isImage) return ffmpeg(['-i', src, '-vf', vf, '-frames:v', '1'], imageExt());
      return ffmpeg(['-i', src, '-vf', vf, ...VIDEO_ENC, '-c:a', 'copy'], 'mp4');
    }

    if (op === 'crop_borders') {
      need(isVideo || isImage, 'crop_borders precisa de 1 vídeo ou imagem');
      const info = await probe(src);
      const vis = await analyzeVisual(src, isVideo, info.duration);
      const border = o.border || vis.border;
      if (!border) throw new NoChange('Não achei borda uniforme clara ou escura em volta do conteúdo.');
      const box = await detectCrop(src, isVideo, border);
      if (!box || (box.w >= info.width - 2 && box.h >= info.height - 2)) throw new NoChange('A borda é fina demais para recortar.');
      const vf = `crop=${even(box.w)}:${even(box.h)}:${box.x}:${box.y}`;
      if (isImage) return ffmpeg(['-i', src, '-vf', vf, '-frames:v', '1'], imageExt());
      return ffmpeg(['-i', src, '-vf', vf, ...VIDEO_ENC, '-c:a', 'copy'], 'mp4');
    }

    if (op === 'trim_silence') {
      need(isVideo || isAudio, 'trim_silence precisa de vídeo ou áudio');
      const info = await probe(src);
      need(info.has_audio && info.duration, 'Esse arquivo não tem áudio');
      const s = await detectSilence(src, info.duration);
      if (s.leading + s.trailing < 0.3) throw new NoChange(`Não há silêncio sobrando no começo nem no fim (som de ${s.audible_start}s a ${s.audible_end}s).`);
      const start = Math.max(0, s.audible_start - 0.05);
      const end = Math.min(info.duration, s.audible_end + 0.3);
      const fadeAt = Math.max(0, end - start - 0.3);
      const af = `afade=t=out:st=${fadeAt}:d=0.3`;
      const args = ['-ss', String(start), '-i', src, '-t', String(end - start), '-af', af];
      return isVideo ? ffmpeg([...args, ...VIDEO_ENC, '-c:a', 'aac'], 'mp4') : ffmpeg([...args, '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
    }

    if (op === 'reformat') {
      need(isVideo || isImage, 'reformat precisa de 1 vídeo ou imagem');
      const A = parseAspect(o.aspect);
      const info = await probe(src);
      const vis = await analyzeVisual(src, isVideo, info.duration);
      // Bordas uniformes (ex.: cantos brancos em volta de um ícone) estragam faixas
      // e fundo desfocado: recorta antes.
      let pre = '';
      let w0 = info.width;
      let h0 = info.height;
      if (vis.border && o.mode !== 'crop' && o.keep_borders !== true) {
        const box = await detectCrop(src, isVideo, vis.border);
        if (box && (box.w < info.width - 2 || box.h < info.height - 2)) {
          pre = `crop=${even(box.w)}:${even(box.h)}:${box.x}:${box.y},`;
          [w0, h0] = [even(box.w), even(box.h)];
        }
      }
      const wider = w0 / h0 > A;
      const mode = o.mode || 'crop';
      const color = !o.color || o.color === 'auto' ? (vis.dominant_color || '#000000').replace('#', '0x') : o.color;
      let args;
      if (mode === 'crop') {
        const W = even(wider ? h0 * A : w0);
        const H = even(wider ? h0 : w0 / A);
        args = ['-vf', `crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2`];
      } else {
        const W = even(wider ? w0 : h0 * A);
        const H = even(wider ? w0 / A : h0);
        if (mode === 'pad') args = ['-vf', `${pre}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${color}`];
        else if (mode === 'blur') {
          args = ['-filter_complex', `[0:v]${pre}split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`, '-map', '[v]'];
          if (isVideo && info.has_audio) args.push('-map', '0:a?');
        } else throw new Error('mode do reformat: crop, pad ou blur');
      }
      if (isImage) return ffmpeg(['-i', src, ...args, '-frames:v', '1'], imageExt());
      return ffmpeg(['-i', src, ...args, ...VIDEO_ENC, '-c:a', 'copy'], 'mp4');
    }

    if (op === 'compress') {
      const before = fs.statSync(src).size / 1048576;
      if (o.target_mb && before <= Number(o.target_mb)) {
        throw new NoChange(`O arquivo já tem ${before.toFixed(2)} MB, abaixo de ${o.target_mb} MB. Nada a comprimir.`);
      }
      let result;
      if (isImage) result = await ffmpeg(['-i', src, '-q:v', String(o.quality || 4), '-frames:v', '1'], 'jpg');
      else if (isAudio) result = await ffmpeg(['-i', src, '-c:a', 'libmp3lame', '-b:a', `${o.audio_kbps || 128}k`], 'mp3');
      else {
        need(isVideo, 'compress precisa de vídeo, imagem ou áudio');
        if (o.target_mb) {
          const info = await probe(src);
          need(info.duration, 'Não consegui ler a duração do vídeo');
          const audioK = info.has_audio ? 96 : 0;
          const videoK = Math.floor((Number(o.target_mb) * 8192 * 0.95) / info.duration - audioK);
          need(videoK > 80, `Não dá para chegar em ${o.target_mb} MB com ${info.duration}s de vídeo; tente reduzir a resolução ou cortar`);
          result = await ffmpeg(['-i', src, '-c:v', 'libx264', '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.3)}k`, '-bufsize', `${videoK * 2}k`, '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(audioK ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an'])], 'mp4');
        } else {
          result = await ffmpeg(['-i', src, '-c:v', 'libx264', '-crf', String(o.crf || 28), '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '96k'], 'mp4');
        }
      }
      if (result.size_mb >= before) throw new NoChange(`A compressão não diminuiu o arquivo (${before.toFixed(2)} MB → ${result.size_mb} MB). Mantive o original.`);
      return result;
    }

    if (op === 'change_fps') {
      need(isVideo && Number(o.fps) > 0, 'change_fps precisa de 1 vídeo e fps');
      return ffmpeg(['-i', src, '-vf', `fps=${Number(o.fps)}`, ...VIDEO_ENC, '-c:a', 'copy'], 'mp4');
    }

    if (op === 'speed') {
      const f = Number(o.factor);
      need((isVideo || isAudio) && f > 0.1 && f <= 8, 'speed precisa de vídeo ou áudio e factor entre 0.1 e 8 (2 = 2x mais rápido)');
      if (isAudio) return ffmpeg(['-i', src, '-filter:a', atempoChain(f), '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
      const info = await probe(src);
      const args = ['-i', src, '-filter_complex', `[0:v]setpts=PTS/${f}[v]${info.has_audio ? `;[0:a]${atempoChain(f)}[a]` : ''}`, '-map', '[v]'];
      if (info.has_audio) args.push('-map', '[a]', '-c:a', 'aac');
      return ffmpeg([...args, ...VIDEO_ENC], 'mp4');
    }

    if (op === 'fade') {
      need(isVideo || isAudio, 'fade precisa de vídeo ou áudio');
      const info = await probe(src);
      const fin = Number(o.fade_in) || 0;
      const fout = Number(o.fade_out) || 0;
      need(fin > 0 || fout > 0, 'fade precisa de fade_in e/ou fade_out (segundos)');
      const vf = [fin && `fade=t=in:st=0:d=${fin}`, fout && `fade=t=out:st=${Math.max(0, info.duration - fout)}:d=${fout}`].filter(Boolean).join(',');
      const af = [fin && `afade=t=in:st=0:d=${fin}`, fout && `afade=t=out:st=${Math.max(0, info.duration - fout)}:d=${fout}`].filter(Boolean).join(',');
      if (isAudio) return ffmpeg(['-i', src, '-af', af, '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
      return ffmpeg(['-i', src, '-vf', vf, ...(info.has_audio ? ['-af', af, '-c:a', 'aac'] : []), ...VIDEO_ENC], 'mp4');
    }

    if (op === 'volume') {
      need(isVideo || isAudio, 'volume precisa de vídeo ou áudio');
      const v = Number(o.volume);
      need(v >= 0 && v <= 10, 'volume: fator entre 0 e 10 (1 = igual, 0.5 = metade, 2 = dobro)');
      if (isAudio) return ffmpeg(['-i', src, '-af', `volume=${v}`, '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
      return ffmpeg(['-i', src, '-af', `volume=${v}`, '-c:v', 'copy', '-c:a', 'aac'], 'mp4');
    }

    if (op === 'mute') {
      need(isVideo, 'mute precisa de 1 vídeo');
      return ffmpeg(['-i', src, '-an', '-c:v', 'copy'], 'mp4');
    }

    if (op === 'loop') {
      need(isVideo || isAudio, 'loop precisa de vídeo ou áudio');
      const d = Number(o.duration);
      need(d > 0 && d <= 3600, 'loop precisa de duration (segundos) até 3600');
      if (isAudio) return ffmpeg(['-stream_loop', '-1', '-i', src, '-t', String(d), '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3');
      return ffmpeg(['-stream_loop', '-1', '-i', src, '-t', String(d), ...VIDEO_ENC, '-c:a', 'aac'], 'mp4');
    }

    if (op === 'convert') {
      const fmt = String(o.format || '').toLowerCase();
      if (fmt === 'gif') {
        need(isVideo, 'gif só a partir de vídeo');
        const w = Number(o.width) || 480;
        return ffmpeg(['-i', src, '-filter_complex', `fps=${o.fps || 12},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`], 'gif');
      }
      if (fmt === 'webm') {
        need(isVideo, 'webm só a partir de vídeo');
        return ffmpeg(['-i', src, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'], 'webm');
      }
      if (fmt === 'mp4') {
        need(isVideo, 'mp4 só a partir de vídeo');
        return ffmpeg(['-i', src, ...VIDEO_ENC, '-c:a', 'aac'], 'mp4');
      }
      if (fmt === 'mp3' || fmt === 'wav') {
        need(isVideo || isAudio, `${fmt} precisa de vídeo ou áudio`);
        return ffmpeg(['-i', src, '-vn', ...(fmt === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ['-c:a', 'pcm_s16le'])], fmt);
      }
      if (['png', 'jpg', 'webp'].includes(fmt)) {
        need(isImage || isVideo, `${fmt} precisa de imagem (ou vídeo: pega o quadro em "start" segundos)`);
        return ffmpeg([...(isVideo ? ['-ss', String(Number(o.start) || 0)] : []), '-i', src, '-frames:v', '1'], fmt);
      }
      throw new Error('convert: format precisa ser mp4, webm, gif, mp3, wav, png, jpg ou webp');
    }

    throw new Error(`Operação desconhecida: ${op}. Use: ${OPERATIONS.join(', ')}`);
  }
}
