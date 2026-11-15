import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisPrompt, parseReport, summarize, suggestPitchShift } from './audio.js';

test('tom da troca de voz: só 0 ou uma oitava inteira', () => {
  // Me Encontra (G3, 195 Hz) com a voz do WhatsApp (F#3, 189 Hz): mesma região
  assert.equal(suggestPitchShift(195.3, 188.8).pitch_shift, 0);
  // música cantada agudo (G4, 392 Hz) com referência grave (C3, 128 Hz): desce
  assert.equal(suggestPitchShift(392.2, 128.5).pitch_shift, -12);
  // o contrário: sobe
  assert.equal(suggestPitchShift(128.5, 392.2).pitch_shift, 12);
  // meio caminho (5 semitons) não justifica oitava
  assert.equal(suggestPitchShift(200, 267).pitch_shift, 0);
  assert.equal(suggestPitchShift(undefined, 200).pitch_shift, 0);
});

test('prompt de análise com e sem separação', () => {
  const sep = analysisPrompt('musica.mp3', { separate: true });
  assert.deepEqual(sep.analyze.inputs, { audio: ['load', 0], vocals: ['sep', 0], instruments: ['sep', 1] });
  assert.equal(sep.load.inputs.audio, 'musica.mp3');
  const plain = analysisPrompt('voz.ogg', { separate: false });
  assert.deepEqual(Object.keys(plain).sort(), ['analyze', 'load']);
  assert.deepEqual(plain.analyze.inputs, { audio: ['load', 0] });
});

test('relatório: lê o texto do nó e resume em português', () => {
  const report = { duration_s: 20.48, loudness_db: -23.4, has_music: false, is_voice_only: true, median_hz: 188.8, median_note: 'F#3', voice_register: 'médio', range_notes: ['C#3', 'D5'], looks_like: 'canto', voice_seconds: 16.1 };
  const history = { outputs: { analyze: { text: [JSON.stringify(report)] } } };
  assert.deepEqual(parseReport(history), report);
  const s = summarize(report);
  assert.match(s, /Só voz/);
  assert.match(s, /F#3/);
  assert.match(s, /parece canto/);
  assert.match(summarize({ duration_s: 3, loudness_db: -40, voice_seconds: 0 }), /Não encontrei voz/);
  assert.throws(() => parseReport({ outputs: {} }), /não devolveu relatório/);
});

test('com lyrics: transcreve a voz separada e junta a letra ao relatório', () => {
  const p = analysisPrompt('m.mp3', { separate: true, lyrics: true, language: 'portuguese' });
  assert.deepEqual(p.transcribe.inputs, { audio: ['sep', 0], language: 'portuguese' });
  const semSep = analysisPrompt('m.mp3', { separate: false, lyrics: true });
  assert.deepEqual(semSep.transcribe.inputs, { audio: ['load', 0], language: 'auto' });
  assert.equal(analysisPrompt('m.mp3', { separate: true }).transcribe, undefined);
  const transcript = { text: 'me encontra', segments: [{ start: 50.38, end: 55.76, text: 'Felicidade, amor, então me encontra' }] };
  const history = { outputs: { analyze: { text: [JSON.stringify({ duration_s: 219, loudness_db: -11, tempo_bpm: 117, tempo_bpm_alt: 58, key: 'D# major' })] }, transcribe: { text: [JSON.stringify(transcript)] } } };
  const r = parseReport(history);
  assert.deepEqual(r.transcript, transcript);
  assert.match(summarize(r), /117 BPM \(ou 58\).*D# major/);
  assert.match(summarize(r), /1 trechos com tempos/);
});
