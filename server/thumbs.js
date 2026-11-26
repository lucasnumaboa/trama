// Miniaturas dos cards guardadas na pasta do app (data/thumbs). O canvas mostra a
// miniatura sem esperar o ComfyUI: depois da primeira vez ela sai do disco, mesmo com o
// ComfyUI ocupado gerando, lento ou fechado.
// - Imagem até 300 KB ou GIF: cópia do arquivo (mantém a animação e o fundo transparente).
// - Imagem grande: reduzida para 512 px no lado maior (PNG se tiver transparência possível).
// - Vídeo: um quadro do começo em JPEG (o vídeo só carrega ao passar o mouse).
// Os nomes do ComfyUI têm contador e o upload não sobrescreve, então o mesmo
// tipo/pasta/nome é sempre o mesmo arquivo: a miniatura não precisa ser refeita.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as comfy from './comfy.js';
import { run } from './media.js';
import { DATA_DIR } from './settings.js';

export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const COPY_LIMIT = 300 * 1024;
const SIZE = 512;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const ALPHA = /\.(png|webp|gif)$/i;

const keyOf = ({ filename, subfolder = '', type = 'output' }) =>
  createHash('sha1').update(`${type}/${subfolder}/${filename}`).digest('hex');

export const thumbKind = (filename) => (VIDEO.test(filename) ? 'video' : IMAGE.test(filename) ? 'image' : null);

function cached(key) {
  if (!fs.existsSync(THUMB_DIR)) return null;
  const hit = fs.readdirSync(THUMB_DIR).find((f) => f.startsWith(`${key}.`) && !f.endsWith('.tmp'));
  return hit ? path.join(THUMB_DIR, hit) : null;
}

// Arquivo de origem: direto do disco quando o ComfyUI roda neste computador; senão
// baixa do ComfyUI para um temporário.
async function source(file) {
  try {
    return { path: await comfy.localPathOf(file), temp: false };
  } catch {
    const upstream = await comfy.fetchFile(file);
    const tmp = path.join(os.tmpdir(), `trama-thumb-${randomUUID()}${path.extname(file.filename)}`);
    await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(tmp));
    return { path: tmp, temp: true };
  }
}

async function build(file, key) {
  const kind = thumbKind(file.filename);
  if (!kind) throw Object.assign(new Error('Sem miniatura para este tipo de arquivo.'), { status: 404 });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const src = await source(file);
  try {
    const ext = path.extname(file.filename).toLowerCase();
    let out;
    if (kind === 'image' && (ext === '.gif' || fs.statSync(src.path).size <= COPY_LIMIT)) {
      out = path.join(THUMB_DIR, `${key}${ext}`);
      fs.copyFileSync(src.path, `${out}.tmp`);
    } else {
      const toPng = kind === 'image' && ALPHA.test(ext);
      out = path.join(THUMB_DIR, `${key}${toPng ? '.png' : '.jpg'}`);
      const scale = `scale='min(${SIZE},iw)':'min(${SIZE},ih)':force_original_aspect_ratio=decrease:flags=area`;
      const seek = kind === 'video' ? ['-ss', '0.1'] : [];
      await run('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', src.path, '-frames:v', '1', '-vf', scale, ...(toPng ? [] : ['-q:v', '4']), '-f', toPng ? 'image2' : 'mjpeg', `${out}.tmp`]);
    }
    fs.renameSync(`${out}.tmp`, out);
    return out;
  } finally {
    if (src.temp) fs.rm(src.path, { force: true }, () => {});
  }
}

// Vários cards pedindo a mesma miniatura ao mesmo tempo fazem um trabalho só.
const pending = new Map();

/** Caminho da miniatura no disco (cria na primeira vez). */
export async function thumbPath(file) {
  const key = keyOf(file);
  const hit = cached(key);
  if (hit) return hit;
  if (!pending.has(key)) {
    pending.set(key, build(file, key).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

/** Apaga as miniaturas mais antigas quando a pasta passa do limite (padrão 1 GB). */
export function pruneThumbs(limit = 1024 * 1024 * 1024) {
  if (!fs.existsSync(THUMB_DIR)) return;
  const files = fs.readdirSync(THUMB_DIR).map((f) => {
    const p = path.join(THUMB_DIR, f);
    const s = fs.statSync(p);
    return { p, size: s.size, at: s.atimeMs || s.mtimeMs };
  });
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= limit) break;
    fs.rmSync(f.p, { force: true });
    total -= f.size;
  }
}
