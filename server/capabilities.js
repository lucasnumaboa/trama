// Capacidades do Trama: cada categoria (criar imagem, editar vídeo, música…) tem
// uma lista limitada de modelos. Cada modelo é um workflow salvo no ComfyUI.
// Os padrões escolhidos e os modelos adicionados pelo usuário ficam em
// data/capabilities.json. Para adicionar um modelo novo, use o botão nas
// Configurações (ou acrescente uma linha em BUILTIN para deixar fixo no código).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './settings.js';

const FILE = path.join(DATA_DIR, 'capabilities.json');

export const CATEGORIES = [
  { id: 'image_create', label: 'Criar imagem', description: 'Texto para imagem' },
  { id: 'image_edit', label: 'Editar imagem', description: 'Muda uma imagem por instrução' },
  { id: 'image_upscale', label: 'Ampliar imagem', description: 'Aumenta a resolução da imagem' },
  { id: 'image_background', label: 'Remover fundo', description: 'Recorta o objeto e deixa o fundo transparente' },
  { id: 'video_create', label: 'Criar vídeo', description: 'Texto, imagem ou referências para vídeo' },
  { id: 'video_edit', label: 'Editar vídeo', description: 'Ampliar vídeo, trocar personagem, trocar só o rosto, sincronizar a boca com um áudio (e edições rápidas com ffmpeg)' },
  { id: 'music_create', label: 'Criar música', description: 'Música com ou sem voz a partir de texto' },
  { id: 'voice_edit', label: 'Edição de voz', description: 'Troca a voz de um áudio pela voz de referência' },
  { id: 'model3d_create', label: 'Criar modelo 3D', description: 'Imagem de um objeto ou personagem para modelo 3D com textura (GLB)' },
  { id: 'model3d_rig', label: 'Esqueleto 3D (rig)', description: 'Põe esqueleto e pesos num modelo 3D (pessoa, bicho, monstro) para animar: GLB e FBX' },
  { id: 'model3d_animate', label: 'Animar modelo 3D', description: 'Anima um modelo 3D com esqueleto humanoide: qualquer movimento descrito em texto (soco, dança, cambalhota) ou andar, correr, pular e parado em loop (GLB que toca a animação e FBX)' },
];

// [categoria, workflow, nome exibido]
const BUILTIN = [
  ['image_create', 'trama_imagem_z_image_turbo.json', 'Z-Image Turbo (rápido, fotorrealista)'],
  ['image_create', 'trama_imagem_qwen_image.json', 'Qwen-Image (melhor para texto escrito)'],
  ['image_create', 'trama_imagem_flux2_klein.json', 'Flux.2 Klein 4B (rápido, ilustração)'],
  ['image_create', 'trama_imagem_ernie_turbo.json', 'ERNIE Image Turbo'],
  ['image_create', 'trama_imagem_newbie.json', 'NewBie (anime)'],
  ['image_create', 'imagem_anima_3090.json', 'Anima (ilustração)'],
  ['image_edit', 'trama_editar_imagem_qwen_2_1.json', 'Qwen Image 2.1 (uma imagem)'],
  ['image_edit', 'trama_editar_imagem_qwen_2_1_referencia.json', 'Qwen Image 2.1 (duas imagens: juntar pessoas, roupa, produto)'],
  ['image_edit', 'trama_editar_imagem_qwen_2511.json', 'Qwen-Image-Edit 2511'],
  ['image_edit', 'trama_editar_imagem_flux2_klein.json', 'Flux.2 Klein 4B (edição)'],
  ['image_edit', 'z_image_turbo_img2img_3090.json', 'Z-Image Turbo img2img (refazer a partir da imagem)'],
  ['image_upscale', 'trama_ampliar_imagem.json', 'RealESRGAN 4x (imagem)'],
  ['image_background', 'trama_remover_fundo.json', 'BiRefNet'],
  ['video_create', 'trama_video_h3_texto.json', 'MiniMax H3 (texto → vídeo, com som)'],
  ['video_create', 'trama_video_h3_imagem.json', 'MiniMax H3 (imagem → vídeo, com som)'],
  ['video_create', 'trama_h3_primeiro_ultimo_quadro.json', 'MiniMax H3 (primeiro + último quadro; animar logo sem deformar)'],
  ['video_create', 'trama_video_h3_referencia.json', 'MiniMax H3 (referências → vídeo, com som)'],
  ['video_create', 'trama_video_ltx23_texto.json', 'LTX-2.3 (texto → vídeo, com som)'],
  ['video_create', 'trama_video_ltx23_imagem.json', 'LTX-2.3 (imagem → vídeo, com som)'],
  ['video_create', 'trama_video_wan22_imagem.json', 'Wan 2.2 (imagem → vídeo, sem som)'],
  ['video_create', 'trama_video_wan22_quadros.json', 'Wan 2.2 (primeiro + último quadro, sem som)'],
  ['video_edit', 'trama_ampliar_video.json', 'RealESRGAN 4x (ampliar vídeo)'],
  ['video_edit', 'h3_troca_personagem_3090.json', 'MiniMax H3 (trocar personagem no vídeo)'],
  ['video_edit', 'trama_face_swap_video.json', 'ReActor (face swap: troca só o rosto pelo de uma foto, mantém o som)'],
  ['video_edit', 'trama_lip_sync_video.json', 'LatentSync 1.6 (lip sync: a boca do vídeo acompanha um áudio novo)'],
  ['music_create', 'trama_musica_com_voz_ace_step.json', 'ACE-Step 1.5 XL Turbo (com voz, melhor qualidade)'],
  ['music_create', 'trama_musica_ace_step_aio.json', 'ACE-Step 1.5 Turbo AIO (com voz, mais leve)'],
  ['music_create', 'stable_audio3_otimizado_3090.json', 'Stable Audio 3 (instrumental e efeitos)'],
  ['music_create', 'trama_editar_trecho_musica.json', 'ACE-Step 1.5 (trocar um trecho da letra de uma música pronta)'],
  ['voice_edit', 'trama_trocar_voz.json', 'Seed-VC (trocar voz: fala ou voz já isolada)'],
  ['voice_edit', 'trama_trocar_voz_musica.json', 'Seed-VC + separação (trocar a voz cantada de uma música completa)'],
  ['model3d_create', 'trama_3d_trellis2.json', 'TRELLIS.2 (imagem → modelo 3D, mais nítido)'],
  ['model3d_create', 'trama_3d_pixal3d.json', 'Pixal3D (segue o ângulo da foto; textura menos nítida)'],
  ['model3d_rig', 'trama_3d_rig.json', 'UniRig (qualquer personagem: humanoide com ossos do Mixamo, ou bicho e monstro)'],
  ['model3d_animate', 'trama_3d_animar.json', 'Movimento gerado no Trama (andar, correr, pular, parado em loop no lugar; esqueleto humanoide)'],
  ['model3d_animate', 'trama_3d_movimento.json', 'HY-Motion (qualquer movimento descrito em texto: soco, dança, cambalhota; esqueleto humanoide)'],
];

