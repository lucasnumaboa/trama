// Cliente do ComfyUI local: catálogo de nós, workflows salvos, upload,
// envio de prompts, progresso por WebSocket e resultados por /history.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, DATA_DIR } from './settings.js';

const base = () => getSettings().comfyUrl;

// streamBody: o tempo limite vale só até a resposta começar. Um vídeo servido para a
// interface pode ficar aberto por muito tempo (o navegador pausa o download), e um
// timeout no meio do stream derrubava o processo.
async function request(path, { timeout = 60000, streamBody = false, ...init } = {}) {
  let signal = AbortSignal.timeout(timeout);
  let timer = null;
  if (streamBody) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeout);
    signal = controller.signal;
  }
  let res;
  try {
    res = await fetch(`${base()}${path}`, { signal, ...init });
  } catch (error) {
    throw new Error(`ComfyUI não respondeu em ${base()} (${error.cause?.code || error.message})`);
  } finally {
    clearTimeout(timer);
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

/** Nome do arquivo do workflow: aceita sem ".json" (os modelos às vezes cortam a extensão). */
export const workflowFile = (name) => {
  const s = String(name || '').trim();
  return /\.json$/i.test(s) ? s : `${s}.json`;
};
export const loadWorkflow = (name) => getJson(`/api/userdata/${encodeURIComponent(`workflows/${workflowFile(name)}`)}`);

/** Grava um arquivo na pasta do usuário do ComfyUI (ex.: "workflows/trama_x.json"), sobrescrevendo. */
export async function saveUserdata(file, text) {
  await request(`/api/userdata/${encodeURIComponent(file)}?overwrite=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
}

/** Pastas que o ComfyUI usa: { custom_nodes: [...], checkpoints: [...], ... }. */
export const folderPaths = () => getJson('/internal/folder_paths', { timeout: 5000 });

/** Envia um arquivo para a pasta input do ComfyUI. Devolve o nome a usar nos nós Load*. */
export async function uploadInput(buffer, filename, { overwrite = true, subfolder = '' } = {}) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), filename);
  form.append('type', 'input');
  if (subfolder) form.append('subfolder', subfolder);
  form.append('overwrite', overwrite ? 'true' : 'false');
  const data = await getJson('/upload/image', { method: 'POST', body: form, timeout: 600000 });
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function fetchFile({ filename, subfolder = '', type = 'output' }) {
  const qs = new URLSearchParams({ filename, subfolder, type });
  return request(`/view?${qs}`, { timeout: 60000, streamBody: true });
}

// ---- Arquivo no disco (para "Mostrar na pasta") ------------------------------
// O ComfyUI não informa as pastas de saída, mas informa a de custom_nodes: a base é a
// pasta acima dela. --output-directory e afins, se usados, valem mais.
// As pastas ficam guardadas em data/comfy-dirs.json: com o ComfyUI ocupado, lento ou
// fechado, o Trama ainda acha os arquivos no disco (miniaturas e cards abrem na hora).
let dirsCache = null;
const DIRS_FILE = () => path.join(DATA_DIR, 'comfy-dirs.json');
function savedDirs() {
  try {
    const saved = JSON.parse(fs.readFileSync(DIRS_FILE(), 'utf8'));
    return saved.url === base() ? saved.value : null;
  } catch {
    return null;
  }
}
async function comfyDirs() {
  if (dirsCache && Date.now() - dirsCache.at < 60000) return dirsCache.value;
  try {
    return await freshDirs();
  } catch (error) {
    const value = dirsCache?.value || savedDirs();
    if (!value) throw error;
    dirsCache = { at: Date.now(), value };
    return value;
  }
}
async function freshDirs() {
  const [paths, stats] = await Promise.all([folderPaths(), systemStats()]);
  const customNodes = paths.custom_nodes?.[0];
  if (!customNodes) throw new Error('O ComfyUI não informou as pastas dele.');
  const sep = customNodes.includes('\\') ? '\\' : '/';
  const base = customNodes.slice(0, customNodes.lastIndexOf(sep));
  const argv = stats?.system?.argv || [];
  // Caminhos relativos nos argumentos partem da pasta onde o ComfyUI foi iniciado.
  const mainDir = path.dirname(argv[0] || 'main.py');
  const cwd = mainDir !== '.' && !path.isAbsolute(argv[0] || '') && base.toLowerCase().endsWith(mainDir.toLowerCase()) ? base.slice(0, base.length - mainDir.length - 1) : base;
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? path.resolve(cwd, argv[i + 1]) : null;
  };
  const value = {
    output: arg('--output-directory') || path.join(base, 'output'),
    input: arg('--input-directory') || path.join(base, 'input'),
    temp: arg('--temp-directory') || path.join(base, 'temp'),
  };
  dirsCache = { at: Date.now(), value };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DIRS_FILE(), JSON.stringify({ url: getSettings().comfyUrl, value }));
  } catch {}
  return value;
}

/** Caminho do arquivo neste computador, ou erro se o ComfyUI roda em outra máquina. */
export async function localPathOf({ filename, subfolder = '', type = 'output' }) {
  const dirs = await comfyDirs();
  const root = dirs[type];
  if (!root) throw new Error(`Tipo de arquivo desconhecido: ${type}`);
  const full = path.resolve(root, subfolder || '', filename);
  if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error('Caminho inválido.');
  if (!fs.existsSync(full)) {
    throw new Error(`O arquivo não está neste computador (${full}). Se o ComfyUI roda em outra máquina da rede, use Baixar.`);
  }
  return full;
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
  // Parado antes de enfileirar: não manda nada (antes o prompt ia e ficava rodando sozinho).
  if (signal?.aborted) throw new Error('Cancelado');
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
  // Parado enquanto o POST estava no ar: o evento já passou, então cancela aqui.
  if (signal?.aborted) onAbort();

  // O pedido sumiu (o ComfyUI caiu ou reiniciou no meio): sem isto o card ficava
  // "gerando" para sempre. Confere a fila de tempos em tempos quando não há histórico.
  let lastQueueCheck = Date.now();
  let missingSince = null;
  try {
    // Polling de /history como garantia (o WebSocket só acelera).
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelado');
      const history = await getJson(`/history/${promptId}`).catch(() => null);
      const entry = history?.[promptId];
      if (entry?.status?.completed || entry?.status?.status_str === 'error') return checkHistory(entry, prompt);
      if (!entry && Date.now() - lastQueueCheck > 5000) {
        lastQueueCheck = Date.now();
        const queue = history ? await getJson('/queue').catch(() => null) : null;
        const inQueue = queue && [...(queue.queue_running || []), ...(queue.queue_pending || [])].some((q) => q[1] === promptId);
        if (inQueue) missingSince = null;
        else {
          missingSince ??= Date.now();
          // ComfyUI fora do ar: espera até 2 min (pode estar reiniciando). No ar e sem o pedido: 15 s.
          if (Date.now() - missingSince > (queue ? 15000 : 120000)) {
            throw new Error(queue
              ? 'O ComfyUI reiniciou ou perdeu este pedido no meio da geração (veja se ele fechou sozinho). Gere de novo.'
              : 'O ComfyUI parou de responder no meio da geração (fechou ou travou). Abra o ComfyUI e gere de novo.');
          }
        }
      }
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
  model3d: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'usdz'],
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
