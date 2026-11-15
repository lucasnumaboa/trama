// "Ouvidos" do agente: mede um áudio (ou o som de um vídeo) no ComfyUI com o nó
// TramaAnalyzeAudio (custom node ComfyUI-Trama) e, se pedido, separa voz e
// instrumental antes (Mel-Band RoFormer). Assim o agente descobre sozinho o tom da
// voz, se é canto ou fala e se tem música de fundo, em vez de perguntar ao usuário.
import * as comfy from './comfy.js';
import { asComfyInput } from './exec.js';

export const ANALYZE_NODE = 'TramaAnalyzeAudio';
const SEPARATOR = ['MelBandRoFormerModelLoader', 'MelBandRoFormerSampler'];
const SEPARATOR_MODEL = 'MelBandRoformer_fp16.safetensors';

/** Monta o prompt de análise (com ou sem separação de voz). */
export function analysisPrompt(input, { separate }) {
  const prompt = { load: { class_type: 'LoadAudio', inputs: { audio: input }, _meta: { title: 'Áudio' } } };
  const inputs = { audio: ['load', 0] };
  if (separate) {
    prompt.model = { class_type: SEPARATOR[0], inputs: { model_name: SEPARATOR_MODEL }, _meta: { title: 'Modelo de separação' } };
    prompt.sep = { class_type: SEPARATOR[1], inputs: { model: ['model', 0], audio: ['load', 0] }, _meta: { title: 'Separando voz e instrumental' } };
    inputs.vocals = ['sep', 0];
    inputs.instruments = ['sep', 1];
  }
  prompt.analyze = { class_type: ANALYZE_NODE, inputs, _meta: { title: 'Medindo o áudio' } };
  return prompt;
}

/** Lê o relatório (JSON) que o nó devolve como texto. */
export function parseReport(history) {
  const out = comfy.collectOutputs(history).analyze || [];
  const text = out.find((x) => x.kind === 'text')?.text;
  if (!text) throw new Error('o nó de análise não devolveu relatório');
  return JSON.parse(text);
}

/** Frases curtas em português para o agente (e para o usuário, se ele perguntar). */
export function summarize(r) {
  const lines = [`Duração ${r.duration_s} s, volume ${r.loudness_db} dB.`];
  if (r.has_music !== undefined) {
    lines.push(r.is_voice_only ? 'Só voz (sem música de fundo relevante).' : r.has_music ? `Tem música junto com a voz (voz ${r.vocals_minus_instruments_db} dB em relação ao instrumental).` : 'Voz com um pouco de som de fundo.');
  }
  if (r.median_hz) {
    lines.push(`Voz: tom mediano ${r.median_hz} Hz (${r.median_note}), região ${r.voice_register}, faixa de ${r.range_notes?.[0]} a ${r.range_notes?.[1]}${r.looks_like ? `, parece ${r.looks_like}` : ''}; ${r.voice_seconds} s com voz.`);
  } else if (r.voice_seconds === 0) {
    lines.push('Não encontrei voz neste áudio.');
  }
  return lines.join(' ');
}

/**
 * Mede o áudio de um card (áudio ou vídeo).
 * @returns {Promise<object>} relatório + summary
 */
export async function analyzeAudio(asset, { separate = true, signal } = {}) {
  const info = await comfy.objectInfo();
  if (!info[ANALYZE_NODE]) throw new Error('falta o custom node ComfyUI-Trama no ComfyUI (pasta comfy-nodes/ComfyUI-Trama do Trama): copie para ComfyUI/custom_nodes e reinicie o ComfyUI');
  const canSeparate = separate && SEPARATOR.every((n) => info[n]);
  const history = await comfy.runPrompt(analysisPrompt(await asComfyInput(asset.file), { separate: canSeparate }), { signal });
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
