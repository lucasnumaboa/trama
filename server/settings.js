// Configurações locais (data/settings.json). Chaves de API nunca são devolvidas
// inteiras para o navegador: só uma versão mascarada.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No app instalado os dados ficam na pasta do usuário (TRAMA_DATA_DIR); no repositório, em data/.
const DATA_DIR = process.env.TRAMA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

/**
 * Provedores do agente. kind diz como o servidor conversa com ele (ver llm.js).
 * Cada um guarda a própria chave, modelo e endereço: trocar de provedor não apaga nada.
 */
export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', kind: 'openai', needsKey: true, defaults: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } },
  openai: { label: 'OpenAI', kind: 'openai', needsKey: true, defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' } },
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', needsKey: true, defaults: { baseUrl: '', model: 'claude-opus-5-5' } },
  openrouter: { label: 'OpenRouter', kind: 'openai', needsKey: true, defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' } },
  comfyui: { label: 'ComfyUI (modelo local)', kind: 'comfyui', needsKey: false, defaults: { baseUrl: '', model: 'qwen3vl_8b_int8_convrot.safetensors|qwen_image' } },
  custom: { label: 'Personalizado (compatível com OpenAI)', kind: 'openai', needsKey: false, defaults: { baseUrl: 'http://127.0.0.1:1234/v1', model: '' } },
};

const DEFAULTS = {
  llmProvider: 'deepseek',
  providers: {},
  comfyUrl: 'http://127.0.0.1:8188',
  // Triagem: depois de cada imagem/vídeo gerado, a visão descreve e a IA compara com o pedido.
  reviewGenerations: true,
};

let cache = null;

/** Configurações antigas (deepseekApiKey, deepseekModel, deepseekBaseUrl) viram providers.deepseek. */
function migrate(raw) {
  const s = { ...DEFAULTS, ...raw, providers: { ...(raw.providers || {}) } };
  if (raw.deepseekApiKey !== undefined || raw.deepseekModel !== undefined || raw.deepseekBaseUrl !== undefined) {
    s.providers.deepseek = {
      apiKey: raw.deepseekApiKey ?? '',
      model: raw.deepseekModel ?? PROVIDERS.deepseek.defaults.model,
      baseUrl: raw.deepseekBaseUrl ?? PROVIDERS.deepseek.defaults.baseUrl,
      ...(raw.providers?.deepseek || {}),
    };
    delete s.deepseekApiKey;
    delete s.deepseekModel;
    delete s.deepseekBaseUrl;
  }
  if (!PROVIDERS[s.llmProvider]) s.llmProvider = DEFAULTS.llmProvider;
  return s;
}

export function getSettings() {
  if (cache) return cache;
  try {
    cache = migrate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    cache = migrate({});
  }
  return cache;
}

/** Configuração de um provedor: o que foi salvo por cima dos padrões dele. */
export function providerConfig(id) {
  const saved = getSettings().providers[id] || {};
  const d = PROVIDERS[id]?.defaults || {};
  return { apiKey: saved.apiKey || '', model: saved.model || d.model || '', baseUrl: (saved.baseUrl ?? d.baseUrl ?? '').replace(/\/+$/, '') };
}

export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function publicSettings() {
  const s = getSettings();
  const providers = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, def]) => {
      const c = providerConfig(id);
      return [id, { label: def.label, kind: def.kind, needsKey: def.needsKey, model: c.model, baseUrl: c.baseUrl, keySet: Boolean(c.apiKey), keyMasked: maskKey(c.apiKey), ready: !def.needsKey || Boolean(c.apiKey) }];
    }),
  );
  const active = providerConfig(s.llmProvider);
  return {
    llmProvider: s.llmProvider,
    providers,
    comfyUrl: s.comfyUrl,
    reviewGenerations: s.reviewGenerations !== false,
    // Compatibilidade com telas antigas.
    deepseekModel: active.model,
    deepseekKeySet: providers[s.llmProvider].ready,
  };
}

/**
 * Atualiza só o que veio no patch:
 *   { llmProvider, providers: { id: { apiKey?, model?, baseUrl? } }, comfyUrl, reviewGenerations }
 * apiKey "" apaga a chave daquele provedor; os outros provedores ficam como estão.
 * Aceita ainda os campos antigos deepseekApiKey/deepseekModel/deepseekBaseUrl.
 */
export function updateSettings(patch = {}) {
  const next = { ...getSettings(), providers: { ...getSettings().providers } };
  if (patch.llmProvider !== undefined) {
    if (!PROVIDERS[patch.llmProvider]) throw new Error(`Provedor desconhecido: ${patch.llmProvider}`);
    next.llmProvider = patch.llmProvider;
  }
  const incoming = { ...(patch.providers || {}) };
  const legacy = {};
  if (patch.deepseekApiKey !== undefined) legacy.apiKey = patch.deepseekApiKey;
  if (patch.deepseekModel !== undefined) legacy.model = patch.deepseekModel;
  if (patch.deepseekBaseUrl !== undefined) legacy.baseUrl = patch.deepseekBaseUrl;
  if (Object.keys(legacy).length) incoming.deepseek = { ...legacy, ...(incoming.deepseek || {}) };
  for (const [id, cfg] of Object.entries(incoming)) {
    if (!PROVIDERS[id]) throw new Error(`Provedor desconhecido: ${id}`);
    const cur = { ...(next.providers[id] || {}) };
    for (const k of ['apiKey', 'model', 'baseUrl']) {
      if (cfg?.[k] === undefined) continue;
      if (typeof cfg[k] !== 'string') throw new Error(`${id}.${k} precisa ser texto`);
      cur[k] = k === 'baseUrl' ? cfg[k].trim().replace(/\/+$/, '') : cfg[k].trim();
    }
    next.providers[id] = cur;
  }
  if (patch.comfyUrl !== undefined) {
    if (typeof patch.comfyUrl !== 'string') throw new Error('comfyUrl precisa ser texto');
    next.comfyUrl = patch.comfyUrl.trim().replace(/\/+$/, '');
  }
  if (patch.reviewGenerations !== undefined) {
    if (typeof patch.reviewGenerations !== 'boolean') throw new Error('reviewGenerations precisa ser verdadeiro ou falso');
    next.reviewGenerations = patch.reviewGenerations;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  cache = next;
  return publicSettings();
}

export { DATA_DIR };
