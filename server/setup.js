// "Preparar ComfyUI": confere o que cada workflow do Trama precisa no ComfyUI do
// usuário (workflow salvo, nós, pacotes pip, modelos) e instala o que falta.
// A mesma detecção diz ao agente quais workflows rodam (workflowAvailability), para ele
// não oferecer o que não existe ali.
//
// Regras: só mexe em workflows que começam com "trama_"; nunca reinicia nem fecha o
// ComfyUI (avisa que precisa reiniciar); trava torch/onnxruntime no pip; confere o
// espaço em disco antes de baixar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as comfy from './comfy.js';
import { builtinWorkflows, CATEGORIES } from './capabilities.js';
import {
  NODE_PACKS, MODELS, WORKFLOWS, WORKFLOW_PREFIX, TESTED_COMFYUI, PROTECTED_PACKAGES,
  modelSize, pipOf, pipName, pipVersion, packOfClass,
} from './setup-manifest.js';
import { PATCHES, applyEdits, isPatched } from './setup-patches.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLED_WORKFLOWS_DIR = path.join(ROOT, 'comfy-workflows');
export const BUNDLED_NODES_DIR = path.join(ROOT, 'comfy-nodes');

// Tipos que só existem na interface do ComfyUI (não vão para o servidor).
const FRONTEND_ONLY = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'GroupNode']);
const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;
// Pastas que o ComfyUI trata como a mesma coisa.
const DIR_ALIASES = { diffusion_models: ['unet'], unet: ['diffusion_models'], text_encoders: ['clip'], clip: ['text_encoders'] };

// ---- Leitura do workflow (puro) ---------------------------------------------

/**
 * Nós e arquivos de modelo que um workflow (formato de tela) usa de verdade: pula nós
 * mudos/bypass e entra nos subgrafos só quando uma instância ativa os usa.
 * linked: classes com alguma instância ligada (nós só de interface, como os de grupo do
 * rgthree, ficam soltos e não vão para o servidor).
 * @returns {{ classes: Set<string>, linked: Set<string>, models: Array<{ classType: string, value: string }> }}
 */
export function scanWorkflow(workflow) {
  const subgraphs = new Map((workflow?.definitions?.subgraphs || []).map((s) => [s.id, s]));
  const classes = new Set();
  const linked = new Set(); // classes com ao menos uma instância ligada a outro nó
  const models = [];
  const visited = new Set();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.mode === 2 || n.mode === 4) continue;
      const type = String(n.type || '');
      if (subgraphs.has(type)) {
        if (!visited.has(type)) {
          visited.add(type);
          walk(subgraphs.get(type).nodes);
        }
        continue;
      }
      if (!type || FRONTEND_ONLY.has(type) || type.startsWith('workflow>') || type.startsWith('workflow/')) continue;
      classes.add(type);
      if ((n.inputs || []).some((i) => i.link != null) || (n.outputs || []).some((o) => o.links?.length)) linked.add(type);
      const values = Array.isArray(n.widgets_values) ? n.widgets_values : Object.values(n.widgets_values || {});
      for (const v of values) if (typeof v === 'string' && MODEL_FILE.test(v)) models.push({ classType: type, value: v });
    }
  };
  walk(workflow?.nodes);
  return { classes, linked, models };
}

/** O valor aparece em alguma lista (combo) das entradas do nó? */
export function comboHas(def, value) {
  for (const group of [def?.input?.required, def?.input?.optional]) {
    for (const spec of Object.values(group || {})) {
      if (!Array.isArray(spec)) continue;
      if (Array.isArray(spec[0]) && spec[0].includes(value)) return true;
      if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options) && spec[1].options.includes(value)) return true;
    }
  }
  return false;
}

