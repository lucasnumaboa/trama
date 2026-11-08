// Ferramentas que o agente pode chamar. Cada uma devolve um objeto JSON
// (vai para o modelo) e um rótulo curto (vai para o chat).
import * as comfy from './comfy.js';
import { describeByName, runWorkflow } from './exec.js';
import { editMedia, mediaInfo, OPERATIONS, SINGLE_INPUT_OPS, NoChange } from './media.js';
import {
  addAsset, updateAsset, saveProject, describeAsset, addEdge, emit, placeBelow, addVersion, selectVersion, removeAsset,
} from './projects.js';

const KIND_PT = { image: 'imagem', video: 'vídeo', audio: 'áudio', text: 'texto', file: 'arquivo' };
const KIND_PLURAL = { image: 'imagens', video: 'vídeos', audio: 'áudios', text: 'textos', file: 'arquivos' };
const plural = (n, kind) => (n === 1 ? `1 ${KIND_PT[kind] || kind}` : `${n} ${KIND_PLURAL[kind] || kind}`);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const OP_LABEL = {
  concat_videos: 'Juntou vídeos', add_audio: 'Colocou áudio', extract_audio: 'Extraiu o áudio', trim: 'Cortou', resize: 'Redimensionou',
  reformat: 'Mudou o formato', compress: 'Comprimiu', change_fps: 'Mudou o fps', speed: 'Mudou a velocidade', fade: 'Aplicou fade',
  volume: 'Ajustou o volume', mute: 'Tirou o som', loop: 'Repetiu até a duração', convert: 'Converteu',
};