// Modelo padrão de fábrica de cada categoria.
const BUILTIN_DEFAULTS = {
  image_create: 'trama_imagem_z_image_turbo.json',
  image_edit: 'trama_editar_imagem_qwen_2_1.json',
  image_upscale: 'trama_ampliar_imagem.json',
  image_background: 'trama_remover_fundo.json',
  video_create: 'trama_video_h3_texto.json',
  video_edit: 'trama_ampliar_video.json',
  music_create: 'trama_musica_com_voz_ace_step.json',
  voice_edit: 'trama_trocar_voz.json',
  model3d_create: 'trama_3d_trellis2.json',
  model3d_rig: 'trama_3d_rig.json',
  model3d_animate: 'trama_3d_animar.json',
};

let store = null;
function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    store = {};
  }
  store.defaults = store.defaults && typeof store.defaults === 'object' ? store.defaults : {};
  store.extra = Array.isArray(store.extra) ? store.extra : [];
  return store;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
}

const modelId = (category, workflow) => `${category}:${workflow}`;

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function categoryExists(id) {
  return CATEGORIES.some((c) => c.id === id);
}

function modelsOf(category) {
  const builtin = BUILTIN.filter(([c]) => c === category).map(([, workflow, label]) => ({
    id: modelId(category, workflow), category, workflow, label, builtin: true,
  }));
  const extra = load().extra.filter((m) => m.category === category).map((m) => ({ ...m, builtin: false }));
  return [...builtin, ...extra];
}

/** Workflows fixos do código: [{ category, workflow, label }]. */
export const builtinWorkflows = () => BUILTIN.map(([category, workflow, label]) => ({ category, workflow, label }));

// overrides: escolhas feitas no chat para um projeto ({ categoria: id }).
// available(workflow): quando informado, só os que rodam no ComfyUI entram na escolha.
function defaultModel(category, overrides = {}, available = null) {
  const models = modelsOf(category).filter((m) => !available || available(m.workflow));
  const chosen = store.defaults[category];
  return (
    models.find((m) => m.id === overrides[category]) ||
    models.find((m) => m.id === chosen) ||
    models.find((m) => m.workflow === BUILTIN_DEFAULTS[category]) ||
    models[0] ||
    null
  );
}

