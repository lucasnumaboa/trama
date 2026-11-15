// Servidor do Trama: API (projetos, agente, ComfyUI, configurações) + frontend compilado.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import * as comfy from './comfy.js';
import { describeByName } from './exec.js';
import { listModels } from './llm.js';
import { publicSettings, updateSettings } from './settings.js';
import { listCapabilities, setDefaultModel, addModel, removeModel, modelInCategory } from './capabilities.js';
import * as projects from './projects.js';
import { exportModel, EXPORT_FORMATS } from './model3d.js';
import { sendMessage, stopAgent, isRunning } from './agent.js';
import { mountMcp, listTools as mcpTools } from './mcp.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5190);

const app = express();
app.use(express.json({ limit: '20mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((error) => {
    console.error(`[${req.method} ${req.path}]`, error.message);
    if (!res.headersSent) res.status(error.status && error.status < 600 ? error.status : 500).json({ error: error.message });
  });

// ---- Configurações ----
app.get('/api/settings', (req, res) => res.json(publicSettings()));
app.put('/api/settings', wrap((req, res) => res.json(updateSettings(req.body || {}))));
app.get('/api/deepseek/models', wrap(async (req, res) => res.json({ models: await listModels() })));
// Modelos de um provedor (?provider=openai). Sem provider: o ativo.
app.get('/api/llm/models', wrap(async (req, res) => res.json({ models: await listModels(req.query.provider ? String(req.query.provider) : undefined) })));

// ---- Capacidades (modelos padrão por categoria) ----
app.get('/api/capabilities', wrap(async (req, res) => {
  const names = await comfy.listWorkflows().then((list) => list.map((w) => w.name)).catch(() => null);
  // ?project=prj_x devolve os padrões já com as escolhas feitas no chat daquele projeto.
  const overrides = req.query.project ? projects.getProject(String(req.query.project)).models || {} : {};
  res.json({ categories: listCapabilities({ workflowNames: names, overrides }), workflows: names || [] });
}));
app.put('/api/capabilities/default', wrap((req, res) => {
  res.json(setDefaultModel(String(req.body?.category || ''), String(req.body?.id || '')));
}));
app.post('/api/capabilities/models', wrap((req, res) => {
  res.json(addModel({ category: req.body?.category, workflow: req.body?.workflow, label: req.body?.label }));
}));
app.delete('/api/capabilities/models/:id', wrap((req, res) => {
  res.json(removeModel(decodeURIComponent(req.params.id)));
}));

// ---- ComfyUI ----
// Título e miniatura de um link colado no chat (oEmbed público dos sites de vídeo).
const OEMBED = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'https://www.youtube.com/oembed?format=json&url='],
  [/(^|\.)vimeo\.com$/, 'https://vimeo.com/api/oembed.json?url='],
  [/(^|\.)tiktok\.com$/, 'https://www.tiktok.com/oembed?url='],
];
app.get('/api/link/preview', wrap(async (req, res) => {
  let u;
  try {
    u = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'link inválido' });
  }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'só http(s)' });
  const host = u.hostname.replace(/^www\./, '');
  const endpoint = OEMBED.find(([re]) => re.test(host))?.[1];
  if (!endpoint) return res.json({ site: host });
  try {
    const r = await fetch(endpoint + encodeURIComponent(u.toString()), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return res.json({ site: host });
    const j = await r.json();
    res.json({ site: host, title: j.title, author: j.author_name, thumbnail: j.thumbnail_url });
  } catch {
    res.json({ site: host });
  }
}));

