// Legenda queimada no vídeo: transforma a transcrição (frases com o tempo de cada
// palavra) em blocos curtos de legenda e escreve um arquivo ASS para o filtro
// subtitles do ffmpeg (libass).

const MIN_HOLD = 0.7; // segundos mínimos de cada bloco na tela
const GAP = 0.04; // folga entre um bloco e o próximo

/** Quebra um texto em até duas linhas equilibradas. */
export function wrapTwoLines(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length <= maxChars || words.length < 2) return [text];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

// Palavras de uma frase: as da transcrição ou, sem elas, o texto dividido com o tempo
// distribuído pelo número de letras.
function wordsOf(seg) {
  if (Array.isArray(seg.words) && seg.words.length) {
    return seg.words.map((w) => (Array.isArray(w) ? { start: w[0], end: w[1], text: String(w[2]).trim() } : { start: w.start, end: w.end, text: String(w.text).trim() })).filter((w) => w.text);
  }
  const parts = String(seg.text || '').split(/\s+/).filter(Boolean);
  const total = parts.reduce((s, p) => s + p.length + 1, 0) || 1;
  const span = Math.max(0.1, Number(seg.end) - Number(seg.start));
  let t = Number(seg.start);
  return parts.map((p) => {
    const d = (span * (p.length + 1)) / total;
    const w = { start: t, end: t + d, text: p };
    t += d;
    return w;
  });
}

/**
 * Blocos de legenda: cada um com até duas linhas de maxChars, sem atravessar a pausa
 * entre frases. segments = [{ start, end, text, words? }] (words = [início, fim, palavra]).
 */
export function subtitleBlocks(segments, { maxChars = 42 } = {}) {
  const blocks = [];
  for (const seg of segments || []) {
    const words = wordsOf(seg);
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const text = cur.map((w) => w.text).join(' ');
      blocks.push({ start: cur[0].start, end: cur[cur.length - 1].end, lines: wrapTwoLines(text, maxChars) });
      cur = [];
    };
    for (const w of words) {
      const next = [...cur, w].map((x) => x.text).join(' ');
      // Fecha o bloco ao passar de duas linhas ou numa pausa longa no meio da frase.
      if (cur.length && (next.length > maxChars * 2 || w.start - cur[cur.length - 1].end > 1.2)) flush();
      cur.push(w);
      if (/[.!?…]$/.test(w.text) && cur.map((x) => x.text).join(' ').length > maxChars * 0.6) flush();
    }
    flush();
  }
  blocks.sort((a, b) => a.start - b.start);
  // Tempo mínimo na tela, sem invadir o próximo bloco.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const limit = i + 1 < blocks.length ? blocks[i + 1].start - GAP : Infinity;
    b.end = Math.min(Math.max(b.end, b.start + MIN_HOLD), limit);
    if (b.end <= b.start) b.end = b.start + 0.1;
  }
  return blocks;
}

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

// "#rrggbb" -> "&H00bbggrr" (cor do ASS).
function assColor(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return fallback;
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2));
  return `&H00${b}${g}${r}`.toUpperCase();
}

const escapeAss = (s) => String(s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');

/**
 * Arquivo ASS no tamanho do vídeo. position: bottom | top | middle.
 * font_size em pixels (padrão: 5,5% da altura, ou da largura no vídeo deitado... o menor lado).
 */
export function buildAss(blocks, { width, height, position = 'bottom', fontSize, color, outlineColor, font = 'Arial', box = false } = {}) {
  const W = Math.round(width || 1920);
  const H = Math.round(height || 1080);
  const base = Math.min(W, H);
  const size = Math.round(fontSize || base * 0.075);
  const align = { bottom: 2, top: 8, middle: 5 }[position] || 2;
  const marginV = Math.round(H * (position === 'middle' ? 0 : 0.07));
  const primary = assColor(color, '&H00FFFFFF');
  const outline = assColor(outlineColor, '&H00000000');
  const borderStyle = box ? 3 : 1;
  const outlineW = Math.max(2, Math.round(size * 0.08));
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},${primary},${primary},${outline},&H80000000,-1,0,0,0,100,100,0,0,${borderStyle},${outlineW},1,${align},${Math.round(W * 0.05)},${Math.round(W * 0.05)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...blocks.map((b) => `Dialogue: 0,${assTime(b.start)},${assTime(b.end)},Default,,0,0,0,,${b.lines.map(escapeAss).join('\\N')}`),
  ];
  return lines.join('\n') + '\n';
}
