// Takes the README screenshots from a running Trama (npm start) using the
// installed Chrome. Usage: node tools/screenshots.mjs <projectId>
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const project = process.argv[2];
const base = process.env.TRAMA_URL || 'http://127.0.0.1:5190';
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = path.resolve('docs/screenshots');
fs.mkdirSync(out, { recursive: true });

const shots = [
  { name: 'main', hash: `project=${project}`, wait: '.card img' },
  { name: 'settings-models', hash: `project=${project}&modal=settings&section=models`, wait: '#settings-models select' },
  { name: 'workflows', hash: `project=${project}&modal=workflows`, wait: '.wf-item' },
  // Compositor: três cards viram anexos, dois são citados no texto e o seletor de modelos fica aberto. Nada é enviado.
  { name: 'composer', hash: `project=${project}`, wait: '.card img', action: composer },
  { name: 'model-picker', hash: `project=${project}`, wait: '.card img', action: picker },
];

async function picker(page) {
  await page.click('.picker-anchor .bar-btn');
  await page.waitForSelector('.mp-item');
  await page.mouse.move(10, 10);
}

async function composer(page) {
  const nodes = await page.$$('.react-flow__node:has(.kind-image img)');
  await page.keyboard.down('Shift');
  for (const n of nodes.slice(0, 3)) await n.click();
  await page.keyboard.up('Shift');
  await page.waitForSelector('.attach-thumb');
  await page.click('.editor');
  await page.keyboard.type('Anime ');
  await (await page.$$('.attach-thumb'))[0].click();
  await page.keyboard.type('com os fios pulsando, usando a paleta de ');
  const thumbs = await page.$$('.attach-thumb');
  await thumbs[Math.min(1, thumbs.length - 1)].click();
  await page.keyboard.type('num vídeo vertical de 5 segundos');
  await page.mouse.move(10, 10);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1600, height: 940, deviceScaleFactor: 1 }, args: ['--mute-audio'] });
try {
  for (const s of shots) {
    const page = await browser.newPage();
    await page.goto(`${base}/#${s.hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(s.wait, { timeout: 30000 });
    // Espera imagens e miniaturas de vídeo terminarem de carregar.
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
      await Promise.all([...document.querySelectorAll('video')].map((v) => (v.readyState >= 2 ? null : new Promise((r) => { v.onloadeddata = v.onerror = r; setTimeout(r, 4000); }))));
    });
    if (s.action) await s.action(page);
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(out, `${s.name}.png`) });
    console.log('saved', s.name);
    await page.close();
  }
} finally {
  await browser.close();
}
