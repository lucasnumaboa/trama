// Configurações locais (data/settings.json). A chave do DeepSeek nunca é
// devolvida inteira para o navegador: só uma versão mascarada.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  deepseekApiKey: '',
  deepseekModel: 'deepseek-chat',
  deepseekBaseUrl: 'https://api.deepseek.com',
  comfyUrl: 'http://127.0.0.1:8188',
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function publicSettings() {
  const s = getSettings();
  return {
    deepseekModel: s.deepseekModel,
    deepseekBaseUrl: s.deepseekBaseUrl,
    comfyUrl: s.comfyUrl,
    deepseekKeySet: Boolean(s.deepseekApiKey),
    deepseekKeyMasked: maskKey(s.deepseekApiKey),
  };
}

// Campos ausentes ficam como estão; deepseekApiKey vazio ("") apaga a chave.
export function updateSettings(patch) {
  const next = { ...getSettings() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'string') throw new Error(`${key} precisa ser texto`);
    next[key] = patch[key].trim();
  }
  if (next.comfyUrl) next.comfyUrl = next.comfyUrl.replace(/\/+$/, '');
  if (next.deepseekBaseUrl) next.deepseekBaseUrl = next.deepseekBaseUrl.replace(/\/+$/, '');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  cache = next;
  return publicSettings();
}

export { DATA_DIR };
