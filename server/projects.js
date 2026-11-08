// Projetos: conversa, histórico do modelo, assets (cards do canvas) e ligações.
// Cada projeto é um JSON em data/projects/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './settings.js';

const DIR = path.join(DATA_DIR, 'projects');
const cache = new Map();
export const projectEvents = new EventEmitter();
projectEvents.setMaxListeners(200);

export const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const file = (id) => {
  if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('Projeto inválido'), { status: 400 });
  return path.join(DIR, `${id}.json`);
};

export function listProjects() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = getProject(f.slice(0, -5));
        const cover = [...p.assets].reverse().find((a) => a.status === 'ready' && (a.kind === 'image' || a.kind === 'video'));
        return { id: p.id, title: p.title, updatedAt: p.updatedAt, assets: p.assets.length, cover: cover ? { kind: cover.kind, file: cover.file } : null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id) {
  if (cache.has(id)) return cache.get(id);
  const f = file(id);
  if (!fs.existsSync(f)) throw Object.assign(new Error('Projeto não encontrado'), { status: 404 });
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  // Gerações interrompidas por um reinício do servidor não vão terminar.
  for (const a of p.assets) if (a.status === 'generating') Object.assign(a, { status: 'error', error: 'Interrompido (o servidor reiniciou)' });
  // O mesmo para a conversa: respostas e passos que ficaram "rodando".
  for (const m of p.messages) {
    if (m.role !== 'assistant' || m.status !== 'running') continue;
    m.status = 'stopped';
    m.thinking = false;
    for (const part of m.parts || []) {
      if (part.type === 'step' && part.status === 'running') Object.assign(part, { status: 'error', error: 'Interrompido: o servidor reiniciou' });
    }
  }
  cache.set(id, p);
  return p;
}

export function createProject(title = 'Novo projeto') {
  const now = Date.now();
  const p = { id: shortId('prj'), title, createdAt: now, updatedAt: now, messages: [], llm: [], assets: [], edges: [] };
  cache.set(p.id, p);
  saveProject(p);
  return p;
}

export function saveProject(p) {
  p.updatedAt = Date.now();
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(p.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, file(p.id));
}

export function deleteProject(id) {
  cache.delete(id);
  const f = file(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/** Envia um evento para quem está olhando o projeto (SSE). */
export const emit = (projectId, event) => projectEvents.emit(projectId, event);

// ---- Assets e ligações -------------------------------------------------------
export const CARD = { w: 260, h: 340, gapX: 120, gapY: 40 };

function overlaps(p, x, y) {
  return p.assets.some((a) => Math.abs(a.position.x - x) < CARD.w && Math.abs(a.position.y - y) < CARD.h);
}

/** Posição para um card novo: à direita das entradas, ou numa coluna nova. */
export function placeAsset(p, inputIds = []) {
  const inputs = p.assets.filter((a) => inputIds.includes(a.id));
  let x;
  let y;
  if (inputs.length) {
    x = Math.max(...inputs.map((a) => a.position.x)) + CARD.w + CARD.gapX;
    y = Math.min(...inputs.map((a) => a.position.y));
  } else if (p.assets.length) {
    x = Math.max(...p.assets.map((a) => a.position.x)) + CARD.w + CARD.gapX;
    y = 0;
  } else {
    x = 0;
    y = 0;
  }
  while (overlaps(p, x, y)) y += CARD.h + CARD.gapY;
  return { x, y };
}

/** Posição logo abaixo de outro card (para variações do mesmo pedido). */
export function placeBelow(p, anchor) {
  const x = anchor.position.x;
  let y = anchor.position.y + CARD.h + CARD.gapY;
  while (overlaps(p, x, y)) y += CARD.h + CARD.gapY;
  return { x, y };
}

export function addAsset(p, asset, inputIds = []) {
  const a = {
    id: shortId('asset'),
    status: 'ready',
    createdAt: Date.now(),
    position: placeAsset(p, inputIds),
    ...asset,
  };
  p.assets.push(a);
  emit(p.id, { type: 'asset', asset: a });
  for (const source of inputIds) addEdge(p, source, a.id);
  return a;
}

export function updateAsset(p, id, patch, { persist = false } = {}) {
  const a = p.assets.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch);
  emit(p.id, { type: 'asset', asset: a });
  if (persist) saveProject(p);
  return a;
}

export function removeAsset(p, id) {
  p.assets = p.assets.filter((a) => a.id !== id);
  p.edges = p.edges.filter((e) => e.source !== id && e.target !== id);
  emit(p.id, { type: 'asset-removed', id });
}

export function addEdge(p, source, target) {
  if (source === target || !p.assets.some((a) => a.id === source)) return;
  if (p.edges.some((e) => e.source === source && e.target === target)) return;
  const e = { id: shortId('edge'), source, target };
  p.edges.push(e);
  emit(p.id, { type: 'edge', edge: e });
}

// ---- Versões --------------------------------------------------------------
// Refazer ou editar um card cria uma versão nova dele (v1, v2…). O card mostra a
// versão atual; as anteriores continuam disponíveis.
const VERSION_FIELDS = ['file', 'kind', 'recipe', 'seeds', 'prompt', 'workflow'];

function ensureVersions(a) {
  if (a.versions?.length || !a.file) return;
  a.versions = [{ id: 'v1', createdAt: a.createdAt || Date.now(), note: 'original', ...pick(a) }];
  a.current = 0;
}
function pick(a) {
  const out = {};
  for (const k of VERSION_FIELDS) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

export function addVersion(p, assetId, version) {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a) return null;
  ensureVersions(a);
  a.versions = a.versions || [];
  const v = { id: `v${a.versions.length + 1}`, createdAt: Date.now(), ...version };
  a.versions.push(v);
  a.current = a.versions.length - 1;
  Object.assign(a, pick(v), { status: 'ready', error: undefined, detail: '', progress: 1 });
  emit(p.id, { type: 'asset', asset: a });
  return a;
}

export function selectVersion(p, assetId, index) {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a?.versions?.[index]) throw new Error('Versão não encontrada');
  a.current = index;
  Object.assign(a, pick(a.versions[index]));
  emit(p.id, { type: 'asset', asset: a });
  return a;
}

/** Resumo curto de um asset para o modelo. */
export function describeAsset(a) {
  const out = { id: a.id, kind: a.kind, title: a.title, status: a.status };
  if (a.prompt) out.prompt = a.prompt.length > 300 ? `${a.prompt.slice(0, 300)}…` : a.prompt;
  if (a.kind === 'text' && a.text) out.preview = a.text.length > 200 ? `${a.text.slice(0, 200)}…` : a.text;
  if (a.workflow) out.made_with = a.workflow;
  if (a.recipe) {
    const r = { ...a.recipe };
    if (r.values) {
      r.values = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v]));
    }
    out.recipe = r;
  }
  if (a.seeds && Object.keys(a.seeds).length) out.seeds = a.seeds;
  if (a.versions?.length > 1) {
    out.version = `${(a.current ?? a.versions.length - 1) + 1} de ${a.versions.length}`;
    out.versions = a.versions.map((v, i) => `${i + 1}: ${v.note || ''}`.trim());
  }
  if (a.origin) out.origin = a.origin;
  if (a.error) out.error = a.error;
  return out;
}