const fmtGB = (bytes) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1).replace('.', ',')} GB`;

/**
 * Situação de um workflow. Puro: recebe tudo o que foi lido do ComfyUI e do disco.
 * @param {string} name
 * @param {object} env
 *   workflow: JSON salvo no ComfyUI (null = não está lá); bundled: JSON que vem com o Trama
 *   objectInfo: /object_info; files(modelId) -> true|false|null (null = não dá para conferir)
 *   packDir(packId) -> true|false|null; packPatched(packId) -> true|false|null (ajustes de setup-patches.js); tramaNode: 'ok'|'outdated'|null; pip: Map(nome -> versão)|null; cuda: '12'|...|null
 */
export function evaluateWorkflow(name, env) {
  const spec = WORKFLOWS[name] || null;
  const source = env.workflow || env.bundled || null;
  const { classes, linked, models: refs } = source ? scanWorkflow(source) : { classes: new Set(), linked: new Set(), models: [] };
  const info = env.objectInfo || {};
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const inComfy = !env.workflow ? 'missing' : env.bundled && !sameJson(env.workflow, env.bundled) ? 'different' : 'ok';

  // Nós: os do manifesto mais os que o workflow cita.
  const packIds = new Set(spec?.packs || []);
  const coreMissing = [];
  const unknownNodes = [];
  for (const c of classes) {
    const pack = packOfClass(c);
    if (pack) packIds.add(pack);
    else if (!info[c] && spec) coreMissing.push(c);
    else if (!info[c] && linked.has(c)) unknownNodes.push(c);
  }
  const packs = [...packIds].map((id) => {
    // Os nós do pacote que o workflow usa precisam existir; pacote usado por baixo (ex.: o
    // Blender do UniRig nas animações) basta ter carregado algum nó.
    const used = NODE_PACKS[id].classes.filter((c) => classes.has(c));
    const loaded = used.length ? used.every((c) => info[c]) : NODE_PACKS[id].classes.some((c) => info[c]);
    let status = loaded ? 'ok' : env.packDir?.(id) ? 'not_loaded' : 'missing';
    if (status === 'ok' && id === 'ComfyUI-Trama' && env.tramaNode === 'outdated') status = 'outdated';
    if ((status === 'ok' || status === 'not_loaded') && env.packPatched?.(id) === false) status = 'unpatched';
    return { id, status };
  });

  // Modelos: a lista (combo) do nó responde mesmo com o ComfyUI em outra máquina;
  // o arquivo no disco cobre os que nenhum nó lista (pastas do Seed-VC, HY-Motion…).
  const models = [];
  const comboSays = (fileNames) => {
    let answer = null;
    for (const r of refs) {
      if (!fileNames.includes(r.value) || !info[r.classType]) continue;
      if (comboHas(info[r.classType], r.value)) return true;
      answer = false;
    }
    return answer;
  };
  for (const id of spec?.models || []) {
    const m = MODELS[id];
    if (m.auto) {
      models.push({ id, status: env.files?.(id) ? 'ok' : 'auto' });
      continue;
    }
    const combo = comboSays(m.files.map((f) => f.name));
    const local = env.files?.(id) ?? null;
    const present = combo === true || local === true;
    const status = present ? 'ok' : combo === null && local === null ? 'unknown' : m.source || m.files.every((f) => f.url) ? 'missing' : 'manual';
    models.push({ id, status });
  }
  // Workflow fora do manifesto (do usuário): só a lista do nó responde.
  if (!spec) {
    for (const r of refs) {
      if (info[r.classType] && !comboHas(info[r.classType], r.value) && !models.some((m) => m.id === r.value)) models.push({ id: r.value, status: 'manual' });
    }
  }

  // Pacotes pip dos nós (só quando dá para perguntar ao Python do ComfyUI).
  const pip = env.pip
    ? pipOf([...packIds]).map((p) => {
      const name = pipName(p.spec);
      const installed = [name, ...(p.alt || []).map(pipName)].map((n) => env.pip.get(n)).find(Boolean) || null;
      const want = pipVersion(p.spec);
      let status = installed ? 'ok' : 'missing';
      if (installed && p.exact && want && installed.split('.').slice(0, 2).join('.') !== want.split('.').slice(0, 2).join('.')) status = 'wrong';
      if (status !== 'ok' && p.cuda && env.cuda && p.cuda !== env.cuda) status = 'cuda';
      return { spec: p.spec, name, installed, status };
    })
    : null;

  const missingModels = models.filter((m) => m.status === 'missing').map((m) => m.id);
  const ready = inComfy !== 'missing'
    && packs.every((p) => p.status === 'ok' || p.status === 'outdated')
    && !coreMissing.length && !unknownNodes.length
    && !models.some((m) => m.status === 'missing' || m.status === 'manual')
    && !(pip || []).some((p) => p.status === 'missing' || p.status === 'wrong');
  return {
    name, ready, inComfy, packs, coreMissing, unknownNodes, models, pip,
    missingModels, missingBytes: missingModels.reduce((s, id) => s + modelSize(id), 0),
  };
}

/** Frase curta do que falta (para o agente e para a lista). */
export function missingSummary(s) {
  const parts = [];
  if (s.inComfy === 'missing') parts.push('o workflow não está salvo no ComfyUI');
  const packs = s.packs.filter((p) => p.status === 'missing').map((p) => p.id);
  if (packs.length) parts.push(`falta o nó ${packs.join(', ')}`);
  const unpatched = s.packs.filter((p) => p.status === 'unpatched').map((p) => p.id);
  if (unpatched.length) parts.push(`${unpatched.join(', ')} sem os ajustes do Trama para este ComfyUI`);
  const restart = s.packs.filter((p) => p.status === 'not_loaded').map((p) => p.id);
  if (restart.length) parts.push(`${restart.join(', ')} instalado mas não carregou (reinicie o ComfyUI)`);
  if (s.coreMissing.length) parts.push(`o ComfyUI é antigo para ele (faltam nós do ComfyUI: ${s.coreMissing.slice(0, 3).join(', ')}; atualize para ${TESTED_COMFYUI} ou mais novo)`);
  if (s.unknownNodes.length) parts.push(`faltam nós: ${s.unknownNodes.slice(0, 3).join(', ')}`);
  const models = s.models.filter((m) => m.status === 'missing' || m.status === 'manual').map((m) => m.id);
  if (models.length) parts.push(`falta${models.length > 1 ? 'm' : ''} ${models.length > 1 ? `${models.length} modelos` : 'o modelo'} ${models.slice(0, 3).join(', ')}${models.length > 3 ? '…' : ''}${s.missingBytes ? ` (${fmtGB(s.missingBytes)})` : ''}`);
  const pip = (s.pip || []).filter((p) => p.status === 'missing' || p.status === 'wrong').map((p) => (p.status === 'wrong' ? `${p.name} ${p.installed} (precisa ${pipVersion(p.spec)})` : p.name));
  if (pip.length) parts.push(`faltam pacotes do Python: ${pip.join(', ')}`);
  return parts.join('; ');
}

// ---- Ambiente: ComfyUI, pastas, Python, disco ---------------------------------

let lastEnv = null; // o último ambiente lido com o ComfyUI no ar (a instalação funciona com ele fechado)

function cudaOf(pytorchVersion = '') {
  const m = String(pytorchVersion).match(/\+cu(\d{2})/);
  return m ? m[1] : null;
}

function freeBytes(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d)) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function run(cmd, args, { cwd, signal, onLine, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let buf = '';
    const feed = (d, isErr) => {
      const s = d.toString();
      if (isErr) err += s;
      else out += s;
      if (!onLine) return;
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      lines.filter((l) => l.trim()).forEach(onLine);
    };
    const kill = () => child.kill();
    const timer = timeout ? setTimeout(kill, timeout) : null;
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => feed(d, false));
    child.stderr.on('data', (d) => feed(d, true));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (buf.trim() && onLine) onLine(buf);
      if (signal?.aborted) return reject(new Error('Cancelado'));
      resolve({ code, out, err });
    });
  });
}

const hasGit = async () => run('git', ['--version'], { timeout: 10000 }).then((r) => r.code === 0).catch(() => false);

/** Python do ComfyUI: o python_embeded do portátil ou o venv. Confere a versão com a do /system_stats. */
async function findPython(base, pythonVersion) {
  const win = process.platform === 'win32';
  const candidates = win
    ? [path.join(base, '..', 'python_embeded', 'python.exe'), path.join(base, 'venv', 'Scripts', 'python.exe'), path.join(base, '.venv', 'Scripts', 'python.exe')]
    : [path.join(base, 'venv', 'bin', 'python'), path.join(base, '.venv', 'bin', 'python')];
  const want = String(pythonVersion || '').split(' ')[0];
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue;
    const r = await run(exe, ['-I', '-c', 'import sys; print(sys.version.split()[0])'], { timeout: 20000 }).catch(() => null);
    if (r?.code === 0 && (!want || r.out.trim() === want)) return path.resolve(exe);
  }
  return null;
}

/** Lê o ComfyUI: versão, pastas, Python, espaço livre. Sem o ComfyUI no ar, devolve o último lido. */
export async function comfyEnv() {
  const [stats, paths] = await Promise.all([comfy.systemStats().catch(() => null), comfy.folderPaths().catch(() => null)]);
  if (!stats || !paths?.custom_nodes?.[0]) {
    return lastEnv ? { ...lastEnv, online: false } : { online: false, local: false };
  }
  const customNodes = paths.custom_nodes[0];
  const base = path.dirname(customNodes);
  const local = fs.existsSync(customNodes);
  const python = local ? (lastEnv?.base === base && lastEnv.python) || await findPython(base, stats.system?.python_version) : null;
  const modelsDir = path.join(base, 'models');
  lastEnv = {
    online: true,
    version: stats.system?.comfyui_version || null,
    tested: TESTED_COMFYUI,
    pytorch: stats.system?.pytorch_version || null,
    cuda: cudaOf(stats.system?.pytorch_version),
    gpu: (stats.devices || []).map((d) => d.name.replace(/^cuda:\d+\s*/, '').replace(/ : .*$/, '')),
    base,
    customNodes,
    modelsDir,
    folderPaths: paths,
    local,
    python,
    pythonVersion: String(stats.system?.python_version || '').split(' ')[0] || null,
  };
  return lastEnv;
}

/**
 * Pastas onde um modelo pode estar; a primeira é onde ele vai: a do folder_paths do ComfyUI
 * (prefere ComfyUI/models/<dir>), ou dentro de custom_nodes para o nó que lê da própria pasta.
 */
function modelDirs(env, id) {
  const { dir, root } = MODELS[id];
  if (root === 'custom_nodes') return [path.join(env.customNodes, ...dir.split('/'))];
  const [head, ...rest] = dir.split('/');
  const names = [head, ...(DIR_ALIASES[head] || [])];
  const fromComfy = names.flatMap((n) => env.folderPaths?.[n] || []);
  const canonical = path.join(env.modelsDir, head);
  const roots = [...new Set([canonical, ...fromComfy, ...names.map((n) => path.join(env.modelsDir, n))])];
  return roots.map((r) => path.join(r, ...rest));
}
const modelTarget = (env, id) => modelDirs(env, id)[0];
const modelPlace = (id) => `ComfyUI/${MODELS[id].root === 'custom_nodes' ? 'custom_nodes' : 'models'}/${MODELS[id].dir}`;

/** Todos os arquivos do modelo estão no disco (em qualquer pasta que o ComfyUI lê)? */
function modelOnDisk(env, id) {
  if (!env.local) return null;
  const dirs = modelDirs(env, id);
  return MODELS[id].files.every((f) => dirs.some((d) => fs.existsSync(path.join(d, f.name))));
}

/** Os ajustes de setup-patches.js estão no nó instalado? null = não dá para conferir ou não há ajuste. */
function packPatched(env, id) {
  const dir = PATCHES[id] && packDirOf(env, id);
  if (!dir) return null;
  try {
    return PATCHES[id].every((p) => isPatched(fs.readFileSync(path.join(env.customNodes, dir, p.file), 'utf8'), p.edits));
  } catch {
    return false;
  }
}

/** Aplica os ajustes num nó. Devolve o que fez; erro se o trecho original não estiver lá. */
function patchPack(env, id) {
  const dir = packDirOf(env, id) || id;
  const done = [];
  for (const p of PATCHES[id] || []) {
    const file = path.join(env.customNodes, dir, p.file);
    const r = applyEdits(fs.readFileSync(file, 'utf8'), p.edits);
    if (r.state === 'mismatch') throw new Error(`${p.file}: ${r.problem}. O arquivo não é o do commit ${NODE_PACKS[id].ref.slice(0, 7)}; não mexi.`);
    if (r.state === 'applied') {
      fs.writeFileSync(file, r.text);
      done.push(p.file);
    }
  }
  return done;
}

function packDirOf(env, id) {
  if (!env.local) return null;
  const want = [id.toLowerCase(), (NODE_PACKS[id].repo || '').split('/').pop()?.toLowerCase()].filter(Boolean);
  try {
    return fs.readdirSync(env.customNodes).find((d) => want.includes(d.toLowerCase()) && fs.statSync(path.join(env.customNodes, d)).isDirectory()) || null;
  } catch {
    return null;
  }
}

/** Arquivos de uma pasta (relativos), sem __pycache__ e testes. */
function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name === 'tests' || e.name.startsWith('.')) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/** ComfyUI-Trama instalado é igual ao que vem com o Trama? */
function tramaNodeState(env) {
  if (!env.local) return null;
  const dir = packDirOf(env, 'ComfyUI-Trama');
  if (!dir) return 'missing';
  const src = path.join(BUNDLED_NODES_DIR, 'ComfyUI-Trama');
  try {
    for (const f of listFiles(src)) {
      const dest = path.join(env.customNodes, dir, f);
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(fs.readFileSync(path.join(src, f)))) return 'outdated';
    }
    return 'ok';
  } catch {
    return 'outdated';
  }
}

async function pipVersions(env, { signal } = {}) {
  if (!env.python) return null;
  const names = [...new Set(Object.values(NODE_PACKS).flatMap((p) => (p.pip || []).flatMap((x) => [pipName(x.spec), ...(x.alt || []).map(pipName)])))];
  const code = 'import sys, json, importlib.metadata as m\nout = {}\nfor n in sys.argv[1:]:\n    try:\n        out[n] = m.version(n)\n    except Exception:\n        pass\nprint(json.dumps(out))';
  const r = await run(env.python, ['-I', '-c', code, ...names, ...PROTECTED_PACKAGES], { signal, timeout: 60000 }).catch(() => null);
  if (r?.code !== 0) return null;
  try {
    const found = JSON.parse(r.out.trim().split('\n').pop());
    return new Map(Object.entries(found).map(([k, v]) => [pipName(k), v]));
  } catch {
    return null;
  }
}

export function bundledWorkflowNames() {
  try {
    return fs.readdirSync(BUNDLED_WORKFLOWS_DIR).filter((f) => f.startsWith(WORKFLOW_PREFIX) && f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}
const readBundled = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(BUNDLED_WORKFLOWS_DIR, name), 'utf8'));
  } catch {
    return null;
  }
};

// JSON dos workflows salvos no ComfyUI, guardado pela data de modificação.
const savedCache = new Map();
async function savedWorkflows() {
  const list = await comfy.listWorkflows();
  const out = new Map();
  await Promise.all(list.map(async (w) => {
    const key = `${w.modified}:${w.size}`;
    const hit = savedCache.get(w.name);
    if (hit && hit.key === key) return out.set(w.name, hit.json);
    const json = await comfy.loadWorkflow(w.name).catch(() => null);
    savedCache.set(w.name, { key, json });
    out.set(w.name, json);
  }));
  return out;
}

// ---- O que o Settings mostra ------------------------------------------------------

function labelsByWorkflow() {
  const map = new Map();
  for (const b of builtinWorkflows()) if (!map.has(b.workflow)) map.set(b.workflow, b);
  return map;
}

/** Tudo de uma vez: ambiente, cada workflow por categoria, nós, modelos e o que falta. */
export async function setupStatus({ signal } = {}) {
  const env = await comfyEnv();
  if (!env.online) {
    return { comfy: { online: false, url: null, error: 'O ComfyUI não respondeu. Abra o ComfyUI e confira o endereço acima.' }, categories: [] };
  }
  const [objectInfo, saved, pip, git] = await Promise.all([
    comfy.objectInfo({ refresh: true }),
    savedWorkflows(),
    pipVersions(env, { signal }),
    hasGit(),
  ]);
  const tramaNode = tramaNodeState(env);
  const labels = labelsByWorkflow();
  const statuses = bundledWorkflowNames().map((name) => {
    const s = evaluateWorkflow(name, {
      workflow: saved.get(name) || null,
      bundled: readBundled(name),
      objectInfo,
      files: (id) => modelOnDisk(env, id),
      packDir: (id) => (env.local ? Boolean(packDirOf(env, id)) : null),
      packPatched: (id) => (env.local ? packPatched(env, id) : null),
      tramaNode,
      pip,
      cuda: env.cuda,
    });
    const b = labels.get(name);
    const spec = WORKFLOWS[name] || {};
    return { ...s, label: spec.label || b?.label || name, category: spec.category || b?.category || 'internal', summary: missingSummary(s) };
  });
  const categories = [...CATEGORIES.map((c) => ({ id: c.id, label: c.label })), { id: 'internal', label: 'Uso interno do Trama' }]
    .map((c) => ({ ...c, workflows: statuses.filter((s) => s.category === c.id) }))
    .filter((c) => c.workflows.length);

  const usedModels = [...new Set(statuses.flatMap((s) => s.models.map((m) => m.id)))].filter((id) => MODELS[id]);
  const usedPacks = [...new Set(statuses.flatMap((s) => s.packs.map((p) => p.id)))];
  return {
    comfy: {
      online: true,
      version: env.version,
      tested: env.tested,
      gpu: env.gpu,
      pytorch: env.pytorch,
      cuda: env.cuda,
      local: env.local,
      base: env.local ? env.base : null,
      python: env.python,
      git,
      freeBytes: env.local ? freeBytes(env.modelsDir) : null,
      drive: env.local ? path.parse(env.base).root : null,
    },
    base: {
      tramaNode: tramaNode || 'unknown',
      different: statuses.filter((s) => s.inComfy === 'different').map((s) => s.name),
    },
    categories,
    packs: Object.fromEntries(usedPacks.map((id) => [id, { label: NODE_PACKS[id].label, note: NODE_PACKS[id].note || null, bundled: Boolean(NODE_PACKS[id].bundled) }])),
    models: Object.fromEntries(usedModels.map((id) => [id, { size: modelSize(id), dir: MODELS[id].dir, auto: Boolean(MODELS[id].auto), manual: MODELS[id].files.some((f) => !f.url) }])),
  };
}

// ---- Para o agente ---------------------------------------------------------------

let availabilityCache = { at: 0, value: null };
/**
 * Map(nome do workflow -> { ok, reason }) de tudo o que está salvo no ComfyUI e dos
 * workflows do Trama que não estão lá. Não pergunta ao pip (lento); nó que não carregou
 * por falta de pacote já aparece como nó faltando.
 */
export async function workflowAvailability({ refresh = false } = {}) {
  if (!refresh && availabilityCache.value && Date.now() - availabilityCache.at < 60000) return availabilityCache.value;
  const [objectInfo, saved, env] = await Promise.all([comfy.objectInfo({ refresh }), savedWorkflows(), comfyEnv()]);
  const names = new Set([...saved.keys(), ...Object.keys(WORKFLOWS)]);
  const map = new Map();
  for (const name of names) {
    const s = evaluateWorkflow(name, {
      workflow: saved.get(name) || null,
      // Só para ler os nós e modelos quando o workflow nem está no ComfyUI.
      bundled: saved.get(name) ? null : readBundled(name),
      objectInfo,
      files: (id) => (env.online ? modelOnDisk(env, id) : null),
      packDir: (id) => (env.online && env.local ? Boolean(packDirOf(env, id)) : null),
      packPatched: (id) => (env.online && env.local ? packPatched(env, id) : null),
      tramaNode: null,
      pip: null,
      cuda: null,
    });
    map.set(name, { ok: s.ready, reason: s.ready ? '' : missingSummary(s) });
  }
  availabilityCache = { at: Date.now(), value: map };
  return map;
}
export const resetAvailability = () => (availabilityCache = { at: 0, value: null });

// ---- Instalação ------------------------------------------------------------------

let job = null;
export const currentJob = () => job && { ...job, controller: undefined, log: job.log.slice(-200) };

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Copia uma pasta (lendo e gravando cada arquivo: funciona de dentro do app.asar). */
function copyDir(src, dest) {
  for (const rel of listFiles(src)) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(path.join(src, rel)));
  }
}

export async function download(url, dest, { size, signal, onProgress } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (size && start > size) {
    fs.rmSync(part, { force: true });
    start = 0;
  }
  const res = await fetch(url, { signal, redirect: 'follow', headers: start ? { Range: `bytes=${start}-` } : {} });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  if (start && res.status !== 206) start = 0; // o servidor ignorou o Range: recomeça
  const total = size || (Number(res.headers.get('content-length')) || 0) + start;
  const out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
  let done = start;
  let last = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      done += chunk.length;
      if (Date.now() - last > 500) {
        last = Date.now();
        onProgress?.(done, total);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (size && fs.statSync(part).size !== size) throw new Error(`Download incompleto de ${path.basename(dest)} (${fs.statSync(part).size} de ${size} bytes). Tente de novo: ele continua de onde parou.`);
  fs.renameSync(part, dest);
  onProgress?.(done, total);
}

/** Clona o nó no commit travado (git; sem git, baixa o zip do GitHub e extrai com tar). */
async function clonePack(id, env, { signal, log }) {
  const p = NODE_PACKS[id];
  const dest = path.join(env.customNodes, id);
  if (await hasGit()) {
    const r = await run('git', ['clone', '--quiet', p.repo, dest], { signal, onLine: log });
    if (r.code !== 0) throw new Error(`git clone ${p.repo} falhou: ${r.err.trim().slice(-300)}`);
    const c = await run('git', ['-c', 'advice.detachedHead=false', '-C', dest, 'checkout', '--quiet', p.ref], { signal, onLine: log });
    if (c.code !== 0) throw new Error(`git checkout ${p.ref} falhou: ${c.err.trim().slice(-300)}`);
    return dest;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-node-'));
  try {
    const zip = path.join(tmp, 'src.zip');
    await download(`${p.repo}/archive/${p.ref}.zip`, zip, { signal });
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const x = await run(tar, ['-xf', zip, '-C', tmp], { signal });
    if (x.code !== 0) throw new Error(`Não consegui extrair o zip de ${id}: ${x.err.trim().slice(-300)}`);
    const inner = fs.readdirSync(tmp).find((d) => d !== 'src.zip' && fs.statSync(path.join(tmp, d)).isDirectory());
    if (!inner) throw new Error(`O zip de ${id} veio vazio.`);
    fs.cpSync(path.join(tmp, inner), dest, { recursive: true });
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Monta o plano a partir da situação atual. Puro (testável).
 * @param {object} status   resultado de setupStatus()
 * @param {{ workflows: string[], updateBase?: boolean }} choice
 */
export function planInstall(status, { workflows = [], updateBase = false } = {}) {
  const all = status.categories.flatMap((c) => c.workflows);
  const chosen = all.filter((s) => workflows.includes(s.name) && s.name.startsWith(WORKFLOW_PREFIX));
  const writeWorkflows = new Set(chosen.filter((s) => s.inComfy === 'missing').map((s) => s.name));
  if (updateBase) for (const s of all) if (s.inComfy === 'different') writeWorkflows.add(s.name);

  const packs = new Map(); // id -> 'copy' | 'clone' | 'patch' | 'restart'
  for (const s of chosen) {
    for (const p of s.packs) {
      if (p.status === 'missing') packs.set(p.id, NODE_PACKS[p.id].bundled ? 'copy' : 'clone');
      else if (p.status === 'outdated') packs.set(p.id, 'copy');
      else if (p.status === 'unpatched') packs.set(p.id, 'patch');
      else if (p.status === 'not_loaded' && !packs.has(p.id)) packs.set(p.id, 'restart');
    }
  }
  if (updateBase && (status.base?.tramaNode === 'outdated' || status.base?.tramaNode === 'missing')) packs.set('ComfyUI-Trama', 'copy');

  const pip = new Map();
  for (const s of chosen) {
    for (const p of s.pip || []) if (p.status === 'missing' || p.status === 'wrong') pip.set(p.name, p.spec);
  }
  // Nó recém-clonado: o pip ainda não conhece os pacotes dele, então entram todos os que faltam.
  const models = [...new Set(chosen.flatMap((s) => s.missingModels))];
  const manual = [...new Set(chosen.flatMap((s) => s.models.filter((m) => m.status === 'manual').map((m) => m.id)))];
  const bytes = models.reduce((sum, id) => sum + modelSize(id), 0);
  return {
    workflows: [...writeWorkflows],
    packs: [...packs].map(([id, action]) => ({ id, action })),
    pip: [...pip.values()],
    models,
    manual,
    bytes,
  };
}

const MARGIN = 2e9; // folga no disco além dos modelos

export async function startInstall(choice) {
  if (job?.state === 'running') throw fail('Já há uma instalação em andamento.', 409);
  const status = await setupStatus();
  if (!status.comfy.online) throw fail(status.comfy.error);
  const env = lastEnv;
  const plan = planInstall(status, choice);
  const needsLocal = plan.packs.some((p) => p.action !== 'restart') || plan.pip.length || plan.models.length;
  if (needsLocal && !env.local) throw fail('O ComfyUI está em outra máquina: o Trama só instala nós e modelos no ComfyUI deste computador. Os workflows podem ser copiados.');
  if (plan.pip.length && !env.python) throw fail('Não achei o Python do ComfyUI (python_embeded ou venv) para instalar os pacotes.');
  const free = env.local ? freeBytes(env.modelsDir) : null;
  if (plan.bytes && free !== null && plan.bytes + MARGIN > free) {
    throw fail(`Os modelos escolhidos ocupam ${fmtGB(plan.bytes)} e o disco ${path.parse(env.base).root} tem ${fmtGB(free)} livres (o Trama deixa ${fmtGB(MARGIN)} de folga). Desmarque alguns workflows.`);
  }
  const controller = new AbortController();
  job = {
    id: Date.now().toString(36),
    state: 'running',
    startedAt: Date.now(),
    plan,
    steps: [],
    current: null,
    log: [],
    restartNeeded: false,
    error: null,
    controller,
  };
  runJob(job, env, plan, controller.signal).catch(() => {});
  return currentJob();
}

export function cancelInstall() {
  if (job?.state === 'running') job.controller.abort();
  return currentJob();
}

async function runJob(j, env, plan, signal) {
  const log = (line) => {
    j.log.push(String(line).slice(0, 400));
    if (j.log.length > 400) j.log.splice(0, j.log.length - 400);
  };
  const step = async (label, fn) => {
    if (signal.aborted) throw new Error('Cancelado');
    const s = { label, status: 'running', detail: '' };
    j.steps.push(s);
    j.current = { label };
    log(`> ${label}`);
    try {
      const detail = await fn(s);
      s.status = 'done';
      if (detail) s.detail = detail;
    } catch (e) {
      s.status = 'error';
      s.detail = e.message;
      throw e;
    } finally {
      j.current = null;
    }
  };
  const warn = (label, detail) => {
    j.steps.push({ label, status: 'warning', detail });
    log(`! ${label}: ${detail}`);
  };
  try {
    // 1. Workflows (só trama_), com cópia de segurança da versão que estava no ComfyUI.
    for (const name of plan.workflows) {
      if (!name.startsWith(WORKFLOW_PREFIX)) continue;
      await step(`Workflow ${name}`, async () => {
        const text = fs.readFileSync(path.join(BUNDLED_WORKFLOWS_DIR, name), 'utf8');
        const old = env.online ? await comfy.loadWorkflow(name).catch(() => null) : null;
        if (old) await comfy.saveUserdata(`workflows/.trama-backup/${name}.bak`, JSON.stringify(old));
        await comfy.saveUserdata(`workflows/${name}`, text);
        return old ? 'atualizado (a versão anterior ficou em workflows/.trama-backup)' : 'copiado';
      });
    }

    // 2. Nós: ComfyUI-Trama vem junto; os outros, git clone no commit travado.
    const cloned = [];
    for (const { id, action } of plan.packs) {
      if (action === 'restart') {
        warn(id, 'A pasta já existe mas o ComfyUI não carregou os nós: reinicie o ComfyUI. Se continuar, veja o erro no console dele.');
        continue;
      }
      if (action === 'patch') {
        await step(`Ajustes do Trama em ${id}`, async () => {
          const done = patchPack(env, id);
          j.restartNeeded = true;
          return done.length ? `ajustado: ${done.join(', ')}` : 'já estava ajustado';
        });
        continue;
      }
      if (action === 'copy') {
        await step(`Nó ${id}`, async () => {
          const dir = packDirOf(env, id) || id;
          copyDir(path.join(BUNDLED_NODES_DIR, id), path.join(env.customNodes, dir));
          j.restartNeeded = true;
          return `copiado para custom_nodes/${dir}`;
        });
        continue;
      }
      await step(`Nó ${id} (${NODE_PACKS[id].version || NODE_PACKS[id].ref.slice(0, 7)})`, async () => {
        if (packDirOf(env, id)) return 'a pasta já existe; não mexi';
        await clonePack(id, env, { signal, log });
        cloned.push(id);
        j.restartNeeded = true;
        // Ajustes para este ComfyUI (setup-patches.js), logo depois do clone.
        const patched = PATCHES[id] ? patchPack(env, id) : [];
        return `custom_nodes/${id} no commit ${NODE_PACKS[id].ref.slice(0, 7)}${patched.length ? `, com os ajustes do Trama em ${patched.join(', ')}` : ''}`;
      });
    }

    // 3. Pacotes pip travados. torch e onnxruntime-gpu ficam presos na versão instalada.
    const pipSpecs = new Set(plan.pip);
    if (cloned.length) {
      const known = await pipVersions(env, { signal });
      for (const p of pipOf(cloned)) {
        const have = known?.get(pipName(p.spec)) || (p.alt || []).map((a) => known?.get(pipName(a))).find(Boolean);
        if (have) continue;
        if (p.cuda && env.cuda && p.cuda !== env.cuda) {
          warn(p.spec, `essa versão é para torch CUDA ${p.cuda}; o seu é CUDA ${env.cuda}. Instale à mão a versão do ${pipName(p.spec)} que combina com ele.`);
          continue;
        }
        pipSpecs.add(p.spec);
      }
    }
    if (pipSpecs.size && !env.python) {
      warn('Pacotes do Python', `não achei o Python do ComfyUI; instale à mão: ${[...pipSpecs].join(' ')}`);
    } else if (pipSpecs.size) {
      await step(`Pacotes do Python (${pipSpecs.size})`, async () => {
        const installed = await pipVersions(env, { signal });
        const pins = PROTECTED_PACKAGES.filter((n) => installed?.get(pipName(n)) && ![...pipSpecs].some((s) => pipName(s) === pipName(n)))
          .map((n) => `${n}==${installed.get(pipName(n))}`);
        const constraints = path.join(os.tmpdir(), `trama-constraints-${j.id}.txt`);
        fs.writeFileSync(constraints, pins.join('\n') + '\n');
        try {
          const r = await run(env.python, ['-m', 'pip', 'install', '--no-warn-script-location', '-c', constraints, ...pipSpecs], { signal, onLine: log });
          if (r.code !== 0) {
            const locked = /WinError 5|WinError 32|Access is denied|being used by another process/i.test(r.err + r.out);
            throw new Error(locked
              ? 'O pip não conseguiu trocar um arquivo que o ComfyUI está usando. Feche o ComfyUI e clique em Instalar de novo (os modelos já baixados ficam).'
              : `pip install falhou: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`);
          }
        } finally {
          fs.rmSync(constraints, { force: true });
        }
        j.restartNeeded = true;
        return [...pipSpecs].join(', ');
      });
    }

    // 4. Script de instalação dos nós recém-clonados (ex.: ambiente do UniRig).
    for (const id of cloned) {
      const script = NODE_PACKS[id].installScript;
      if (!script) continue;
      if (!env.python) {
        warn(`${id}: ${script}`, `não achei o Python do ComfyUI; rode à mão: python ${script} dentro de custom_nodes/${id}.`);
        continue;
      }
      await step(`${id}: ${script}`, async () => {
        const r = await run(env.python, [script], { cwd: path.join(env.customNodes, id), signal, onLine: log });
        if (r.code !== 0) throw new Error(`${script} falhou: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`);
      });
    }

    // 5. Modelos, um arquivo por vez, conferindo o espaço antes de cada um.
    for (const id of plan.models) {
      const m = MODELS[id];
      await step(`Modelo ${id} (${fmtGB(modelSize(id))})`, async (s) => {
        const dir = modelTarget(env, id);
        for (const f of m.files) {
          const dest = path.join(dir, f.name);
          if (fs.existsSync(dest)) continue;
          if (m.source === 'imageio-ffmpeg') {
            if (!env.python) throw new Error(`Não achei o Python do ComfyUI para copiar o ffmpeg do imageio-ffmpeg para ${dest}.`);
            const r = await run(env.python, ['-I', '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { signal, timeout: 60000 });
            const exe = r.code === 0 ? r.out.trim().split(/\s*\n/).pop().trim() : '';
            if (!exe || !fs.existsSync(exe)) throw new Error(`O pacote imageio-ffmpeg não entregou o ffmpeg (${(r.err || '').trim().slice(-200)}).`);
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(exe, dest);
            continue;
          }
          const free = freeBytes(dir);
          if (free !== null && f.size + MARGIN / 4 > free) throw new Error(`Sem espaço no disco para ${f.name} (${fmtGB(f.size)}; livres ${fmtGB(free)}).`);
          j.current = { label: s.label, file: f.name, bytes: 0, total: f.size };
          await download(f.url, dest, {
            size: f.size,
            signal,
            onProgress: (bytes, total) => (j.current = { label: s.label, file: f.name, bytes, total }),
          });
        }
        return dir;
      });
    }
    for (const id of plan.manual) {
      warn(`Modelo ${id}`, `não há link público conhecido: ponha o arquivo em ${modelPlace(id)}.`);
    }
    j.state = 'done';
  } catch (e) {
    j.state = signal.aborted ? 'cancelled' : 'error';
    j.error = signal.aborted ? 'Cancelado. O que já foi baixado fica; downloads pela metade continuam de onde pararam.' : e.message;
    log(`x ${j.error}`);
  } finally {
    j.finishedAt = Date.now();
    resetAvailability();
    comfy.objectInfo({ refresh: true }).catch(() => {});
  }
}
