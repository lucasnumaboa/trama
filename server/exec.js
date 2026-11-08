// Roda um workflow do ComfyUI com valores e mídias de entrada.
import { createHash } from 'node:crypto';
import * as comfy from './comfy.js';
import { describeWorkflow } from './describe.js';

export async function describeByName(name, { refresh = false } = {}) {
  const info = await comfy.objectInfo({ refresh });
  return describeWorkflow(name, await comfy.loadWorkflow(name), info);
}

// Arquivos que não estão na pasta input do ComfyUI são reenviados para lá.
const reuploaded = new Map();
export async function asComfyInput(file) {
  if (file.type === 'input') return file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename;
  const key = `${file.type}/${file.subfolder}/${file.filename}`;
  if (!reuploaded.has(key)) {
    const res = await comfy.fetchFile(file);
    const buffer = Buffer.from(await res.arrayBuffer());
    const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12);
    const ext = file.filename.includes('.') ? file.filename.split('.').pop() : 'bin';
    reuploaded.set(key, await comfy.uploadInput(buffer, `trama_${hash}.${ext}`));
  }
  return reuploaded.get(key);
}

function coerce(field, value) {
  if (field.kind === 'number' || field.kind === 'seed') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`"${field.label}" (${field.id}) precisa ser um número`);
    if (Number.isFinite(field.min) && n < field.min) throw new Error(`"${field.label}" (${field.id}) mínimo é ${field.min}`);
    if (Number.isFinite(field.max) && n > field.max) throw new Error(`"${field.label}" (${field.id}) máximo é ${field.max}`);
    return field.numberType === 'int' ? Math.round(n) : n;
  }
  if (field.kind === 'bool') return value === true || value === 'true' || value === 1;
  if ((field.kind === 'model' || field.kind === 'combo') && field.options && !field.options.includes(value)) {
    throw new Error(`"${field.label}" (${field.id}) não aceita "${value}". Opções: ${field.options.slice(0, 20).join(', ')}`);
  }
  return value;
}

function randomSeed(field) {
  const max = Math.min(Number.isFinite(field.max) ? field.max : 2 ** 50, 2 ** 50);
  const min = Number.isFinite(field.min) ? field.min : 0;
  return min + Math.floor(Math.random() * (max - min));
}

/**
 * @param {object} opts
 * @param {string} opts.name          workflow salvo no ComfyUI
 * @param {object} opts.values        { fieldId: valor }
 * @param {object} opts.media         { slotId ("media:N"): arquivo {filename, subfolder, type} }
 * @returns {{ files: Array, seeds: object, desc: object }}
 */
export async function runWorkflow({ name, values = {}, media = {}, onProgress = () => {}, signal }) {
  const { desc, prompt, seeds } = await buildPrompt({ name, values, media });

  const history = await comfy.runPrompt(prompt, {
    signal,
    onEvent: (e) => {
      if (e.type === 'queued') onProgress({ detail: 'Na fila do ComfyUI', progress: 0 });
      if (e.type === 'executing') onProgress({ detail: prompt[e.node]?._meta?.title || e.node });
      if (e.type === 'progress') onProgress({ progress: e.value / e.max, detail: prompt[e.node]?._meta?.title });
    },
  });
  return collectFiles(history, desc, prompt, seeds);
}

/** Monta o prompt de API com valores e mídias aplicados (sem enviar). */
export async function buildPrompt({ name, values = {}, media = {} }) {
  const desc = await describeByName(name);
  const prompt = structuredClone(desc.prompt);
  const seeds = {};

  // Um campo pode valer para um nó só ou para vários (valores de PrimitiveNode).
  const targetsOf = (field) => field.targets || [[field.nodeId, field.input]];
  const setField = (field, value) => {
    for (const [nodeId, input] of targetsOf(field)) prompt[nodeId].inputs[input] = value;
  };
  for (const [id, value] of Object.entries(values)) {
    const field = desc.fields.find((f) => f.id === id);
    if (!field) throw new Error(`O workflow "${name}" não tem o campo "${id}". Campos: ${desc.fields.map((f) => f.id).join(', ')}`);
    setField(field, coerce(field, value));
  }
  for (const field of desc.fields.filter((f) => f.kind === 'seed')) {
    if (!(field.id in values)) setField(field, randomSeed(field));
    const [nodeId, input] = targetsOf(field)[0];
    seeds[field.id] = prompt[nodeId].inputs[input];
  }
  for (const [slotId, file] of Object.entries(media)) {
    const slot = desc.mediaInputs.find((m) => m.id === slotId);
    if (!slot) throw new Error(`O workflow "${name}" não tem a entrada "${slotId}". Entradas: ${desc.mediaInputs.map((m) => m.id).join(', ') || 'nenhuma'}`);
    prompt[slot.nodeId].inputs[slot.input] = await asComfyInput(file);
  }
  return { desc, prompt, seeds };
}

function collectFiles(history, desc, prompt, seeds) {
  const byNode = comfy.collectOutputs(history);
  // Ordem das saídas: a do descritor (nós Save/Preview), depois qualquer outra.
  const order = [...desc.outputs.map((o) => o.nodeId), ...Object.keys(byNode)];
  const files = [];
  const seen = new Set();
  for (const nodeId of order) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const isPreview = /^Preview/i.test(prompt[nodeId]?.class_type || '');
    for (const f of byNode[nodeId] || []) files.push({ ...f, nodeId, preview: isPreview });
  }
  // Se houver saídas "Save", ignora as "Preview" (são cópias temporárias).
  const saved = files.filter((f) => !f.preview);
  return { files: saved.length ? saved : files, seeds, desc };
}
