import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisPrompt, parseReport, summarize, suggestPitchShift, findPhrase, swapLyrics } from './audio.js';

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

// Transcrição real do primeiro refrão de uma música: a frase atravessa duas frases da
// transcrição e o Whisper escreve "deixe" onde se canta "deixa".
const chorus = {
  segments: [
    { start: 50.38, end: 55.76, text: 'Felicidade, amor, então me encontra', words: [[50.38, 52.12, 'Felicidade,'], [52.12, 52.8, 'amor,'], [52.8, 53.2, 'então'], [53.2, 53.58, 'me'], [53.58, 55.76, 'encontra']] },
    { start: 55.98, end: 65.1, text: 'Ou deixe eu te encontrar, me encontra Ou deixe eu te encontrar, me encontra', words: [[55.98, 56.36, 'Ou'], [56.36, 56.86, 'deixe'], [56.86, 57.0, 'eu'], [57.0, 57.22, 'te'], [57.22, 58.8, 'encontrar,'], [58.8, 59.0, 'me'], [59.0, 59.7, 'encontra'], [61.32, 61.8, 'Ou'], [61.8, 62.18, 'deixe'], [62.18, 62.44, 'eu'], [62.44, 62.6, 'te'], [62.6, 64.06, 'encontrar,'], [64.06, 64.32, 'me'], [64.32, 65.1, 'encontra']] },
  ],
};

test('findPhrase: acha cada ocorrência com a borda entre palavras', () => {
  const found = findPhrase(chorus, 'me encontra, ou deixa eu te encontrar');
  assert.deepEqual(found.map((m) => [m.start_seconds, m.end_seconds]), [[53.15, 58.8], [58.75, 64.06]]);
  assert.equal(found[0].sung, 'me encontra Ou deixe eu te encontrar,');
  assert.equal(found[0].window_text, undefined);
});

test('findPhrase: frase curta ganha palavras vizinhas até 3 s; frase ausente não casa', () => {
  const [short] = findPhrase(chorus, 'amor, então');
  assert.equal(short.sung, 'amor, então');
  assert.ok(short.end_seconds - short.start_seconds >= 3);
  assert.equal(short.window_text, 'Felicidade, amor, então me'); // 50,38 a 53,20 dá 2,82 s: entra mais uma palavra
  assert.deepEqual(findPhrase(chorus, 'completamente outra coisa aqui'), []);
  assert.deepEqual(findPhrase({ segments: [{ start: 0, end: 5, text: 'sem palavras' }] }, 'sem palavras'), []);
});

test('swapLyrics: a letra inteira como é cantada, com só a ocorrência escolhida trocada', () => {
  const phrase = 'me encontra, ou deixa eu te encontrar';
  assert.equal(
    swapLyrics(chorus, phrase, 'me chama, ou deixa eu te chamar', 1),
    'Felicidade, amor, então\nme chama, ou deixa eu te chamar,\nme encontra Ou deixe eu te encontrar, me encontra',
  );
  assert.equal(
    swapLyrics(chorus, phrase, 'me chama, ou deixa eu te chamar', 2),
    'Felicidade, amor, então me encontra\nOu deixe eu te encontrar,\nme chama, ou deixa eu te chamar,\nme encontra',
  );
  assert.equal(swapLyrics(chorus, phrase, 'me chama', 9), null);
  assert.equal(findPhrase(chorus, phrase)[1].occurrence, 2);
});