app.get('/api/comfy/status', wrap(async (req, res) => {
  try {
    const stats = await comfy.systemStats();
    res.json({ ok: true, version: stats.system?.comfyui_version, devices: stats.devices?.map((d) => d.name) });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
}));
app.get('/api/comfy/workflows', wrap(async (req, res) => {
  const list = await comfy.listWorkflows();
  const out = [];
  for (const w of list) {
    try {
      const d = await describeByName(w.name, { refresh: req.query.refresh === '1' && out.length === 0 });
      out.push({
        name: d.name,
        title: d.title,
        notes: d.notes.join('\n\n'),
        inputs: d.mediaInputs.map((m) => ({ kind: m.kind, title: m.title })),
        outputs: [...new Set(d.outputs.map((o) => o.kind))],
      });
    } catch (error) {
      out.push({ name: w.name, title: w.name.replace(/\.json$/, ''), error: error.message, inputs: [], outputs: [] });
    }
  }
  res.json({ workflows: out });
}));
app.get('/api/comfy/view', wrap(async (req, res) => {
  const upstream = await comfy.fetchFile({
    filename: String(req.query.filename || ''),
    subfolder: String(req.query.subfolder || ''),
    type: String(req.query.type || 'output'),
  });
  for (const h of ['content-type', 'content-length', 'content-disposition']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // ?download=1: baixa como arquivo (no app de desktop, abre "Salvar como").
  if (req.query.download) {
    const name = path.basename(String(req.query.filename || 'arquivo'));
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^ -~]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  // pipeline trata erro no meio do stream (ComfyUI caiu, navegador fechou a conexão)
  // em vez de deixar virar uma exceção não tratada que derruba o servidor.
  pipeline(Readable.fromWeb(upstream.body), res, (error) => {
    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('[GET /api/comfy/view]', error.message);
  });
}));

// Exporta um modelo 3D (GLB do ComfyUI) em GLB, STL ou OBJ. ?height=mm escala o STL/OBJ
// para impressão (Z para cima, no chão); sem height o OBJ fica nas unidades do GLB.
app.get('/api/model3d/export', wrap(async (req, res) => {
  const format = String(req.query.format || 'glb').toLowerCase();
  const fmt = EXPORT_FORMATS[format];
  if (!fmt) return res.status(400).json({ error: 'Formato desconhecido: use glb, stl, obj ou fbx.' });
  const file = { filename: String(req.query.filename || ''), subfolder: String(req.query.subfolder || ''), type: String(req.query.type || 'output') };
  if (!/\.glb$/i.test(file.filename)) return res.status(400).json({ error: 'Só dá para exportar modelos GLB.' });
  const upstream = await comfy.fetchFile(fmt.sibling ? { ...file, filename: file.filename.replace(/.glb$/i, `.${fmt.ext}`) } : file).catch((error) => {
    if (fmt.sibling) throw Object.assign(new Error('Este modelo não tem esqueleto. O FBX sai do workflow de esqueleto (Modelo 3D com esqueleto).'), { status: 404 });
    throw error;
  });
  const height = Number(req.query.height);
  const data = fmt.sibling ? Buffer.from(await upstream.arrayBuffer()) : exportModel(Buffer.from(await upstream.arrayBuffer()), format, { heightMm: Number.isFinite(height) && height > 0 ? Math.min(height, 5000) : undefined });
  const base = (req.query.name ? String(req.query.name) : path.basename(file.filename, '.glb')).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'modelo';
  const name = `${base}.${fmt.ext}`;
  res.setHeader('Content-Type', fmt.type);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^ -~]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(data);
}));

// Abre a pasta do arquivo no Explorer com ele selecionado (só se o ComfyUI roda neste PC).
app.post('/api/comfy/reveal', wrap(async (req, res) => {
  const full = await comfy.localPathOf({
    filename: String(req.body?.filename || ''),
    subfolder: String(req.body?.subfolder || ''),
    type: String(req.body?.type || 'output'),
  });
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,"${full}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'darwin' ? ['-R', full] : [path.dirname(full)], { detached: true, stdio: 'ignore' }).unref();
  }
  res.json({ ok: true, path: full });
}));

