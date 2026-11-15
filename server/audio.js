// "Ouvidos" do agente: mede um áudio (ou o som de um vídeo) no ComfyUI com o nó
// TramaAnalyzeAudio (custom node ComfyUI-Trama) e, se pedido, separa voz e
// instrumental antes (Mel-Band RoFormer). Assim o agente descobre sozinho o tom da
// voz, se é canto ou fala e se tem música de fundo, em vez de perguntar ao usuário.
import * as comfy from './comfy.js';
import { asComfyInput } from './exec.js';

export const ANALYZE_NODE = 'TramaAnalyzeAudio';
export const TRANSCRIBE_NODE = 'TramaTranscribeAudio';
const SEPARATOR = ['MelBandRoFormerModelLoader', 'MelBandRoFormerSampler'];
const SEPARATOR_MODEL = 'MelBandRoformer_fp16.safetensors';

/** Monta o prompt de análise (com ou sem separação de voz). */
export function analysisPrompt(input, { separate, lyrics = false, language = 'auto' }) {
  const prompt = { load: { class_type: 'LoadAudio', inputs: { audio: input }, _meta: { title: 'Áudio' } } };
  const inputs = { audio: ['load', 0] };
  if (separate) {
    prompt.model = { class_type: SEPARATOR[0], inputs: { model_name: SEPARATOR_MODEL }, _meta: { title: 'Modelo de separação' } };
    prompt.sep = { class_type: SEPARATOR[1], inputs: { model: ['model', 0], audio: ['load', 0] }, _meta: { title: 'Separando voz e instrumental' } };
    inputs.vocals = ['sep', 0];
    inputs.instruments = ['sep', 1];
  }
  prompt.analyze = { class_type: ANALYZE_NODE, inputs, _meta: { title: 'Medindo o áudio' } };
  if (lyrics) {
    prompt.transcribe = { class_type: TRANSCRIBE_NODE, inputs: { audio: inputs.vocals || ['load', 0], language }, _meta: { title: 'Transcrevendo a voz' } };
  }
  return prompt;
}

/** Lê o relatório (JSON) que o nó devolve como texto. */
export function parseReport(history) {
  const outputs = comfy.collectOutputs(history);
  const text = (outputs.analyze || []).find((x) => x.kind === 'text')?.text;
  if (!text) throw new Error('o nó de análise não devolveu relatório');
  const report = JSON.parse(text);
  const lyrics = (outputs.transcribe || []).find((x) => x.kind === 'text')?.text;
  if (lyrics) report.transcript = JSON.parse(lyrics);
  return report;
}

/** Frases curtas em português para o agente (e para o usuário, se ele perguntar). */
export function summarize(r) {
  const lines = [`Duração ${r.duration_s} s, volume ${r.loudness_db} dB.`];
  if (r.has_music !== undefined) {
    lines.push(r.is_voice_only ? 'Só voz (sem música de fundo relevante).' : r.has_music ? `Tem música junto com a voz (voz ${r.vocals_minus_instruments_db} dB em relação ao instrumental).` : 'Voz com um pouco de som de fundo.');
  }
  if (r.tempo_bpm) lines.push(`Andamento ~${r.tempo_bpm} BPM (ou ${r.tempo_bpm_alt}), tonalidade provável ${r.key}.`);
  if (r.transcript?.segments?.length) lines.push(`Letra transcrita em ${r.transcript.segments.length} trechos com tempos (transcript.segments${r.transcript.segments.some((s) => s.words?.length) ? ', com o tempo de cada palavra em words' : ''}).`);
  if (r.median_hz) {
    lines.push(`Voz: tom mediano ${r.median_hz} Hz (${r.median_note}), região ${r.voice_register}, faixa de ${r.range_notes?.[0]} a ${r.range_notes?.[1]}${r.looks_like ? `, parece ${r.looks_like}` : ''}; ${r.voice_seconds} s com voz.`);
  } else if (r.voice_seconds === 0) {
    lines.push('Não encontrei voz neste áudio.');
  }
  return lines.join(' ');
}

const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

const round2 = (n) => Math.round(n * 100) / 100;

// Palavras da transcrição em ordem, com a frase (segmento) de cada uma.
function sungWords(transcript) {
  return (transcript?.segments || []).flatMap((s, segment) =>
    (s.words || []).map(([start, end, text]) => ({ start, end, text, key: normalize(text), segment })).filter((w) => w.key));
}

// Onde a frase aparece na lista de palavras: [{ i, len, score }] em ordem de tempo.
function locatePhrase(words, phrase, minScore) {
  const target = normalize(phrase);
  if (!target || !words.length) return [];
  const size = target.split(' ').length;
  const found = [];
  for (let i = 0; i < words.length; i++) {
    for (const len of [size - 1, size, size + 1]) {
      if (len < 1 || i + len > words.length) continue;
      const text = words.slice(i, i + len).map((w) => w.key).join(' ');
      const score = 1 - editDistance(text, target) / Math.max(text.length, target.length);
      if (score >= minScore) found.push({ i, len, score });
    }
  }
  // Janelas que se sobrepõem: fica a mais parecida com a frase.
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found) if (!kept.some((k) => f.i < k.i + k.len && k.i < f.i + f.len)) kept.push(f);
  return kept.sort((a, b) => a.i - b.i);
}