export const TOOL_SCHEMAS = [
  {
    name: 'list_workflows',
    description: 'Lista os workflows salvos no ComfyUI (as capacidades de geração), com o que cada um recebe e gera.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_workflow',
    description:
      'Lê os detalhes de um workflow: notas do autor, entradas de mídia (slot media:N com o tipo), campos editáveis (id, tipo, padrão, opções, limites) e saídas. Leia antes de rodar.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Nome exato do workflow' } }, required: ['name'] },
  },
  {
    name: 'run_workflow',
    description:
      'Gera algo NOVO rodando um workflow do ComfyUI; o resultado vira um card ligado às entradas. Espera terminar (vídeo leva minutos). Só passe os campos que quer mudar; o resto usa o padrão do workflow. Seeds são sorteadas se não forem passadas. Para mudar um card que já existe, use revise_asset ou edit_media.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome exato do workflow' },
        title: { type: 'string', description: 'Título curto do card, em português' },
        values: { type: 'object', description: 'Valores por id de campo (veja get_workflow), ex.: {"57:27.text": "a duck...", "99.value": 30}', additionalProperties: true },
        inputs: {
          type: 'object',
          description: 'Mídias de entrada: slot -> id do asset, ex.: {"media:7": "asset_ab12cd34"}. O tipo do asset tem que ser o do slot. Todos os slots são obrigatórios.',
          additionalProperties: { type: 'string' },
        },
        allow_default_inputs: { type: 'boolean', description: 'Só true se o usuário pediu para usar os arquivos de exemplo do workflow nos slots vazios.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'revise_asset',
    description:
      'Refaz um card gerado por workflow mudando parâmetros da receita dele (prompt, duração, tamanho, estilo, seed, entradas) e guarda o resultado como NOVA VERSÃO do mesmo card. Use quando o conteúdo precisa ser gerado de novo. Para manter a mesma variação, passe a seed anterior (campo seeds do card). Para mudanças técnicas em mídia pronta (resolução, proporção, corte, compressão, volume), prefira edit_media, que é instantâneo.',
    parameters: {
      type: 'object',
      properties: {
        asset_id: { type: 'string' },
        values: { type: 'object', description: 'Campos a mudar (ids do get_workflow da receita). O resto fica como na versão atual.', additionalProperties: true },
        inputs: { type: 'object', description: 'Trocar mídias de entrada: slot -> asset_id', additionalProperties: { type: 'string' } },
        note: { type: 'string', description: 'O que mudou nesta versão, em poucas palavras (ex.: "30 s em vez de 60")' },
      },
      required: ['asset_id'],
    },
  },
  {
    name: 'edit_media',
    description: `Edição local e rápida com ffmpeg (não usa a GPU). Operações:
- concat_videos: junta vídeos na ordem (asset_ids com 2+ vídeos). Resultado é um card novo.
- add_audio: põe um áudio num vídeo (asset_ids = [vídeo, áudio]); mode "replace" troca o som, "mix" mistura; volume do áudio novo. Card novo.
- extract_audio: tira o áudio de um vídeo. Card novo.
- trim: corta entre start e end (segundos).
- trim_silence: tira o silêncio do começo e do fim (vídeo ou áudio), com um fade curto no final.
- resize: muda a resolução: width e/ou height, ou max_side, ou scale (0.5 = metade). Vídeo ou imagem.
- reformat: muda a proporção: aspect "9:16", "16:9", "1:1", "4:5"; mode "crop" (corta), "pad" (faixas da cor dominante; color "auto" ou "#rrggbb") ou "blur" (fundo desfocado). Bordas uniformes (ex.: cantos brancos) são recortadas antes, automaticamente.
- crop_borders: recorta borda uniforme clara ou escura em volta do conteúdo (vídeo ou imagem).
- compress: diminui o arquivo: target_mb ou crf (18 melhor, 28 padrão, 35 menor); imagem vira jpg; áudio usa audio_kbps. Se já estiver abaixo do alvo ou não diminuir, nada muda.
- change_fps: fps. speed: factor (2 = 2x mais rápido, 0.5 = câmera lenta). fade: fade_in/fade_out em segundos. volume: volume (fator). mute: tira o som. loop: repete até duration segundos.
- convert: format mp4, webm, gif, mp3, wav, png, jpg, webp.
Nas operações de um arquivo só, o resultado vira uma NOVA VERSÃO do mesmo card (as_version=true, padrão). Use as_version=false para criar um card separado.`,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: OPERATIONS },
        asset_ids: { type: 'array', items: { type: 'string' } },
        as_version: { type: 'boolean' },
        from_version: {
          type: 'number',
          description: 'Versão do card a usar como base (1 = original). Sem isso: a atual, mas reformat/resize/crop_borders/compress partem automaticamente da versão anterior a outras edições desse tipo.',
        },
        title: { type: 'string', description: 'Título do card novo (quando não for versão)' },
        note: { type: 'string', description: 'O que mudou, em poucas palavras' },
        start: { type: 'number' }, end: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' }, max_side: { type: 'number' }, scale: { type: 'number' },
        aspect: { type: 'string' }, mode: { type: 'string', description: 'reformat: crop|pad|blur; add_audio: replace|mix' }, color: { type: 'string' },
        target_mb: { type: 'number' }, crf: { type: 'number' }, quality: { type: 'number' }, audio_kbps: { type: 'number' },
        fps: { type: 'number' }, factor: { type: 'number' }, fade_in: { type: 'number' }, fade_out: { type: 'number' },
        volume: { type: 'number' }, duration: { type: 'number' }, format: { type: 'string' },
      },
      required: ['operation', 'asset_ids'],
    },
  },
  {
    name: 'media_info',
    description:
      'Mede uma mídia: resolução, duração, fps, tamanho em MB, se tem áudio, onde o som começa e acaba (silêncio), borda uniforme em volta e cor dominante, além de avisos. Use antes de editar quando precisar desses números.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] },
  },
  {
    name: 'select_version',
    description: 'Volta um card para outra versão dele (1 = original).',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' }, version: { type: 'number' } }, required: ['asset_id', 'version'] },
  },
  {
    name: 'create_text',
    description: 'Cria um card de texto no canvas: roteiro, plano, lista de cenas, prompt, letra de música, legenda.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        based_on: { type: 'array', items: { type: 'string' }, description: 'Ids de assets usados como base (opcional)' },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'update_text',
    description: 'Reescreve o conteúdo de um card de texto (guarda como nova versão do texto).',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' }, text: { type: 'string' } }, required: ['asset_id', 'text'] },
  },
  {
    name: 'rename_asset',
    description: 'Muda o título de um card.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' }, title: { type: 'string' } }, required: ['asset_id', 'title'] },
  },
  {
    name: 'remove_asset',
    description: 'Tira um card do canvas (o arquivo continua no ComfyUI). Só quando o usuário pedir.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] },
  },
  {
    name: 'list_assets',
    description: 'Lista os cards do projeto com id, tipo, título, prompt, receita (workflow e valores usados), seeds e versões.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_text',
    description: 'Lê o conteúdo completo de um card de texto.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] },
  },
  {
    name: 'ask_user',
    description:
      'Faz uma pergunta com opções clicáveis e encerra sua vez. Use só quando faltar uma decisão importante que você não consegue tomar sozinho. Ponha sua recomendação como primeira opção.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: '2 a 4 opções curtas' } },
      required: ['question', 'options'],
    },
  },
];

