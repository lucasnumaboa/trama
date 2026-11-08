// Transforma um workflow do ComfyUI num "modelo" utilizável no canvas:
// campos editáveis, entradas de mídia/texto e saídas tipadas.
import { convertWorkflow, findInputSpec, comboOptions, isWidgetSpec } from './convert.js';

const MEDIA_FLAGS = { image_upload: 'image', video_upload: 'video', audio_upload: 'audio' };
const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;
const IMPORTANT = new Set([
  'width', 'height', 'length', 'steps', 'cfg', 'denoise', 'batch_size', 'duration', 'seconds',
  'frame_rate', 'fps', 'strength', 'strength_model', 'megapixels', 'num_frames', 'max_length',
]);

function mediaFlag(spec) {
  const opts = spec?.[1] || {};
  return Object.entries(MEDIA_FLAGS).find(([flag]) => opts[flag])?.[1] || null;
}

function outputKind(classType, def) {
  const name = classType.toLowerCase();
  if (/audio|mp3|opus|flac/.test(name)) return 'audio';
  if (/video|webm|animated|gif/.test(name)) return 'video';
  if (/image|mask/.test(name)) return 'image';
  if (/text|any|string/.test(name)) return 'text';
  const inputTypes = Object.values(def.input?.required || {}).map((s) => s[0]);
  if (inputTypes.includes('IMAGE')) return 'image';
  if (inputTypes.includes('AUDIO')) return 'audio';
  if (inputTypes.includes('VIDEO')) return 'video';
  return 'file';
}

const sortIds = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const prettify = (name) => name.replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function describeWorkflow(name, workflow, objectInfo) {
  const { prompt, nodes, primitives } = convertWorkflow(workflow, objectInfo);
  const fields = [];
  const mediaInputs = [];
  const outputs = [];
  const notes = (workflow.nodes || [])
    .filter((n) => (n.type === 'MarkdownNote' || n.type === 'Note') && n.mode !== 4)
    .map((n) => String(n.widgets_values?.[0] || '').trim())
    .filter(Boolean);

  // O ComfyUI só executa o que chega a um nó de saída. Um Load Image ligado só a um
  // ramo desativado (bypass/mudo) não é entrada de verdade nem deve ser exigido.
  const used = new Set();
  const visit = (id) => {
    if (used.has(id) || !prompt[id]) return;
    used.add(id);
    for (const v of Object.values(prompt[id].inputs)) if (Array.isArray(v)) visit(String(v[0]));
  };
  for (const [id, n] of Object.entries(prompt)) if (objectInfo[n.class_type]?.output_node) visit(id);
  // Nó de saída cujo resultado alimenta outro nó (ex.: PreviewAny que repassa o
  // prompt reescrito) é passagem interna, não um resultado do workflow.
  const consumed = new Set();
  for (const n of Object.values(prompt)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) consumed.add(String(v[0]));

  for (const id of Object.keys(prompt).sort(sortIds)) {
    if (!used.has(id)) continue;
    const { class_type: type, inputs } = prompt[id];
    const def = objectInfo[type];
    const title = nodes[id].title;

    if (def.output_node && !consumed.has(id)) {
      outputs.push({ id: `out:${id}`, nodeId: id, title, kind: outputKind(type, def) });
    }

    for (const [input, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) continue; // ligado a outro nó do workflow
      const spec = findInputSpec(def, input);
      if (!spec || !isWidgetSpec(spec)) continue;
      const [rawType, opts = {}] = spec;
      const media = mediaFlag(spec);
      if (media) {
        mediaInputs.push({ id: `media:${id}`, nodeId: id, input, title, kind: media, default: value });
        continue;
      }
      const options = comboOptions(spec);
      let kind;
      if (options) kind = options.some((o) => typeof o === 'string' && MODEL_FILE.test(o)) ? 'model' : 'combo';
      else if (rawType === 'STRING') kind = opts.multiline ? 'text' : 'string';
      else if (rawType === 'BOOLEAN') kind = 'bool';
      // Seed = campo com nome de seed, ou um primitivo com controle de sorteio cujo
      // título fala em seed. Primitivos de largura/altura também têm esse controle.
      else if (rawType === 'INT' && (/(^|\.|_)seed$/.test(input) || (opts.control_after_generate && /seed|semente/i.test(`${input} ${title}`)))) kind = 'seed';
      else kind = 'number';

      const leaf = input.split('.').pop();
      fields.push({
        id: `${id}.${input}`,
        nodeId: id,
        input,
        nodeTitle: title,
        label: opts.display_name || prettify(leaf),
        kind,
        numberType: rawType === 'INT' || kind === 'seed' ? 'int' : rawType === 'FLOAT' ? 'float' : undefined,
        default: value,
        options: options || undefined,
        min: opts.min,
        max: opts.max,
        step: opts.step,
        tooltip: opts.tooltip,
        basic: ['text', 'seed', 'model'].includes(kind) || IMPORTANT.has(leaf),
        acceptsText: kind === 'text' || kind === 'string',
      });
    }
  }

  // Um PrimitiveNode que alimenta vários nós vira um campo só (ex.: duração da música
  // usada pelo latente e pelo codificador). Mudar o campo muda todos os destinos.
  for (const [key, prim] of Object.entries(primitives)) {
    const linked = prim.targets.map(([nodeId, input]) => fields.find((f) => f.nodeId === nodeId && f.input === input)).filter(Boolean);
    if (!linked.length) continue;
    const first = linked[0];
    if (prim.keepId) {
      // Entrada de subgrafo que alimenta vários nós: cada campo mantém o seu id e
      // passa a mudar todos os destinos (senão um nó recebe o valor novo e o outro fica com o padrão).
      // Fica um campo só (o primeiro); os outros seriam cópias que sobrescrevem o valor.
      first.targets = prim.targets.filter(([nodeId]) => prompt[nodeId]);
      for (const f of linked.slice(1)) fields.splice(fields.indexOf(f), 1);
      continue;
    }
    const merged = {
      ...first,
      id: `${key}.value`,
      nodeId: key,
      input: 'value',
      label: prim.title ? prettify(prim.title) : first.label,
      nodeTitle: prim.title || first.nodeTitle,
      targets: prim.targets,
      basic: linked.some((f) => f.basic),
    };
    // Limites que valem para todos os destinos.
    const mins = linked.map((f) => f.min).filter(Number.isFinite);
    const maxs = linked.map((f) => f.max).filter(Number.isFinite);
    if (mins.length) merged.min = Math.max(...mins);
    if (maxs.length) merged.max = Math.min(...maxs);
    const index = fields.indexOf(first);
    for (const f of linked) fields.splice(fields.indexOf(f), 1);
    fields.splice(Math.min(index, fields.length), 0, merged);
  }

  return {
    name,
    title: name.replace(/\.json$/i, '').replace(/_/g, ' '),
    prompt,
    fields,
    mediaInputs,
    outputs,
    notes,
  };
}