/**
 * @param {object} opts
 * @param {string[]} [opts.workflowNames]  nomes dos workflows que existem no ComfyUI (null = não conferido)
 * @param {Map<string,{ok:boolean,reason:string}>} [opts.availability]  o que roda no ComfyUI (setup.js);
 *   vale mais que workflowNames: confere também nós e modelos.
 */
export function listCapabilities({ workflowNames = null, overrides = {}, availability = null } = {}) {
  load();
  const status = (workflow) => (availability ? availability.get(workflow) || { ok: false, reason: 'o workflow não está salvo no ComfyUI' } : null);
  return CATEGORIES.map((category) => {
    const def = defaultModel(category.id, overrides);
    return {
      ...category,
      defaultId: def?.id ?? null,
      globalDefaultId: defaultModel(category.id)?.id ?? null,
      models: modelsOf(category.id).map((m) => ({
        ...m,
        isDefault: m.id === def?.id,
        available: availability ? status(m.workflow).ok : workflowNames ? workflowNames.includes(m.workflow) : null,
        missing: availability && !status(m.workflow).ok ? status(m.workflow).reason : undefined,
      })),
    };
  });
}

export function setDefaultModel(category, id) {
  load();
  if (!categoryExists(category)) throw fail(`Categoria desconhecida: ${category}`);
  if (!modelsOf(category).some((m) => m.id === id)) throw fail('Esse modelo não pertence a esta categoria.');
  store.defaults[category] = id;
  save();
  return { ok: true };
}

export function addModel({ category, workflow, label }) {
  load();
  if (!categoryExists(category)) throw fail(`Categoria desconhecida: ${category}`);
  if (typeof workflow !== 'string' || !workflow.endsWith('.json')) throw fail('Escolha um workflow salvo no ComfyUI.');
  const name = String(label || '').trim().slice(0, 80);
  if (!name) throw fail('Dê um nome para o modelo.');
  const id = modelId(category, workflow);
  if (modelsOf(category).some((m) => m.id === id)) throw fail('Esse workflow já está nesta categoria.');
  store.extra.push({ id, category, workflow, label: name });
  save();
  return { id };
}

export function removeModel(id) {
  load();
  const found = store.extra.find((m) => m.id === id);
  if (!found) throw fail('Só dá para remover os modelos que você adicionou.');
  store.extra = store.extra.filter((m) => m.id !== id);
  if (store.defaults[found.category] === id) delete store.defaults[found.category];
  save();
  return { ok: true };
}

/** Confere se um id de modelo existe na categoria. */
export function modelInCategory(category, id) {
  load();
  return categoryExists(category) && modelsOf(category).some((m) => m.id === id);
}

/** Nome do workflow padrão de uma categoria (ou null). */
export function defaultWorkflow(category) {
  load();
  return defaultModel(category)?.workflow ?? null;
}

/**
 * Texto que vai para o prompt do agente: padrão de cada categoria e as outras opções.
 * Com availability, o que não roda no ComfyUI do usuário sai das opções (o padrão vira o
 * primeiro que roda) e aparece só numa lista de indisponíveis, para o agente não oferecer.
 */
export function capabilityPromptBlock(overrides = {}, availability = null) {
  load();
  const ok = availability ? (w) => Boolean(availability.get(w)?.ok) : null;
  const lines = CATEGORIES.map((category) => {
    const models = modelsOf(category.id).filter((m) => !ok || ok(m.workflow));
    const def = defaultModel(category.id, overrides, ok);
    const others = models.filter((m) => m.id !== def?.id).map((m) => `${m.label} (${m.workflow})`);
    if (!def) {
      return availability
        ? `- ${category.label}: nenhum modelo instalado no ComfyUI do usuário. Não ofereça; diga que dá para instalar em Configurações → Preparar ComfyUI.`
        : `- ${category.label}: nenhum modelo configurado.`;
    }
    return `- ${category.label}: padrão "${def.label}" (workflow ${def.workflow})${others.length ? `. Outras opções, só se o usuário pedir: ${others.join('; ')}` : ''}.`;
  });
  if (availability) {
    const missing = CATEGORIES.flatMap((c) => modelsOf(c.id)).filter((m) => !ok(m.workflow));
    const seen = new Set();
    const items = missing.filter((m) => !seen.has(m.workflow) && seen.add(m.workflow)).map((m) => `${m.workflow} (${availability.get(m.workflow)?.reason || 'não está no ComfyUI'})`);
    if (items.length) lines.push(`Indisponíveis no ComfyUI do usuário (não ofereça nem rode; se ele pedir, diga o que falta e que instala em Configurações → Preparar ComfyUI): ${items.join('; ')}.`);
  }
  return lines.join('\n');
}