// ---- Catálogo ----------------------------------------------------------------
let catalogCache = { at: 0, text: '' };
export async function workflowCatalog() {
  if (catalogCache.text && Date.now() - catalogCache.at < 60000) return catalogCache.text;
  const lines = [];
  for (const w of await comfy.listWorkflows()) {
    try {
      const d = await describeByName(w.name);
      const ins = d.mediaInputs.map((m) => `${KIND_PT[m.kind]} "${m.title}"`).join(' + ') || 'só texto';
      const outs = [...new Set(d.outputs.map((o) => KIND_PT[o.kind] || o.kind))].join(', ');
      const about = clip(d.notes.join(' ').replace(/\s+/g, ' ').replace(/[#*`>]/g, '').trim(), 220);
      lines.push(`- ${d.name}: ${ins} → ${outs}.${about ? ` ${about}` : ''}`);
    } catch (e) {
      lines.push(`- ${w.name}: indisponível (${clip(e.message, 120)})`);
    }
  }
  catalogCache = { at: Date.now(), text: lines.join('\n') };
  return catalogCache.text;
}

function workflowSummary(d) {
  return {
    name: d.name,
    about: clip(d.notes.join(' ').replace(/\s+/g, ' ').replace(/[#*`]/g, ''), 280) || undefined,
    media_inputs: d.mediaInputs.map((m) => ({ slot: m.id, kind: m.kind, title: m.title })),
    text_fields: d.fields.filter((f) => f.kind === 'text').map((f) => ({ id: f.id, node: f.nodeTitle })),
    outputs: [...new Set(d.outputs.map((o) => o.kind))],
  };
}

function workflowDetail(d) {
  const field = (f) => {
    const out = { id: f.id, label: f.label, node: f.nodeTitle, kind: f.kind };
    if (f.default !== undefined && f.default !== null) out.default = typeof f.default === 'string' ? clip(f.default, 400) : f.default;
    if (f.options) out.options = f.options.length > 25 ? [...f.options.slice(0, 25), `…(+${f.options.length - 25})`] : f.options;
    if (f.min !== undefined) out.min = f.min;
    if (f.max !== undefined) out.max = f.max;
    if (f.targets) out.applies_to = f.targets.map((t) => t.join('.'));
    return out;
  };
  return {
    name: d.name,
    notes: clip(d.notes.join('\n\n'), 2500),
    media_inputs: d.mediaInputs.map((m) => ({ slot: m.id, kind: m.kind, title: m.title, example_file: m.default })),
    main_fields: d.fields.filter((f) => f.basic).map(field),
    other_fields: d.fields
      .filter((f) => !f.basic)
      .map((f) => ({ id: f.id, label: f.label, node: f.nodeTitle, default: typeof f.default === 'string' ? clip(f.default, 80) : f.default })),
    outputs: d.outputs.map((o) => ({ kind: o.kind, node: o.title })),
  };
}

// ---- Conferência dos resultados ----------------------------------------------
// Mede o arquivo de verdade e aponta problemas que o agente precisa tratar antes
// de dizer ao usuário que ficou pronto.
async function inspect(asset, { expect = {} } = {}) {
  if (!asset?.file || asset.kind === 'text') return null;
  let info;
  try {
    info = await mediaInfo(asset.file, asset.kind);
  } catch (e) {
    return { id: asset.id, warnings: [`não consegui medir o arquivo: ${e.message}`] };
  }
  const w = [];
  const s = info.silence;
  if (s?.trailing > 1) w.push(`tem ${s.trailing}s de silêncio no fim (o som acaba em ${s.audible_end}s de ${info.duration}s). Corte com trim_silence ou gere de novo com mais conteúdo.`);
  if (s?.leading > 1) w.push(`começa com ${s.leading}s de silêncio. Corte com trim_silence.`);
  if (info.border) w.push(`tem borda ${info.border === 'light' ? 'clara' : 'escura'} uniforme em volta do conteúdo (ex.: cantos brancos). Para mudar o formato ou usar como entrada, recorte antes com crop_borders.`);
  if (expect.duration && info.duration && Math.abs(info.duration - expect.duration) > Math.max(1, expect.duration * 0.15)) {
    w.push(`a duração real é ${info.duration}s, mas o pedido era ${expect.duration}s.`);
  }
  if (expect.audioSeconds && info.duration && expect.audioSeconds > info.duration + 1) {
    w.push(`o áudio usado tem ${expect.audioSeconds}s, mas o vídeo só ${info.duration}s: só os primeiros ${info.duration}s do áudio entraram. Para usar o áudio inteiro, repita o vídeo (loop) ou corte o trecho do áudio que interessa.`);
  }
  const summary = { id: asset.id, kind: asset.kind };
  for (const k of ['width', 'height', 'duration', 'fps', 'size_mb', 'has_audio', 'border', 'dominant_color']) if (info[k] !== undefined && info[k] !== null) summary[k] = info[k];
  if (s) summary.sound = `${s.audible_start}s–${s.audible_end}s`;
  return { ...summary, warnings: w };
}

async function inspectAll(assets, opts) {
  const checks = (await Promise.all(assets.map((a) => inspect(a, opts)))).filter(Boolean);
  const warnings = checks.flatMap((c) => c.warnings.map((w) => `"${assets.find((a) => a.id === c.id)?.title}": ${w}`));
  return { checks, warnings };
}

// Edições que refazem o enquadramento/qualidade: devem partir da origem, não de
// outra edição do mesmo tipo.
const DERIVATIVE_OPS = new Set(['reformat', 'resize', 'crop_borders', 'compress']);

const findAsset = (p, id) => {
  const a = p.assets.find((x) => x.id === id);
  if (!a) throw new Error(`Asset "${id}" não existe neste projeto. Use list_assets.`);
  return a;
};

// ---- Geração (nova ou como versão) -------------------------------------------
async function generate(ctx, { name, values = {}, inputs = {}, allowDefault = false, title, reviseId, note }) {
  const p = ctx.project;
  const d = await describeByName(name);
  const media = {};
  const inputIds = [];
  for (const [slot, assetId] of Object.entries(inputs)) {
    const a = findAsset(p, assetId);
    if (!a.file) throw new Error(`O asset ${assetId} não é um arquivo de mídia`);
    const def = d.mediaInputs.find((m) => m.id === slot);
    if (!def) throw new Error(`O workflow ${d.name} não tem o slot "${slot}". Slots: ${d.mediaInputs.map((m) => `${m.id} (${m.kind})`).join(', ') || 'nenhum'}`);
    if (def.kind !== a.kind) {
      throw new Error(`O slot ${slot} ("${def.title}") espera ${KIND_PT[def.kind]}, mas ${a.id} é ${KIND_PT[a.kind]}. Este workflow não serve para isso: escolha outro no catálogo.`);
    }
    media[slot] = a.file;
    inputIds.push(a.id);
  }
  const missing = d.mediaInputs.filter((m) => !media[m.id]);
  if (missing.length && !allowDefault) {
    throw new Error(`Faltam entradas: ${missing.map((m) => `${m.id} (${KIND_PT[m.kind]}: "${m.title}")`).join(', ')}. Passe assets do projeto, ou peça ao usuário. Se este workflow não combina com o pedido, use outro.`);
  }
  // Campo de texto pode receber o id de um card de texto.
  const resolved = { ...values };
  for (const [k, v] of Object.entries(resolved)) {
    if (typeof v === 'string' && /^asset_[0-9a-f]{8}$/.test(v)) {
      const a = findAsset(p, v);
      if (a.kind === 'text') {
        resolved[k] = a.text;
        inputIds.push(a.id);
      }
    }
  }
  const mainText = d.fields.filter((f) => f.kind === 'text').map((f) => resolved[f.id] ?? f.default).find((t) => t && String(t).trim());
  const kind = d.outputs[0]?.kind || 'image';
  const recipe = { tool: 'run_workflow', workflow: d.name, values, inputs, ...(allowDefault ? { allow_default_inputs: true } : {}) };

  let target;
  let previous;
  if (reviseId) {
    target = findAsset(p, reviseId);
    previous = { status: target.status, error: target.error };
    updateAsset(p, target.id, { status: 'generating', progress: 0, detail: 'Preparando nova versão' });
    for (const id of new Set(inputIds)) addEdge(p, id, target.id);
  } else {
    target = addAsset(p, { kind, title: title || d.title, status: 'generating', progress: 0, detail: 'Preparando', workflow: d.name, prompt: mainText ? String(mainText) : undefined }, [...new Set(inputIds)]);
  }
  saveProject(p);
  ctx.step({ label: `${reviseId ? 'Refazendo' : 'Gerando'} ${KIND_PT[kind] || kind} com ${d.title}`, assetIds: [target.id] });

  let last = 0;
  try {
    const { files, seeds } = await runWorkflow({
      name: d.name,
      values: resolved,
      media,
      signal: ctx.signal,
      onProgress: ({ progress, detail }) => {
        const now = Date.now();
        if (now - last < 250 && progress !== 1) return;
        last = now;
        updateAsset(p, target.id, { ...(progress !== undefined ? { progress } : {}), ...(detail ? { detail } : {}) });
      },
    });
    const outFiles = files.filter((f) => f.kind !== 'text');
    if (!outFiles.length) throw new Error('O workflow terminou sem gerar arquivos');
    const created = [];
    const baseTitle = target.title;
    outFiles.forEach((f, i) => {
      const fileRef = { filename: f.filename, subfolder: f.subfolder, type: f.type };
      const v = { file: fileRef, kind: f.kind, recipe, seeds, prompt: mainText ? String(mainText) : target.prompt, workflow: d.name };
      if (i === 0) {
        if (reviseId) created.push(addVersion(p, target.id, { ...v, note: note || 'refeito' }));
        else {
          updateAsset(p, target.id, { status: 'ready', progress: 1, detail: '', ...(outFiles.length > 1 ? { title: `${baseTitle} (1)` } : {}) });
          created.push(addVersion(p, target.id, { ...v, note: 'original' }));
        }
      } else {
        const a = addAsset(p, { ...v, title: `${baseTitle} (${i + 1})`, position: placeBelow(p, created[created.length - 1]) }, []);
        a.versions = [{ id: 'v1', createdAt: Date.now(), note: 'original', ...v }];
        a.current = 0;
        for (const src of new Set(inputIds)) addEdge(p, src, a.id);
        created.push(a);
      }
    });
    saveProject(p);
    const counts = {};
    created.forEach((a) => (counts[a.kind] = (counts[a.kind] || 0) + 1));
    const what = Object.entries(counts).map(([k, n]) => plural(n, k)).join(' e ');
    const label = reviseId ? `Nova versão de "${target.title}" com ${d.title}` : `Gerou ${what} com ${d.title}`;
    // Duração pedida (campo de duração/segundos), para conferir com a real.
    const durField = d.fields.find((f) => f.kind === 'number' && /dura[cç][aã]o|seconds?|segundos/i.test(`${f.label} ${f.nodeTitle} ${f.input}`));
    const asked = durField ? Number(resolved[durField.id] ?? durField.default) : undefined;
    const { checks, warnings } = await inspectAll(created, { expect: Number.isFinite(asked) && asked > 0 ? { duration: asked } : {} });
    return { label, assetIds: created.map((a) => a.id), warnings, result: { ok: true, created: created.map(describeAsset), seeds, checks, warnings } };
  } catch (error) {
    if (reviseId) updateAsset(p, target.id, { status: target.file ? 'ready' : previous.status, error: target.file ? undefined : previous.error, detail: '', progress: 1 }, { persist: true });
    else updateAsset(p, target.id, { status: 'error', error: error.message, detail: '' }, { persist: true });
    throw error;
  }
}

async function edit(ctx, args) {
  const p = ctx.project;
  const assets = (args.asset_ids || []).map((id) => findAsset(p, id));
  if (!assets.length) throw new Error('Passe asset_ids');
  if (assets.some((a) => !a.file)) throw new Error('Todos os assets precisam ser arquivos de mídia');
  if (assets.some((a) => a.status === 'generating')) throw new Error('Espere o card terminar de gerar antes de editar');
  const op = args.operation;
  const single = SINGLE_INPUT_OPS.has(op) && assets.length === 1;
  const wantVersion = single && args.as_version !== false;
  const opts = { ...args };
  const recipe = { tool: 'edit_media', operation: op, inputs: assets.map((a) => a.id), options: Object.fromEntries(Object.entries(args).filter(([k]) => !['operation', 'asset_ids', 'as_version', 'title', 'note'].includes(k))) };
  const label = OP_LABEL[op] || op;

  // Para avisar quando o áudio colocado é mais longo que o vídeo.
  const expect = {};
  if (op === 'add_audio') {
    const audioAsset = assets.find((a, i) => i > 0 && (a.kind === 'audio' || a.kind === 'video'));
    if (audioAsset) expect.audioSeconds = (await mediaInfo(audioAsset.file, audioAsset.kind).catch(() => ({}))).duration;
  }

  if (wantVersion) {
    const target = assets[0];
    // Base da edição: a versão pedida, ou (para enquadramento/compressão) a versão
    // de origem antes de outras edições desse tipo, para não acumular defeitos
    // (ex.: mudar o formato de algo que já foi reformatado).
    const versions = target.versions || [];
    let baseIdx = versions.length ? (target.current ?? versions.length - 1) : null;
    if (versions.length && Number.isInteger(args.from_version)) {
      if (!versions[args.from_version - 1]) throw new Error(`A versão ${args.from_version} não existe (o card tem ${versions.length})`);
      baseIdx = args.from_version - 1;
    } else if (versions.length && DERIVATIVE_OPS.has(op)) {
      while (baseIdx > 0) {
        const r = versions[baseIdx].recipe;
        if (r?.tool !== 'edit_media' || !DERIVATIVE_OPS.has(r.operation)) break;
        baseIdx = Number.isInteger(r.base_version) ? r.base_version : baseIdx - 1;
      }
    }
    if (baseIdx !== null && versions[baseIdx]?.file) {
      assets[0] = { ...target, file: versions[baseIdx].file, kind: versions[baseIdx].kind || target.kind };
      recipe.base_version = baseIdx;
    }
    updateAsset(p, target.id, { status: 'generating', progress: 0, detail: `${label}…` });
    ctx.step({ label: `${label}: "${target.title}"`, assetIds: [target.id] });
    try {
      let file;
      try {
        file = await editMedia(op, assets, opts, ctx.signal);
      } catch (error) {
        if (!(error instanceof NoChange)) throw error;
        updateAsset(p, target.id, { status: 'ready', detail: '', progress: 1 }, { persist: true });
        return { label: `Nada a mudar em "${target.title}"`, assetIds: [target.id], result: { ok: true, unchanged: true, reason: error.message } };
      }
      const fileRef = { filename: file.filename, subfolder: file.subfolder, type: file.type };
      if (file.kind !== target.kind) {
        // Mudou de tipo (ex.: vídeo → gif/mp3): vira um card novo ligado ao original.
        updateAsset(p, target.id, { status: 'ready', detail: '', progress: 1 });
        const a = addAsset(p, { kind: file.kind, title: args.title || `${target.title} (${label.toLowerCase()})`, file: fileRef, recipe, origin: op }, [target.id]);
        saveProject(p);
        const { checks, warnings } = await inspectAll([a], { expect });
        return { label: `${label}: "${target.title}"`, assetIds: [a.id], warnings, result: { ok: true, asset: describeAsset(a), checks, warnings } };
      }
      const baseNote = Number.isInteger(recipe.base_version) && recipe.base_version !== (target.versions?.length ?? 1) - 1 ? ` (a partir da v${recipe.base_version + 1})` : '';
      const a = addVersion(p, target.id, { file: fileRef, kind: file.kind, recipe, seeds: target.seeds, prompt: target.prompt, workflow: target.workflow, note: (args.note || label.toLowerCase()) + baseNote });
      saveProject(p);
      const { checks, warnings } = await inspectAll([a], { expect });
      return {
        label: `${label}: "${target.title}" (versão ${a.versions.length}${baseNote})`,
        assetIds: [a.id],
        warnings,
        result: { ok: true, asset: describeAsset(a), based_on_version: Number.isInteger(recipe.base_version) ? recipe.base_version + 1 : undefined, checks, warnings },
      };
    } catch (error) {
      updateAsset(p, target.id, { status: 'ready', detail: '', progress: 1 }, { persist: true });
      throw error;
    }
  }

  const outKind = op === 'extract_audio' ? 'audio' : assets[0].kind;
  const title = args.title || { concat_videos: 'Vídeos juntos', add_audio: 'Vídeo com áudio', extract_audio: 'Áudio extraído' }[op] || `${assets[0].title} (${label.toLowerCase()})`;
  const placeholder = addAsset(p, { kind: outKind, title, status: 'generating', detail: `${label}…`, origin: op }, assets.map((a) => a.id));
  saveProject(p);
  ctx.step({ label: `${label}…`, assetIds: [placeholder.id] });
  try {
    let file;
    try {
      file = await editMedia(op, assets, opts, ctx.signal);
    } catch (error) {
      if (!(error instanceof NoChange)) throw error;
      removeAsset(p, placeholder.id);
      saveProject(p);
      return { label: 'Nada a mudar', result: { ok: true, unchanged: true, reason: error.message } };
    }
    const fileRef = { filename: file.filename, subfolder: file.subfolder, type: file.type };
    updateAsset(p, placeholder.id, { status: 'ready', detail: '' });
    const a = addVersion(p, placeholder.id, { file: fileRef, kind: file.kind, recipe, note: 'original' });
    saveProject(p);
    const { checks, warnings } = await inspectAll([a], { expect });
    return { label: `${label}: "${title}"`, assetIds: [a.id], warnings, result: { ok: true, asset: describeAsset(a), checks, warnings } };
  } catch (error) {
    updateAsset(p, placeholder.id, { status: 'error', error: error.message, detail: '' }, { persist: true });
    throw error;
  }
}

/**
 * Executa uma ferramenta.
 * ctx = { project, signal, step(patch) }  — step atualiza o passo no chat.
 */
export async function runTool(name, args, ctx) {
  const p = ctx.project;
  switch (name) {
    case 'list_workflows': {
      const out = [];
      for (const w of await comfy.listWorkflows()) {
        try {
          out.push(workflowSummary(await describeByName(w.name)));
        } catch (e) {
          out.push({ name: w.name, unavailable: e.message });
        }
      }
      return { label: `Consultou ${out.length} workflows do ComfyUI`, result: { workflows: out } };
    }

    case 'get_workflow': {
      const d = await describeByName(args.name);
      return { label: `Leu o workflow ${d.title}`, result: workflowDetail(d) };
    }

    case 'run_workflow':
      return generate(ctx, { name: args.name, values: args.values, inputs: args.inputs, allowDefault: args.allow_default_inputs, title: args.title });

    case 'revise_asset': {
      const a = findAsset(p, args.asset_id);
      if (a.status === 'generating') throw new Error('Esse card ainda está gerando');
      const r = a.recipe;
      if (r?.tool === 'edit_media') {
        // Refaz a edição com outras opções, a partir dos mesmos arquivos de origem.
        return edit(ctx, { operation: r.operation, asset_ids: r.inputs, ...r.options, ...(args.values || {}), as_version: false, note: args.note });
      }
      if (r?.tool !== 'run_workflow') throw new Error('Esse card não foi gerado por workflow (é upload ou texto). Use edit_media para editar a mídia.');
      return generate(ctx, {
        name: r.workflow,
        values: { ...(r.values || {}), ...(args.values || {}) },
        inputs: { ...(r.inputs || {}), ...(args.inputs || {}) },
        allowDefault: r.allow_default_inputs,
        reviseId: a.id,
        note: args.note,
      });
    }

    case 'edit_media':
      return edit(ctx, args);

    case 'media_info': {
      const a = findAsset(p, args.asset_id);
      if (!a.file) throw new Error('Esse card não tem arquivo de mídia');
      const check = await inspect(a);
      return { label: `Leu as informações de "${a.title}"`, result: check };
    }

    case 'select_version': {
      const a = findAsset(p, args.asset_id);
      const idx = Number(args.version) - 1;
      selectVersion(p, a.id, idx);
      saveProject(p);
      return { label: `Voltou "${a.title}" para a versão ${idx + 1}`, assetIds: [a.id], result: { ok: true, asset: describeAsset(a) } };
    }

    case 'create_text': {
      const based = (args.based_on || []).filter((id) => p.assets.some((a) => a.id === id));
      const a = addAsset(p, { kind: 'text', title: args.title, text: args.text }, based);
      saveProject(p);
      return { label: `Escreveu "${args.title}"`, assetIds: [a.id], result: { ok: true, asset: describeAsset(a) } };
    }

    case 'update_text': {
      const a = findAsset(p, args.asset_id);
      if (a.kind !== 'text') throw new Error('Esse card não é texto');
      a.versions = a.versions?.length ? a.versions : [{ id: 'v1', createdAt: a.createdAt, note: 'original', text: a.text }];
      a.versions.push({ id: `v${a.versions.length + 1}`, createdAt: Date.now(), note: 'reescrito', text: args.text });
      a.current = a.versions.length - 1;
      updateAsset(p, a.id, { text: args.text }, { persist: true });
      return { label: `Reescreveu "${a.title}"`, assetIds: [a.id], result: { ok: true, asset: describeAsset(a) } };
    }

    case 'rename_asset': {
      const a = findAsset(p, args.asset_id);
      const old = a.title;
      updateAsset(p, a.id, { title: String(args.title).slice(0, 120) }, { persist: true });
      return { label: `Renomeou "${old}" para "${a.title}"`, assetIds: [a.id], result: { ok: true } };
    }

    case 'remove_asset': {
      const a = findAsset(p, args.asset_id);
      removeAsset(p, a.id);
      saveProject(p);
      return { label: `Removeu "${a.title}" do canvas`, result: { ok: true } };
    }

    case 'list_assets':
      return { label: 'Consultou os itens do projeto', result: { assets: p.assets.map(describeAsset) } };

    case 'read_text': {
      const a = findAsset(p, args.asset_id);
      if (a.kind !== 'text') throw new Error('Esse asset não é texto');
      return { label: `Leu "${a.title}"`, result: { id: a.id, title: a.title, text: a.text } };
    }

    case 'ask_user':
      return {
        label: 'Pergunta',
        question: { question: args.question, options: (args.options || []).slice(0, 4) },
        endTurn: true,
        result: { ok: true, note: 'Pergunta mostrada ao usuário. Aguarde a resposta dele.' },
      };

    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

export { emit };