/**
 * Acha onde uma frase é cantada, pelas palavras da transcrição (segments[].words =
 * [início, fim, palavra]). A frase pode atravessar duas frases da transcrição e vir
 * escrita um pouco diferente ("deixe" por "deixa"), então a comparação é aproximada.
 * Devolve cada ocorrência com o trecho pronto para o repaint: começa 0,05 s antes da
 * primeira palavra, termina no fim da última e tem pelo menos minSeconds (o ACE-Step
 * regera de 3 a 90 s), incluindo palavras vizinhas quando a frase é mais curta.
 */
export function findPhrase(transcript, phrase, { minScore = 0.72, minSeconds = 3 } = {}) {
  const words = sungWords(transcript);
  return locatePhrase(words, phrase, minScore).map(({ i, len, score }, n) => {
    let a = i;
    let b = i + len - 1;
    while (words[b].end - words[a].start < minSeconds && (a > 0 || b < words.length - 1)) {
      if (a > 0) a -= 1;
      else b += 1;
    }
    const match = {
      occurrence: n + 1,
      start_seconds: round2(Math.max(0, words[a].start - 0.05)),
      end_seconds: round2(words[b].end),
      sung: words.slice(i, i + len).map((w) => w.text).join(' '),
      score: round2(score),
    };
    if (a < i || b > i + len - 1) match.window_text = words.slice(a, b + 1).map((w) => w.text).join(' ');
    return match;
  });
}

/**
 * Letra para trocar uma ocorrência da frase: a música inteira como é cantada (uma frase
 * da transcrição por linha), com só essa ocorrência trocada. As outras repetições ficam
 * como estão no áudio: com a frase nova em todas, o modelo copia o refrão que ouve no
 * resto da música e a letra nova não entra.
 */
export function swapLyrics(transcript, phrase, replacement, occurrence = 1, { minScore = 0.72 } = {}) {
  const words = sungWords(transcript);
  const hit = locatePhrase(words, phrase, minScore)[occurrence - 1];
  const text = String(replacement || '').trim();
  if (!hit || !text) return null;
  // Por frase da transcrição: uma lista de linhas, cada linha uma lista de palavras.
  // A frase nova vai numa linha só dela: nos testes entrou inteira mais vezes assim
  // do que no meio de uma linha.
  const lines = (transcript.segments || []).map((s) => [s.words?.length ? [] : [String(s.text || '').trim()]]);
  words.forEach((w, k) => {
    const segment = lines[w.segment];
    if (k === hit.i) {
      // Mantém a vírgula ou o ponto que fechava a frase original.
      const closing = /[,.;!?]$/.test(text) ? '' : words[hit.i + hit.len - 1].text.match(/[,.;!?]+$/)?.[0] || '';
      segment.push([text + closing], []);
    } else if (k < hit.i || k >= hit.i + hit.len) {
      segment[segment.length - 1].push(w.text);
    }
  });
  return lines.flat().map((l) => l.join(' ')).filter(Boolean).join('\n');
}

/**
 * Mede o áudio de um card (áudio ou vídeo).
 * @returns {Promise<object>} relatório + summary
 */
export async function analyzeAudio(asset, { separate = true, lyrics = false, language = 'auto', signal } = {}) {
  const info = await comfy.objectInfo();
  if (!info[ANALYZE_NODE]) throw new Error('falta o custom node ComfyUI-Trama no ComfyUI (pasta comfy-nodes/ComfyUI-Trama do Trama): copie para ComfyUI/custom_nodes e reinicie o ComfyUI');
  const canSeparate = separate && SEPARATOR.every((n) => info[n]);
  if (lyrics && !info[TRANSCRIBE_NODE]) throw new Error('o ComfyUI-Trama instalado é antigo e não transcreve: copie a versão nova de comfy-nodes/ComfyUI-Trama e reinicie o ComfyUI');
  const history = await comfy.runPrompt(analysisPrompt(await asComfyInput(asset.file), { separate: canSeparate, lyrics, language }), { signal });
  const report = parseReport(history);
  return { ...report, separated: canSeparate, summary: summarize(report) };
}

/**
 * Tom para a troca de voz cantada: só 0 ou ±12 mantêm a voz afinada com o instrumental.
 * Compara o tom mediano da voz da música com o da referência.
 */
export function suggestPitchShift(songHz, refHz) {
  if (!songHz || !refHz) return { pitch_shift: 0, why: 'sem o tom das duas vozes, mantém 0' };
  const semis = 12 * Math.log2(refHz / songHz);
  if (semis <= -7) return { pitch_shift: -12, why: `a referência está ${Math.round(-semis)} semitons abaixo da voz da música: desce uma oitava` };
  if (semis >= 7) return { pitch_shift: 12, why: `a referência está ${Math.round(semis)} semitons acima da voz da música: sobe uma oitava` };
  return { pitch_shift: 0, why: `as duas vozes estão na mesma região (${Math.round(semis)} semitons de diferença): mantém 0` };
}
