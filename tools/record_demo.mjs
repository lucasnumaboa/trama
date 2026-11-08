// Records the README demo: creates a project, pastes the logo into the chat,
// picks the image-edit model for this project, cites the image inside the
// request, then takes one frame per second while the agent works and builds a GIF.
// Usage (Trama and ComfyUI running): node tools/record_demo.mjs [image]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const base = process.env.TRAMA_URL || 'http://127.0.0.1:5190';
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const image = path.resolve(process.argv[2] || 'public/logo.png');
const before = 'Make a watercolor painting version of ';
const after = ' and then remove its background. Go ahead without asking.';
const out = path.resolve('docs/screenshots/demo.gif');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-demo-'));

const project = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1440, height: 860 }, args: ['--mute-audio'] });
let n = 0;
const snap = async (page, times = 1) => {
  for (let i = 0; i < times; i++) await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(4, '0')}.png`) });
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const typeSlow = async (page, text) => {
  for (const chunk of text.match(/.{1,6}/g)) {
    await page.keyboard.type(chunk);
    await snap(page);
  }
};
try {
  const page = await browser.newPage();
  await page.goto(`${base}/#project=${project.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer .editor');
  await pause(1500);
  await snap(page, 2);

  // 1. Cola a imagem como se viesse da área de transferência.
  const b64 = fs.readFileSync(image).toString('base64');
  await page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    const ed = document.querySelector('.composer .editor');
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForSelector('.attach-thumb img');
  await pause(800);
  await snap(page, 3);

  // 2. Seletor de modelos: Flux.2 Klein para editar imagem, só neste projeto.
  await page.click('.picker-anchor .bar-btn');
  await page.waitForSelector('.mp-item');
  await page.evaluate(() => [...document.querySelectorAll('.mp-tabs button')].find((b) => b.textContent.startsWith('Imagem'))?.click());
  await pause(500);
  await snap(page, 3);
  await page.evaluate(() => {
    const box = document.querySelector('.mp-foot input');
    if (box?.checked) box.click();
    const items = [...document.querySelectorAll('.mp-list > div')].find((d) => /Editar/i.test(d.querySelector('.mp-section')?.textContent || ''));
    const flux = [...(items?.querySelectorAll('.mp-item') || [])].find((b) => /Flux/i.test(b.textContent));
    flux?.scrollIntoView({ block: 'center' });
  });
  await pause(400);
  await snap(page, 2);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.mp-list > div')].find((d) => /Editar/i.test(d.querySelector('.mp-section')?.textContent || ''));
    [...(items?.querySelectorAll('.mp-item') || [])].find((b) => /Flux/i.test(b.textContent))?.click();
  });
  await pause(1200);
  await snap(page, 4);
  await page.keyboard.press('Escape');
  await pause(300);

  // 3. Pedido com a imagem citada no meio do texto.
  await page.click('.composer .editor');
  await typeSlow(page, before);
  await page.click('.attach-thumb');
  await snap(page, 2);
  await typeSlow(page, after);
  await snap(page, 3);
  await page.keyboard.press('Enter');

  // Um quadro por segundo até o agente terminar (máx. 15 min).
  const started = Date.now();
  await pause(1500);
  while (Date.now() - started < 15 * 60000) {
    await snap(page);
    const busy = await page.$('.send-btn.stop');
    if (!busy && Date.now() - started > 8000) break;
    await pause(1000);
  }
  await pause(2500);
  await snap(page, 8);
} finally {
  await browser.close();
}

// Tira quadros repetidos, acelera e gera o GIF com paleta.
const palette = path.join(frames, 'palette.png');
const filters = 'mpdecimate=hi=64*24:lo=64*8:frac=0.2,setpts=N/(8*TB),scale=1100:-1:flags=lanczos';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '8', '-i', path.join(frames, 'f%04d.png'), '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '8', '-i', path.join(frames, 'f%04d.png'), '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', out]);
fs.rmSync(frames, { recursive: true, force: true });
console.log(`saved ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${n} frames captured), project ${project.id}`);