// ---- Projetos ----
app.get('/api/projects', (req, res) => res.json({ projects: projects.listProjects(), folders: projects.listFolders() }));
app.post('/api/folders', wrap((req, res) => res.json(projects.createFolder(req.body?.name))));
app.patch('/api/folders/:id', wrap((req, res) => res.json(projects.renameFolder(req.params.id, req.body?.name))));
app.delete('/api/folders/:id', wrap((req, res) => {
  projects.deleteFolder(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/projects', wrap((req, res) => res.json(projects.createProject(req.body?.title || 'Novo projeto'))));
app.get('/api/projects/:id', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  const { llm, ...rest } = p;
  void llm;
  res.json({ ...rest, running: isRunning(p.id) });
}));
app.patch('/api/projects/:id', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  if (typeof req.body?.title === 'string' && req.body.title.trim()) p.title = req.body.title.trim().slice(0, 80);
  // Modelo escolhido no chat para uma categoria, só neste projeto.
  if (req.body?.model && typeof req.body.model === 'object') {
    const { category, id } = req.body.model;
    if (!modelInCategory(String(category), String(id))) return res.status(400).json({ error: 'Modelo inválido para essa categoria' });
    p.models = { ...(p.models || {}), [category]: id };
  }
  // Organização na barra lateral: não muda a data do projeto.
  const touch = 'title' in (req.body || {}) || 'model' in (req.body || {});
  if ('folder' in (req.body || {})) {
    const folder = req.body.folder;
    if (folder && !projects.listFolders().some((f) => f.id === folder)) return res.status(400).json({ error: 'Pasta não encontrada' });
    if (folder) p.folder = folder;
    else delete p.folder;
  }
  if ('archived' in (req.body || {})) {
    if (req.body.archived) p.archived = true;
    else delete p.archived;
  }
  projects.saveProject(p, { touch });
  projects.emit(p.id, { type: 'project', title: p.title });
  res.json({ ok: true });
}));
app.delete('/api/projects/:id', wrap((req, res) => {
  stopAgent(req.params.id);
  projects.deleteProject(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/messages', wrap(async (req, res) => {
  const { text, attachments, model, provider } = req.body || {};
  res.json(await sendMessage(req.params.id, { text, attachments, model, provider }));
}));
app.post('/api/projects/:id/stop', (req, res) => res.json({ stopped: stopAgent(req.params.id) }));

app.post('/api/projects/:id/upload', express.raw({ type: () => true, limit: '4gb' }), wrap(async (req, res) => {
  const p = projects.getProject(req.params.id);
  const original = decodeURIComponent(String(req.headers['x-filename'] || 'arquivo'));
  const safe = original.replace(/[^\w.\-]+/g, '_').slice(-120) || 'arquivo';
  const name = await comfy.uploadInput(req.body, safe, { overwrite: false });
  const kind = comfy.mediaKind(name);
  const position = req.headers['x-position'] ? JSON.parse(String(req.headers['x-position'])) : undefined;
  const asset = projects.addAsset(p, {
    kind,
    title: original,
    file: { filename: name, subfolder: '', type: 'input' },
    origin: 'upload',
    ...(position ? { position } : {}),
  });
  projects.saveProject(p);
  res.json(asset);
}));
app.patch('/api/projects/:id/assets/:assetId', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  const patch = {};
  if (req.body?.position && Number.isFinite(req.body.position.x)) patch.position = { x: req.body.position.x, y: req.body.position.y };
  if (typeof req.body?.title === 'string') patch.title = req.body.title.slice(0, 120);
  if (typeof req.body?.text === 'string') patch.text = req.body.text;
  if (Number.isInteger(req.body?.current)) {
    projects.selectVersion(p, req.params.assetId, req.body.current);
  }
  const a = projects.updateAsset(p, req.params.assetId, patch, { persist: true });
  if (!a) return res.status(404).json({ error: 'Asset não encontrado' });
  res.json(a);
}));
app.post('/api/projects/:id/assets/restore', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  const restored = projects.restoreAssets(p, req.body?.assets, req.body?.edges);
  projects.saveProject(p);
  res.json({ restored });
}));
app.delete('/api/projects/:id/assets/:assetId', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  projects.removeAsset(p, req.params.assetId);
  projects.saveProject(p);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/events', wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  projects.projectEvents.on(p.id, send);
  req.on('close', () => {
    clearInterval(ping);
    projects.projectEvents.off(p.id, send);
  });
}));

// ---- MCP: agentes de fora usam o Trama como estúdio ----
mountMcp(app, PORT);
app.get('/api/mcp', (req, res) => {
  const url = `http://127.0.0.1:${PORT}/mcp`;
  res.json({
    url,
    port: PORT,
    tools: mcpTools().map((t) => t.name),
    claudeCode: `claude mcp add --transport http --scope user trama ${url}`,
    codex: `[mcp_servers.trama]
url = "${url}"
tool_timeout_sec = 600`,
    json: JSON.stringify({ mcpServers: { trama: { type: 'http', url } } }, null, 2),
  });
});

// ---- Frontend compilado (npm start) ----
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// O app de desktop (electron/main.mjs) espera o servidor subir antes de abrir a janela.
export const ready = new Promise((resolve, reject) => {
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Trama rodando em http://127.0.0.1:${PORT}`);
    resolve(PORT);
  });
  server.on('error', reject);
});
