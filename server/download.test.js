import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, summarizeInfo, downloadArgs } from './download.js';

test('link: aceita http(s) e recusa o resto', () => {
  assert.equal(checkUrl(' https://youtu.be/abc123 '), 'https://youtu.be/abc123');
  assert.throws(() => checkUrl('youtube.com/watch?v=x'), /não parece um link/);
  assert.throws(() => checkUrl('file:///C:/x.mp4'), /Só links http/);
});

test('informações do yt-dlp viram um resumo curto', () => {
  const s = summarizeInfo({
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    extractor_key: 'Youtube',
    id: 'abc',
    title: 'Me Encontra',
    channel: 'Charlie Brown Jr.',
    duration: 219.3,
    upload_date: '20090115',
    track: 'Me Encontra',
    artist: 'Charlie Brown Jr.',
    chapters: [{ title: 'Refrão', start_time: 42 }],
    tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
    description: 'x'.repeat(3000),
  });
  assert.equal(s.duration, '3:39');
  assert.equal(s.upload_date, '2009-01-15');
  assert.deepEqual(s.music, { track: 'Me Encontra', artist: 'Charlie Brown Jr.', album: undefined });
  assert.deepEqual(s.chapters, [{ title: 'Refrão', start: '0:42', start_s: 42 }]);
  assert.equal(s.tags.length, 15);
  assert.ok(s.description.length <= 1501);
  assert.equal(summarizeInfo({ title: 'sem música' }).music, undefined);
});

test('argumentos: vídeo com e sem ffmpeg, áudio e trecho', () => {
  const url = 'https://youtu.be/abc';
  const withFf = downloadArgs(url, { what: 'video', ffmpeg: 'ffmpeg', outDir: 'T', start: 10, end: 25 });
  assert.ok(withFf.includes('--merge-output-format'));
  assert.equal(withFf[withFf.indexOf('--download-sections') + 1], '*10-25');
  assert.ok(!withFf.includes('--ffmpeg-location'));
  assert.equal(withFf.at(-1), url);

  const noFf = downloadArgs(url, { what: 'video', ffmpeg: null, outDir: 'T', start: 10, end: 25 });
  assert.ok(!noFf.includes('--download-sections'), 'sem ffmpeg não corta');
  assert.match(noFf[noFf.indexOf('-f') + 1], /^b\[ext=mp4\]/);

  const custom = downloadArgs(url, { what: 'audio', ffmpeg: 'C:/ff/ffmpeg.exe', outDir: 'T' });
  assert.equal(custom[custom.indexOf('--ffmpeg-location') + 1], 'C:/ff/ffmpeg.exe');
  assert.ok(custom.includes('-x'));
  assert.equal(custom[custom.indexOf('--audio-format') + 1], 'mp3');

  const fromStart = downloadArgs(url, { what: 'video', ffmpeg: 'ffmpeg', outDir: 'T', end: 30 });
  assert.equal(fromStart[fromStart.indexOf('--download-sections') + 1], '*0-30');
});
