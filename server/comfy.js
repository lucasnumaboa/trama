// Cliente do ComfyUI local: catálogo de nós, workflows salvos, upload,
// envio de prompts, progresso por WebSocket e resultados por /history.
import { randomUUID } from 'node:crypto';
import { getSettings } from './settings.js';

const base = () => getSettings().comfyUrl;

async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(init.timeout ?? 60000), ...init });
  } catch (error) {
    throw new Error(`ComfyUI não respondeu em ${base()} (${error.cause?.code || error.message})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ComfyUI ${path}: HTTP ${res.status} ${text.slice(0, 2000)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res;
}

export const getJson = async (path, init) => (await request(path, init)).json();

let objectInfoCache = { at: 0, value: null };
export async function objectInfo({ refresh = false } = {}) {
  if (!refresh && objectInfoCache.value && Date.now() - objectInfoCache.at < 5 * 60000) return objectInfoCache.value;
  const value = await getJson('/object_info', { timeout: 120000 });
  objectInfoCache = { at: Date.now(), value };
  return value;
}

export const systemStats = () => getJson('/system_stats', { timeout: 5000 });

export async function listWorkflows() {
  const list = await getJson('/api/userdata?dir=workflows&recurse=true&split=false&full_info=true');
  return list
    .map((item) => (typeof item === 'string' ? { path: item } : item))
    .filter((item) => item.path.endsWith('.json'))
    .map((item) => ({ name: item.path, modified: item.modified ?? null, size: item.size ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const loadWorkflow = (name) => getJson(`/api/userdata/${encodeURIComponent(`workflows/${name}`)}`);

/** Envia um arquivo para a pasta input do ComfyUI. Devolve o nome a usar nos nós Load*. */
export async function uploadInput(buffer, filename, { overwrite = true } = {}) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), filename);
  form.append('type', 'input');
  form.append('overwrite', overwrite ? 'true' : 'false');
  const data = await getJson('/upload/image', { method: 'POST', body: form, timeout: 600000 });
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function fetchFile({ filename, subfolder = '', type = 'output' }) {
  const qs = new URLSearchParams({ filename, subfolder, type });
  return request(`/view?${qs}`, { timeout: 600000 });
}

export const viewUrl = ({ filename, subfolder = '', type = 'output' }) =>
  `${base()}/view?${new URLSearchParams({ filename, subfolder, type })}`;

export async function interrupt(promptId) {
  await request('/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
  }).catch(() => {});
}

export async function deleteFromQueue(promptIds) {
  await request('/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: promptIds }),
  }).catch(() => {});
}

// ---- WebSocket: progresso em tempo real -------------------------------------
const CLIENT_ID = `trama-${randomUUID()}`;
const listeners = new Map(); // prompt_id -> callback(evento)
let socket = null;
let reconnectTimer = null;

function ensureSocket() {
  if (socket && socket.readyState <= 1) return;
  if (typeof WebSocket === 'undefined') return; // sem WebSocket: só polling
  const url = `${base().replace(/^http/, 'ws')}/ws?clientId=${CLIENT_ID}`;
  try {
    socket = new WebSocket(url);
  } catch {
    return;
  }
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return; // pré-visualizações binárias
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const promptId = msg.data?.prompt_id;
    if (promptId && listeners.has(promptId)) listeners.get(promptId)(msg);
  });
  socket.addEventListener('close', () => {
    socket = null;
    if (listeners.size && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureSocket();
      }, 2000);
    }
  });
  socket.addEventListener('error', () => {});
}

/**
 * Enfileira um prompt e espera terminar.
 * onEvent recebe {type:'queued'|'progress'|'executing', ...}.
 * Devolve o registro de /history daquele prompt.
 */
export async function runPrompt(prompt, { onEvent = () => {}, signal } = {}) {
  ensureSocket();
  const submitted = await getJson('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: CLIENT_ID, extra_data: { comfy_usage_source: 'trama' } }),
  }).catch((error) => {
    // Erros de validação vêm em JSON com node_errors: deixa a mensagem legível.
    try {
      const body = JSON.parse(error.body);
      const details = Object.entries(body.node_errors || {})
        .flatMap(([id, e]) => (e.errors || []).map((x) => `${prompt[id]?._meta?.title || id}: ${x.message} ${x.details || ''}`))
        .join('; ');
      throw new Error(`ComfyUI recusou o workflow: ${body.error?.message || ''} ${details}`.trim());
    } catch (parsed) {
      if (parsed instanceof SyntaxError) throw error;
      throw parsed;
    }
  });
  const promptId = submitted.prompt_id;
  onEvent({ type: 'queued', promptId, number: submitted.number });

  let finished = null;
  let wsDone = false;
  const done = new Promise((resolve) => (finished = resolve)).then(() => (wsDone = true));
  listeners.set(promptId, (msg) => {
    if (msg.type === 'progress') onEvent({ type: 'progress', value: msg.data.value, max: msg.data.max, node: msg.data.node });
    else if (msg.type === 'executing' && msg.data.node) onEvent({ type: 'executing', node: msg.data.node });
    else if (msg.type === 'execution_success' || msg.type === 'execution_error' || msg.type === 'execution_interrupted') finished();
  });
  const onAbort = () => {
    interrupt(promptId);
    deleteFromQueue([promptId]);
    finished();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // Polling de /history como garantia (o WebSocket só acelera).
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelado');
      const history = await getJson(`/history/${promptId}`).catch(() => ({}));
      const entry = history[promptId];
      if (entry?.status?.completed || entry?.status?.status_str === 'error') return checkHistory(entry, prompt);
      // Espera o aviso do WebSocket ou 1,5 s; depois do aviso, consulta a cada 300 ms.
      if (wsDone) await new Promise((r) => setTimeout(r, 300));
      else await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    }
  } finally {
    listeners.delete(promptId);
    signal?.removeEventListener('abort', onAbort);
  }
}

function checkHistory(entry, prompt) {
  if (entry.status?.status_str === 'error') {
    const err = (entry.status.messages || []).find(([type]) => type === 'execution_error')?.[1];
    const where = err?.node_id ? `${prompt[err.node_id]?._meta?.title || err.node_type || err.node_id}: ` : '';
    throw new Error(`Erro no ComfyUI: ${where}${err?.exception_message?.trim() || 'falha na execução'}`);
  }
  if (entry.status?.messages?.some(([type]) => type === 'execution_interrupted')) throw new Error('Execução interrompida no ComfyUI');
  return entry;
}

// ---- Classificação de arquivos de saída --------------------------------------
const EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac'],
};
export function mediaKind(filename = '') {
  const ext = filename.split('.').pop().toLowerCase();
  return Object.keys(EXT).find((kind) => EXT[kind].includes(ext)) || 'file';
}

/** Junta os arquivos gerados por nó de saída: {nodeId: [{filename, subfolder, type, kind}]} */
export function collectOutputs(historyEntry) {
  const result = {};
  for (const [nodeId, out] of Object.entries(historyEntry.outputs || {})) {
    const files = [];
    for (const value of Object.values(out)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.filename === 'string') {
          files.push({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output', kind: mediaKind(item.filename) });
        }
      }
    }
    if (files.length) result[nodeId] = files;
    // Saídas de texto (ex.: PreviewAny / nós que mostram texto)
    const texts = out.text || out.string;
    if (Array.isArray(texts) && texts.every((t) => typeof t === 'string')) {
      result[nodeId] = [...(result[nodeId] || []), ...texts.map((text) => ({ kind: 'text', text }))];
    }
  }
  return result;
}
