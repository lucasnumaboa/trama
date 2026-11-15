// Links de vídeo (YouTube e outros sites que o yt-dlp aceita): ler as informações
// (título, canal, duração, descrição, capítulos, música) e baixar o vídeo, só o áudio
// ou só um trecho, para virar card no canvas.
//
// O yt-dlp é baixado do GitHub oficial na primeira vez e fica na pasta de dados do
// Trama (bin/). O ffmpeg vem do PATH (o mesmo que o Trama usa nas edições); sem ele,
// baixa num formato de arquivo único (até 720p) e não corta trechos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './settings.js';

const BIN_DIR = path.join(DATA_DIR, 'bin');
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';

/** Roda um programa e devolve { code, out, err }. */
function exec(cmd, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let buf = '';
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      out += d;
      if (onLine) {
        buf += d;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelado'));
      resolve({ code, out, err });
    });
  });
}

const works = async (cmd, args) => {
  try {
    return (await exec(cmd, args)).code === 0;
  } catch {
    return false;
  }
};

let ytdlp;
/** Caminho do yt-dlp: TRAMA_YTDLP, o do PATH, o da pasta bin/ ou baixa o oficial. */
export async function ytDlpPath() {
  if (ytdlp) return ytdlp;
  if (process.env.TRAMA_YTDLP) return (ytdlp = process.env.TRAMA_YTDLP);
  if (await works('yt-dlp', ['--version'])) return (ytdlp = 'yt-dlp');
  const local = path.join(BIN_DIR, ASSET);
  if (!fs.existsSync(local)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const res = await fetch(RELEASE + ASSET, { redirect: 'follow' });
    if (!res.ok) throw new Error(`não consegui baixar o yt-dlp (${res.status})`);
    const part = `${local}.part`;
    fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(part, 0o755);
    fs.renameSync(part, local);
  }
  return (ytdlp = local);
}

let ffmpeg;
/** Pasta/arquivo do ffmpeg para o yt-dlp (null = sem ffmpeg). */
export async function ffmpegLocation() {
  if (ffmpeg !== undefined) return ffmpeg;
  if (process.env.TRAMA_FFMPEG) return (ffmpeg = process.env.TRAMA_FFMPEG);
  return (ffmpeg = (await works('ffmpeg', ['-version'])) ? 'ffmpeg' : null);
}

/** Aceita só endereços http(s). */
export function checkUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error('Isso não parece um link. Mande o endereço completo, começando com https://');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Só links http ou https.');
  return u.toString();
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const fmtTime = (s) => {
  if (!Number.isFinite(s)) return undefined;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

/** Resumo das informações do yt-dlp (-J) para o agente. */
export function summarizeInfo(j) {
  const music = j.track || j.artist ? { track: j.track, artist: j.artist || j.creator, album: j.album } : undefined;
  return {
    url: j.webpage_url || j.original_url,
    site: j.extractor_key || j.extractor,
    id: j.id,
    title: j.title,
    channel: j.channel || j.uploader,
    duration_s: j.duration,
    duration: fmtTime(j.duration),
    upload_date: j.upload_date ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}` : undefined,
    is_live: j.is_live || undefined,
    width: j.width,
    height: j.height,
    ...(music ? { music } : {}),
    chapters: (j.chapters || []).slice(0, 40).map((c) => ({ title: c.title, start: fmtTime(c.start_time), start_s: c.start_time })),
    categories: j.categories,
    tags: (j.tags || []).slice(0, 15),
    description: clip(j.description || '', 1500),
  };
}

/** Lê as informações do link sem baixar o vídeo. */
export async function probe(url, { signal } = {}) {
  const bin = await ytDlpPath();
  const { code, out, err } = await exec(bin, ['-J', '--no-playlist', '--skip-download', '--no-warnings', checkUrl(url)], { signal });
  if (code !== 0) throw new Error(`não consegui ler o link: ${clip(err.trim().split('\n').pop() || 'erro desconhecido', 300)}`);
  return summarizeInfo(JSON.parse(out));
}

/**
 * Argumentos do yt-dlp para baixar vídeo ou áudio, inteiro ou um trecho.
 * Com ffmpeg: melhor vídeo + melhor áudio juntos em mp4 (até maxHeight).
 * Sem ffmpeg: formato de arquivo único (mp4 com som, até 720p) e sem corte.
 */
export function downloadArgs(url, { what = 'video', start, end, maxHeight = 1080, ffmpeg = null, outDir }) {
  const args = ['--no-playlist', '--no-warnings', '--newline', '--restrict-filenames', '-o', path.join(outDir, '%(id)s.%(ext)s')];
  if (ffmpeg && ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', ffmpeg);
  if (what === 'audio') {
    args.push('-f', 'bestaudio[ext=m4a]/bestaudio');
    if (ffmpeg) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (ffmpeg) {
    args.push('-f', `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`, '--merge-output-format', 'mp4');
  } else {
    args.push('-f', 'b[ext=mp4][height<=720]/b[ext=mp4]/b');
  }
  const cut = Number.isFinite(start) || Number.isFinite(end);
  if (cut && ffmpeg) {
    args.push('--download-sections', `*${Number.isFinite(start) ? start : 0}-${Number.isFinite(end) ? end : 'inf'}`, '--force-keyframes-at-cuts');
  }
  args.push(url);
  return args;
}

/**
 * Baixa o vídeo ou o áudio do link para uma pasta temporária.
 * @returns {Promise<{ file: string, dir: string, cut: boolean }>}
 */
export async function downloadMedia(url, { what = 'video', start, end, maxHeight, signal, onProgress } = {}) {
  const bin = await ytDlpPath();
  const ff = await ffmpegLocation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-dl-'));
  const args = downloadArgs(checkUrl(url), { what, start, end, maxHeight, ffmpeg: ff, outDir: dir });
  const { code, err } = await exec(bin, args, {
    signal,
    onLine: (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) onProgress?.(Number(m[1]) / 100);
    },
  });
  if (code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`não consegui baixar: ${clip(err.trim().split('\n').pop() || 'erro desconhecido', 300)}`);
  }
  const files = fs.readdirSync(dir).filter((f) => !/\.(part|ytdl|temp)$/.test(f)).map((f) => path.join(dir, f));
  if (!files.length) throw new Error('o download terminou sem arquivo');
  // Se sobrou mais de um (vídeo e áudio separados), fica o maior.
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const cut = (Number.isFinite(start) || Number.isFinite(end)) && Boolean(ff);
  return { file: files[0], dir, cut };
}
