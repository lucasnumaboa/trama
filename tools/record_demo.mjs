// Records the README demo: creates a project, types a request in the chat,
// takes one frame per second while the agent works and builds a GIF with ffmpeg.
// Usage (Trama and ComfyUI running): node tools/record_demo.mjs "<request>"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const base = process.env.TRAMA_URL || 'http://127.0.0.1:5190';
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const request = process.argv[2] || 'Create a photo of a steaming cup of coffee on a wooden table at sunrise, then make a watercolor version of it. Go ahead without asking.';
const out = path.resolve('docs/screenshots/demo.gif');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-demo-'));

const project = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1440, height: 860 }, args: ['--mute-audio'] });
let n = 0;
const snap = async (page) => page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/#project=${project.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer textarea');
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 2; i++) await snap(page);
  // Digita como uma pessoa (aparece no GIF).
  await page.click('.composer textarea');
  for (const chunk of request.match(/.{1,6}/g)) {
    await page.type('.composer textarea', chunk);
    await snap(page);
  }
  await page.keyboard.press('Enter');
  // Um quadro por segundo até o agente terminar (máx. 15 min).
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - started < 15 * 60000) {
    await snap(page);
    const busy = await page.$('.round-btn.stop');
    if (!busy && Date.now() - started > 8000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Final: espera as imagens carregarem e segura alguns quadros.
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 6; i++) await snap(page);
} finally {
  await browser.close();
}

// Tira quadros repetidos, acelera para ~20 s e gera o GIF com paleta.
const palette = path.join(frames, 'palette.png');
const filters = 'mpdecimate=hi=64*24:lo=64*8:frac=0.2,setpts=N/(8*TB),scale=1100:-1:flags=lanczos';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '8', '-i', path.join(frames, 'f%04d.png'), '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '8', '-i', path.join(frames, 'f%04d.png'), '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', out]);
fs.rmSync(frames, { recursive: true, force: true });
console.log(`saved ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${n} frames captured), project ${project.id}`);
