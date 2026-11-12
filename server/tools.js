// Ferramentas que o agente pode chamar. Cada uma devolve um objeto JSON
// (vai para o modelo) e um rótulo curto (vai para o chat).
import * as comfy from './comfy.js';
import { describeByName, runWorkflow } from './exec.js';
import { editMedia, mediaInfo, OPERATIONS, SINGLE_INPUT_OPS, NoChange } from './media.js';
import { readImage, readVideo, readPeople, findPerson, describeCharacter } from './vision.js';
import { reviewGeneration } from './review.js';
import { getSettings } from './settings.js';
import { swapVideo, planChunks, matchPerson, DEFAULT_CHUNK, MAX_CHUNK, SWAP_WORKFLOW } from './swap.js';
import { castOf, findCharacter, upsertCharacter, removeCharacter, mentionedCharacters, placeCharacters } from './cast.js';
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
        characters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nomes do elenco (define_character) que aparecem nesta geração. O Trama põe a foto de cada um nas referências do workflow (slots livres e referências extras) e escreve a ficha física no prompt. No prompt, cite cada um como @Nome e descreva só ação, pose, expressão e câmera.',
        },
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
        characters: { type: 'array', items: { type: 'string' }, description: 'Trocar os personagens do elenco da cena (sem isso, os mesmos da receita).' },
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
    name: 'define_character',
    description:
      'Registra (ou atualiza, pelo nome) um personagem fixo do projeto a partir da foto dele. O modelo de visão escreve uma ficha física travada (altura e proporções, corpo, rosto, orelhas, cabelo, barba, óculos, roupa, objetos). Depois, passe o nome em characters em toda geração em que ele aparece. Registre cada personagem uma vez, antes de escrever as cenas. Confira a ficha devolvida: se algo estiver errado ou faltando (ex.: o usuário diz que ele é baixinho), registre de novo com notes.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome curto e único, sem espaços de preferência (ex.: "Kenji")' },
        asset_id: { type: 'string', description: 'Card da imagem do personagem' },
        focus: { type: 'string', description: 'Qual pessoa da imagem, se tiver mais de uma (em inglês, ex.: "the man with the pipe")' },
        notes: { type: 'string', description: 'Fatos físicos que valem mais que a visão, em inglês (ex.: "very short, about 1.2 m tall, pointed ears")' },
      },
      required: ['name', 'asset_id'],
    },
  },
  {
    name: 'remove_character',
    description: 'Tira um personagem do elenco do projeto.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'look_at',
    description:
      'Olha uma imagem ou um vídeo do projeto com um modelo de visão e devolve o que tem nela: cada pessoa (posição, idade, cabelo, roupa, o que faz, papel provável), o lugar, a luz e o enquadramento. A descrição fica guardada no card. As imagens anexadas pelo usuário já chegam descritas na mensagem: não chame look_at nelas (cada leitura leva 1 a 2 minutos de GPU). Use em imagens e vídeos gerados, para conferir se saíram como pedido (no vídeo ele olha três quadros: início, meio e fim, e lista defeitos como rosto que muda), ou com refresh quando o card ganhou nova versão.',
    parameters: { type: 'object', properties: { asset_id: { type: 'string' }, refresh: { type: 'boolean', description: 'true para olhar de novo (ex.: a imagem ganhou nova versão)' } }, required: ['asset_id'] },
  },
  {
    name: 'video_people',
    description:
      'Descobre quem aparece num vídeo: o modelo de visão olha seis quadros e devolve cada pessoa distinta (P1, P2…) com um rótulo em inglês para usar no prompt, aparência, onde fica no quadro e o que faz. Também põe no canvas uma imagem com os seis quadros, para o usuário ver de quem se fala. Use antes de swap_character. Se o usuário apontou quem sai com uma foto (print do vídeo ou recorte da pessoa), passe essa foto em match_photo_id: o modelo de visão compara a foto com os quadros e diz qual pessoa do vídeo é ela (match).',
    parameters: {
      type: 'object',
      properties: {
        asset_id: { type: 'string', description: 'Card do vídeo' },
        match_photo_id: { type: 'string', description: 'Card da foto de quem o usuário apontou no vídeo (quem sai), para achar essa pessoa entre as do vídeo' },
        refresh: { type: 'boolean' },
      },
      required: ['asset_id'],
    },
  },
  {
    name: 'swap_character',
    description:
      `Troca pessoas de um vídeo pelas pessoas das fotos (workflow ${SWAP_WORKFLOW}: MiniMax H3 com a LoRA de troca de personagem). Mantém câmera, fundo, luz, movimento, falas e as outras pessoas; o som é o do vídeo original. Vídeos maiores que o bloco (padrão ${DEFAULT_CHUNK} s, até ${MAX_CHUNK} s) são cortados em blocos e cada bloco usa a mesma foto, o mesmo prompt e a mesma seed, para o personagem novo ficar igual do começo ao fim. Várias trocas no mesmo vídeo: passe todas em swaps; elas rodam uma depois da outra. Demora: cerca de 25 a 40 min por bloco por troca.`,
    parameters: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'Card do vídeo de origem' },
        swaps: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Quem sai, em inglês, como o rótulo do video_people (ex.: "the bald man in the blue apron")' },
              photo_id: { type: 'string', description: 'Card da foto de quem entra' },
              character: { type: 'string', description: 'Ou o nome de um personagem do elenco (usa a foto e a ficha dele)' },
            },
            required: ['target'],
          },
        },
        chunk_seconds: { type: 'number', description: `Tamanho máximo de cada bloco, 2 a ${MAX_CHUNK} s (padrão ${DEFAULT_CHUNK})` },
        fidelity: { type: 'string', enum: ['match', 'max'], description: '"max" segura melhor o rosto da foto, mas fica bem mais lento. Padrão "match".' },
        seed: { type: 'number', description: 'Opcional; sem ela o Trama sorteia uma e usa a mesma em todos os blocos' },
        title: { type: 'string' },
      },
      required: ['video_id', 'swaps'],
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
      'Mostra ao usuário um briefing com 1 a 6 perguntas, cada uma com opções clicáveis (sua recomendação primeiro) e campo livre, e encerra sua vez até ele responder. Use para propor ideias e fechar decisões criativas antes de gerar: roteiro e cenas, duração, formato, estilo, música, falas, idioma. Junte tudo num briefing só em vez de perguntar uma coisa por vez.',
    parameters: {
      type: 'object',
      properties: {
        intro: { type: 'string', description: 'Uma ou duas frases antes das perguntas (ex.: a ideia que você teve para a história).' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, description: '2 a 5 opções concretas e curtas; a primeira é a sua recomendação' },
              multiple: { type: 'boolean', description: 'true se o usuário pode marcar várias opções (ex.: quais cenas extras incluir)' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
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
      if (d.name === SWAP_WORKFLOW) {
        // A troca roda pela ferramenta própria (blocos, 24 fps, seed fixa, som original).
        lines.push(`- ${d.name}: troca uma pessoa de um vídeo pela pessoa de uma foto. Não chame com run_workflow: use video_people e swap_character.`);
        continue;
      }
      lines.push(`- ${d.name}: ${ins} → ${outs}. ${refCapacity(d)}${about ? ` ${about}` : ''}`);
    } catch (e) {
      lines.push(`- ${w.name}: indisponível (${clip(e.message, 120)})`);
    }
  }
  catalogCache = { at: Date.now(), text: lines.join('\n') };
  return catalogCache.text;
}

// Quantos personagens/fotos de referência cabem numa geração: o agente escolhe o
// workflow certo de primeira em vez de descobrir o limite errando.
function refCapacity(d) {
  const n = d.references?.maxImages || 0;
  if (!n) return 'Sem foto de referência: não serve para personagens do elenco.';
  // Referência de verdade: lista crescente (H3) ou notas que citam <Picture 1>/<image1>.
  // Senão as imagens são quadros/base (primeiro e último quadro, imagem a editar).
  const cites = /<\s*(picture|image)\s*1\s*>/i.test(d.notes.join(' '));
  if (!d.references.grow && !cites) {
    return `Recebe ${n === 1 ? '1 imagem' : `${n} imagens`} como quadro/base, não como foto de referência de personagem.`;
  }
  return n === 1 ? 'Cabe 1 foto de referência (1 personagem).' : `Cabem até ${n} fotos de referência (até ${n} personagens).`;
}

function workflowSummary(d) {
  return {
    name: d.name,
    about: clip(d.notes.join(' ').replace(/\s+/g, ' ').replace(/[#*`]/g, ''), 280) || undefined,
    media_inputs: d.mediaInputs.map((m) => ({ slot: m.id, kind: m.kind, title: m.title })),
    max_reference_images: d.references?.maxImages || 0,
    prompt_field: promptField(d)?.id,
    text_fields: d.fields.filter((f) => f.kind === 'text' && !f.internal).map((f) => ({ id: f.id, node: f.nodeTitle })),
    outputs: [...new Set(d.outputs.map((o) => o.kind))],
  };
}

// Campo de duração do resultado (segundos), quando o workflow tem um.
export function durationField(d) {
  return d.fields.find((f) => f.kind === 'number' && /dura[cç][aã]o|duration|seconds?|segundos/i.test(`${f.label} ${f.nodeTitle} ${f.input}`));
}

// O campo de texto principal: o prompt positivo (não o negativo nem um prompt de sistema).
export function promptField(d) {
  const texts = d.fields.filter((f) => f.kind === 'text' && !f.internal && !/negative|negativ/i.test(`${f.input} ${f.nodeTitle}`));
  return texts.find((f) => /(^|\.)(prompt|text|value)$/.test(f.input)) || texts[0];
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
    max_reference_images: d.references?.maxImages || 0,
    reference_capacity: refCapacity(d),
    main_fields: d.fields.filter((f) => f.basic).map(field),
    other_fields: d.fields
      .filter((f) => !f.basic)
      .filter((f) => !f.internal)
      .map((f) => ({
        id: f.id, label: f.label, node: f.nodeTitle, default: typeof f.default === 'string' ? clip(f.default, 80) : f.default,
        ...(f.kind === 'combo' && f.options?.length <= 25 ? { options: f.options } : {}),
      })),
    // Campo onde vai a instrução/descrição do usuário (o padrão é só o exemplo do template).
    prompt_field: promptField(d)?.id,
    duration_field: (() => {
      const f = durationField(d);
      return f ? { id: f.id, default: f.default, min: f.min, max: f.max } : undefined;
    })(),
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

// O agente às vezes abrevia o slot ("media", "137", o título do nó). Resolve para o
// id certo quando não há dúvida; senão o erro de slot inexistente lista os válidos.
export function resolveSlots(p, d, inputs = {}) {
  const valid = (k) => d.mediaInputs.some((m) => m.id === k);
  const used = new Set(Object.keys(inputs).filter(valid));
  const out = {};
  for (const [slot, assetId] of Object.entries(inputs)) {
    if (valid(slot)) {
      out[slot] = assetId;
      continue;
    }
    const kind = p.assets.find((x) => x.id === assetId)?.kind;
    const key = String(slot).trim().toLowerCase();
    const free = d.mediaInputs.filter((m) => !used.has(m.id) && (!kind || m.kind === kind));
    const byTitle = free.filter((m) => m.title?.toLowerCase() === key);
    const hit =
      free.find((m) => m.nodeId === key.replace(/^media:/, '')) ||
      (byTitle.length === 1 ? byTitle[0] : undefined) ||
      (/^(media|image|imagem|video|vídeo|audio|áudio|input|entrada)$/.test(key) ? free[0] : undefined) ||
      // Slot de outro workflow (ex.: "media:7" do H3 num workflow que só tem "media:470"):
      // com uma única entrada livre do mesmo tipo não há dúvida.
      (kind && free.length === 1 ? free[0] : undefined);
    if (!hit) {
      out[slot] = assetId; // o erro normal explica e lista os slots
      continue;
    }
    used.add(hit.id);
    out[hit.id] = assetId;
  }
  return out;
}

// Mesmo hábito nos campos: "prompt" ou "8.prompt" (id de outro workflow) em vez do
// id deste. Vai para o campo certo quando só existe um candidato; o resto fica como veio.
const PROMPT_ALIAS = /^(prompt|text|texto|positive|positive_prompt|instruction|instrucao|instrução)$/;
export function resolveValues(d, values = {}) {
  const ids = new Set(d.fields.map((f) => f.id));
  const out = {};
  for (const [k, v] of Object.entries(values)) if (ids.has(k)) out[k] = v;
  const pf = promptField(d);
  for (const [k, v] of Object.entries(values)) {
    if (ids.has(k)) continue;
    const input = String(k).trim().replace(/^[\d:]+\./, '').toLowerCase();
    let target;
    if (pf && PROMPT_ALIAS.test(input)) target = pf.id;
    else {
      const same = d.fields.filter((f) => !f.internal && f.input.toLowerCase() === input);
      if (same.length === 1) target = same[0].id;
    }
    if (target && !(target in out)) out[target] = v;
    else out[k] = v;
  }
  return out;
}

const findAsset = (p, id) => {
  const a = p.assets.find((x) => x.id === id);
  if (!a) throw new Error(`Asset "${id}" não existe neste projeto. Use list_assets.`);
  return a;
};

// ---- Geração (nova ou como versão) -------------------------------------------
async function generate(ctx, { name, values = {}, inputs = {}, characters = [], allowDefault = false, title, reviseId, note }) {
  const p = ctx.project;
  const d = await describeByName(name);
  const media = {};
  const inputIds = [];
  inputs = resolveSlots(p, d, inputs);
  values = resolveValues(d, values);
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
  // Sem a instrução, o workflow roda com o texto de exemplo do template e devolve
  // sempre a mesma coisa (ex.: "Replace costumes for the character").
  const pf = promptField(d);
  if (pf && !allowDefault && !String(resolved[pf.id] ?? '').trim()) {
    throw new Error(`Falta a instrução: passe o texto em values["${pf.id}"] (${pf.nodeTitle}). Sem ele o workflow usa o exemplo do template "${clip(String(pf.default || ''), 60)}".`);
  }

  // Elenco: a foto de cada personagem vira referência e a ficha dele entra no prompt.
  let extraRefs = [];
  const notices = [];
  let cast = (characters || []).map((n) => {
    const c = findCharacter(p, n);
    if (!c) throw new Error(`"${n}" não está no elenco. Elenco: ${castOf(p).map((x) => x.name).join(', ') || 'vazio'}. Registre com define_character.`);
    return { ...c, asset: findAsset(p, c.assetId) };
  });
  // Personagem do elenco citado no prompt sem estar em characters: entra sozinho
  // (antes era um erro, e o agente gastava uma rodada para repetir a chamada).
  const autoCast = pf && d.references?.maxImages
    ? mentionedCharacters(p, String(resolved[pf.id] ?? ''))
        .filter((c) => !cast.some((x) => x.id === c.id))
        .map((c) => ({ ...c, asset: findAsset(p, c.assetId) }))
    : [];
  if (cast.length || autoCast.length) {
    if (!pf) throw new Error(`O workflow ${d.name} não tem campo de prompt para descrever os personagens.`);
    const names = (list) => list.map((c) => c.name).join(', ');
    let placed = null;
    try {
      placed = placeCharacters(d, inputs, [...cast, ...autoCast], resolved[pf.id]);
      if (autoCast.length) notices.push(`O prompt cita ${names(autoCast)}, do elenco: o Trama pôs a foto e a ficha como referência. Da próxima vez passe em characters.`);
      cast = [...cast, ...autoCast];
    } catch (error) {
      // Não coube com os citados: segue com os pedidos em characters (se nem eles
      // cabem, o erro vale) e avisa que o citado sai só pelo texto.
      if (!autoCast.length) throw error;
      if (cast.length) placed = placeCharacters(d, inputs, cast, resolved[pf.id]);
      notices.push(`O prompt cita ${names(autoCast)}, do elenco, mas não sobrou referência de imagem para a foto: sai só pelo texto e pode mudar de cara.`);
    }
    if (placed) {
      for (const [slot, a] of Object.entries(placed.slots)) media[slot] = a.file;
      extraRefs = placed.extra.map((a) => a.file);
      resolved[pf.id] = placed.prompt;
      for (const c of cast) inputIds.push(c.asset.id);
    }
  }

  const missing = d.mediaInputs.filter((m) => !media[m.id]);
  if (missing.length && !allowDefault) {
    throw new Error(`Faltam entradas: ${missing.map((m) => `${m.id} (${KIND_PT[m.kind]}: "${m.title}")`).join(', ')}. Passe assets do projeto, ou peça ao usuário. Se este workflow não combina com o pedido, use outro.`);
  }
  const mainText = (pf && resolved[pf.id]) || d.fields.filter((f) => f.kind === 'text' && !f.internal).map((f) => resolved[f.id] ?? f.default).find((t) => t && String(t).trim());
  const kind = d.outputs[0]?.kind || 'image';
  const recipe = { tool: 'run_workflow', workflow: d.name, values, inputs, ...(cast.length ? { characters: cast.map((c) => c.name) } : {}), ...(allowDefault ? { allow_default_inputs: true } : {}) };

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
      extraRefs,
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
    const durField = durationField(d);
    const asked = durField ? Number(resolved[durField.id] ?? durField.default) : undefined;
    const { checks, warnings } = await inspectAll(created, { expect: Number.isFinite(asked) && asked > 0 ? { duration: asked } : {} });
    const review = await triage(ctx, created[0], { request: mainText, characters: cast.map((c) => c.name), check: checks.find((c) => c.id === created[0]?.id) });
    if (review?.problems?.length) warnings.push(...review.problems.map((x) => `Triagem de "${created[0].title}": ${x}`));
    return {
      label,
      assetIds: created.map((a) => a.id),
      warnings,
      result: { ok: true, created: created.map(describeAsset), seeds, checks, warnings, ...(review ? { review } : {}), ...(notices.length ? { notes: notices } : {}) },
    };
  } catch (error) {
    if (reviseId) updateAsset(p, target.id, { status: target.file ? 'ready' : previous.status, error: target.file ? undefined : previous.error, detail: '', progress: 1 }, { persist: true });
    else updateAsset(p, target.id, { status: 'error', error: error.message, detail: '' }, { persist: true });
    throw error;
  }
}

// ---- Triagem -------------------------------------------------------------------
/**
 * Confere se a imagem/vídeo gerado bate com o pedido (visão local + DeepSeek). Não
 * derruba a geração: se a triagem falhar, devolve { skipped } e segue.
 */
async function triage(ctx, asset, { request, characters, check }) {
  if (!asset || !['image', 'video'].includes(asset.kind) || getSettings().reviewGenerations === false) return null;
  const p = ctx.project;
  updateAsset(p, asset.id, { detail: 'Conferindo se saiu como pedido' });
  try {
    const r = await reviewGeneration(asset, { request, characters, width: check?.width, height: check?.height, signal: ctx.signal });
    updateAsset(p, asset.id, { detail: '', vision: r.seen, review: { ok: r.ok, problems: r.problems, minor: r.minor } }, { persist: true });
    return {
      ok: r.ok,
      problems: r.problems,
      ...(r.minor?.length
        ? { minor: r.minor, minor_note: 'Problemas menores: a cena serve. Mencione ao usuário em meia frase; refaça só se ele pedir ou se atrapalhar a próxima cena.' }
        : {}),
      seen: clip(r.seen, 900),
      ...(r.ok ? {} : { next: 'A triagem reprovou: conte ao usuário o que saiu errado e refaça com revise_asset corrigindo o prompt (ex.: deixar claro quantas pessoas, cada personagem uma vez, o formato) antes de usar esse card em outra cena.' }),
    };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    updateAsset(p, asset.id, { detail: '' });
    return { skipped: `a triagem não rodou: ${error.message}` };
  }
}

// ---- Troca de personagem em vídeo ---------------------------------------------
async function swapCharacter(ctx, args, { reviseId, note } = {}) {
  const p = ctx.project;
  const video = findAsset(p, args.video_id);
  if (video.kind !== 'video' || !video.file) throw new Error('video_id precisa ser um card de vídeo.');
  if (video.status === 'generating') throw new Error('Esse vídeo ainda está gerando.');
  const swaps = (args.swaps || []).map((s, i) => {
    const target = String(s.target || '').trim();
    if (!target) throw new Error(`Troca ${i + 1}: diga quem sai do vídeo (target).`);
    if (s.character) {
      const c = findCharacter(p, s.character);
      if (!c) throw new Error(`"${s.character}" não está no elenco. Elenco: ${castOf(p).map((x) => x.name).join(', ') || 'vazio'}.`);
      const a = findAsset(p, c.assetId);
      return { target, photo: a.file, photoId: a.id, brief: c.brief, label: c.name };
    }
    if (!s.photo_id) throw new Error(`Troca ${i + 1}: passe photo_id (a foto de quem entra) ou character.`);
    const a = findAsset(p, s.photo_id);
    if (a.kind !== 'image' || !a.file) throw new Error(`Troca ${i + 1}: ${s.photo_id} não é uma imagem.`);
    return { target, photo: a.file, photoId: a.id, brief: a.characterSheet?.brief, label: a.title };
  });
  if (!swaps.length) throw new Error('Passe ao menos uma troca em swaps.');
  // Com a lista do video_people: onde está quem sai e quem fica (vai nomeado no prompt).
  const people = video.people?.list || [];
  const targets = swaps.map((s) => matchPerson(people, s.target));
  swaps.forEach((s, i) => {
    if (targets[i]?.where) s.where = targets[i].where;
    s.others = people.filter((x) => !targets.includes(x)).map((x) => x.label);
  });
  const seed = Number.isFinite(Number(args.seed)) ? Math.round(Number(args.seed)) : Math.floor(Math.random() * 2 ** 40);
  const fidelity = args.fidelity === 'max' ? 'max' : 'match';
  const recipe = { tool: 'swap_character', args: { video_id: video.id, swaps: args.swaps, chunk_seconds: args.chunk_seconds, fidelity, seed } };
  const inputIds = [video.id, ...swaps.map((s) => s.photoId)];

  let target;
  let previous;
  if (reviseId) {
    target = findAsset(p, reviseId);
    previous = { status: target.status, error: target.error };
    updateAsset(p, target.id, { status: 'generating', progress: 0, detail: 'Preparando a troca' });
  } else {
    const title = args.title || `${video.title} — ${swaps.map((s) => s.label).join(', ')}`;
    target = addAsset(p, { kind: 'video', title, status: 'generating', progress: 0, detail: 'Preparando a troca', workflow: SWAP_WORKFLOW }, [...new Set(inputIds)]);
  }
  saveProject(p);
  const doing = `Trocando ${swaps.map((s) => s.label).join(' e ')} em "${video.title}"`;
  ctx.step({ label: doing, assetIds: [target.id] });

  let last = 0;
  try {
    const r = await swapVideo({
      source: video.file,
      swaps,
      seed,
      chunkSeconds: args.chunk_seconds,
      fidelity,
      signal: ctx.signal,
      // A estimativa aparece no passo do chat: a troca leva dezenas de minutos por bloco.
      onPlan: ({ chunks, runs }) => {
        const lo = runs * 25;
        const hi = runs * 40;
        const time = hi >= 120 ? `${Math.round(lo / 60)} a ${Math.round(hi / 60)} h` : `${lo} a ${hi} min`;
        ctx.step({ label: `${doing} · ${chunks.length === 1 ? '1 bloco' : `${chunks.length} blocos`}${swaps.length > 1 ? ` × ${swaps.length} trocas` : ''}, cerca de ${time}` });
      },
      onProgress: ({ progress, detail }) => {
        const now = Date.now();
        if (now - last < 250 && progress !== 1) return;
        last = now;
        updateAsset(p, target.id, { progress, detail });
      },
    });
    const v = { file: r.file, kind: 'video', recipe, seeds: { seed }, prompt: r.prompts.join('\n\n'), workflow: SWAP_WORKFLOW };
    let created;
    if (reviseId) created = addVersion(p, target.id, { ...v, note: note || 'troca refeita' });
    else {
      updateAsset(p, target.id, { status: 'ready', progress: 1, detail: '' });
      created = addVersion(p, target.id, { ...v, note: 'original' });
    }
    saveProject(p);
    const { checks, warnings } = await inspectAll([created], { expect: { duration: r.info.duration } });
    // Conferência: o modelo às vezes apaga quem devia sair e troca outra pessoa (ou
    // some com alguém). Conta as pessoas do resultado e compara com as do original.
    let peopleAfter;
    if (people.length) {
      try {
        updateAsset(p, created.id, { detail: 'Conferindo quem ficou no vídeo' });
        const after = await readPeople(created, { signal: ctx.signal });
        peopleAfter = after.people;
        updateAsset(p, created.id, { detail: '', people: { list: after.people, scene: after.scene } }, { persist: true });
        if (after.people.length < people.length) {
          warnings.push(`O original tem ${people.length} pessoas e o resultado tem ${after.people.length}: alguém sumiu ou foi trocado junto. Antes: ${people.map((x) => x.label).join('; ')}. Depois: ${after.people.map((x) => x.label).join('; ')}. Conte isso ao usuário e ofereça refazer.`);
        }
      } catch {
        updateAsset(p, created.id, { detail: '' });
      }
    }
    return {
      label: `Trocou ${swaps.map((s) => s.label).join(' e ')} em "${video.title}"`,
      assetIds: [created.id],
      warnings,
      result: {
        ok: true,
        created: [describeAsset(created)],
        blocks: r.chunks.length,
        block_seconds: r.chunks.map((c) => c.dur),
        seed,
        fidelity,
        format: r.aspect,
        people_before: people.map((x) => x.label),
        ...(peopleAfter ? { people_after: peopleAfter.map((x) => x.label) } : {}),
        checks,
        warnings,
        next: 'Compare people_before e people_after: diga ao usuário quem foi trocado e se alguém sumiu (não afirme que todos ficaram sem conferir). Olhe com look_at se precisar. Se o rosto mudar entre blocos, refaça com revise_asset e values {"fidelity": "max"}.',
      },
    };
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
      return generate(ctx, { name: args.name, values: args.values, inputs: args.inputs, characters: args.characters, allowDefault: args.allow_default_inputs, title: args.title });

    case 'revise_asset': {
      const a = findAsset(p, args.asset_id);
      if (a.status === 'generating') throw new Error('Esse card ainda está gerando');
      const r = a.recipe;
      if (r?.tool === 'edit_media') {
        // Refaz a edição com outras opções, a partir dos mesmos arquivos de origem.
        return edit(ctx, { operation: r.operation, asset_ids: r.inputs, ...r.options, ...(args.values || {}), as_version: false, note: args.note });
      }
      if (r?.tool === 'swap_character') {
        return swapCharacter(ctx, { ...r.args, ...(args.values || {}) }, { reviseId: a.id, note: args.note });
      }
      if (r?.tool !== 'run_workflow') throw new Error('Esse card não foi gerado por workflow (é upload ou texto). Use edit_media para editar a mídia.');
      return generate(ctx, {
        name: r.workflow,
        values: { ...(r.values || {}), ...(args.values || {}) },
        inputs: { ...(r.inputs || {}), ...(args.inputs || {}) },
        characters: args.characters || r.characters || [],
        allowDefault: r.allow_default_inputs,
        reviseId: a.id,
        note: args.note,
      });
    }

    case 'edit_media':
      return edit(ctx, args);

    case 'define_character': {
      const a = findAsset(p, args.asset_id);
      if (a.kind !== 'image' || !a.file) throw new Error('O personagem precisa de um card de imagem.');
      const name = String(args.name || '').replace(/^@/, '').trim();
      if (!name) throw new Error('Dê um nome ao personagem.');
      // A ficha já veio na leitura da imagem (fotos anexadas): não lê de novo.
      // Com focus (imagem com várias pessoas), lê de novo só a pessoa pedida.
      const cached = !args.focus && a.characterSheet;
      if (!cached) ctx.step({ label: `Lendo o físico de "${name}"`, assetIds: [a.id] });
      const { sheet, brief } = cached || (await describeCharacter(a, { focus: args.focus, signal: ctx.signal }));
      const c = upsertCharacter(p, { name, assetId: a.id, sheet, brief, notes: args.notes });
      saveProject(p);
      return {
        label: `Registrou o personagem ${c.name}`,
        assetIds: [a.id],
        result: { ok: true, character: { name: c.name, asset_id: a.id, brief: c.brief, sheet: c.sheet }, cast: castOf(p).map((x) => x.name) },
      };
    }

    case 'remove_character': {
      const c = removeCharacter(p, args.name);
      if (!c) throw new Error(`"${args.name}" não está no elenco.`);
      saveProject(p);
      return { label: `Tirou ${c.name} do elenco`, result: { ok: true, cast: castOf(p).map((x) => x.name) } };
    }

    case 'look_at': {
      const a = findAsset(p, args.asset_id);
      if (!a.file || (a.kind !== 'image' && a.kind !== 'video')) throw new Error('look_at olha imagens e vídeos; esse card não é nenhum dos dois.');
      if (a.status === 'generating') throw new Error('Esse card ainda está gerando.');
      if (a.vision && !args.refresh) {
        // Já lida: devolve a descrição guardada, sem passar pelo modelo de novo.
        return { label: `Usou a descrição que já tinha de "${a.title}"`, result: { asset_id: a.id, title: a.title, description: a.vision, cached: true } };
      }
      if (a.kind === 'video') {
        ctx.step({ label: `Olhando o vídeo "${a.title}"`, assetIds: [a.id] });
        const vision = await readVideo(a, { signal: ctx.signal });
        updateAsset(p, a.id, { vision });
        saveProject(p);
        return { label: `Olhou o vídeo "${a.title}"`, result: { asset_id: a.id, title: a.title, description: vision } };
      }
      ctx.step({ label: `Olhando "${a.title}"` });
      const r = await readImage(a, { signal: ctx.signal });
      updateAsset(p, a.id, { vision: r.vision, characterSheet: r.character || undefined });
      saveProject(p);
      return { label: `Olhou "${a.title}"`, result: { asset_id: a.id, title: a.title, description: a.vision } };
    }

    case 'video_people': {
      const a = findAsset(p, args.asset_id);
      if (a.kind !== 'video' || !a.file) throw new Error('video_people olha vídeos; esse card não é vídeo.');
      if (a.status === 'generating') throw new Error('Esse vídeo ainda está gerando.');
      let framesId = a.peopleFramesId;
      let match;
      const photo = args.match_photo_id ? findAsset(p, args.match_photo_id) : null;
      if (photo && (photo.kind !== 'image' || !photo.file)) throw new Error('match_photo_id precisa ser um card de imagem.');
      if (!a.people || args.refresh) {
        ctx.step({ label: `Vendo quem aparece em "${a.title}"`, assetIds: [a.id] });
        const r = await readPeople(a, { signal: ctx.signal });
        if (!r.people.length) throw new Error(`O modelo de visão não listou pessoas neste vídeo. Resposta: ${clip(r.raw, 300)}`);
        const frames = addAsset(p, { kind: 'image', title: `Quadros de ${a.title}`, file: r.frames, vision: r.raw }, [a.id]);
        frames.versions = [{ id: 'v1', createdAt: Date.now(), note: 'original', file: r.frames, kind: 'image' }];
        frames.current = 0;
        framesId = frames.id;
        updateAsset(p, a.id, { people: { list: r.people, scene: r.scene }, peopleFramesId: frames.id });
        saveProject(p);
      }
      const { list, scene } = a.people;
      // Foto apontada: segunda leitura, que só escolhe na lista acima (mesmos rótulos e posições).
      if (photo) {
        ctx.step({ label: `Procurando "${photo.title}" em "${a.title}"`, assetIds: [a.id, photo.id] });
        try {
          match = (await findPerson(a, photo.file, list, { signal: ctx.signal })).match;
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          match = { id: null, label: null, confidence: 'low', why: `a comparação falhou: ${error.message}` };
        }
      }
      let chunks = null;
      try {
        const info = await mediaInfo(a.file, 'video');
        chunks = planChunks(info.duration).length;
      } catch {
        /* sem duração: segue sem a estimativa */
      }
      return {
        label: `Viu ${list.length === 1 ? '1 pessoa' : `${list.length} pessoas`} em "${a.title}"`,
        assetIds: framesId ? [a.id, framesId] : [a.id],
        result: {
          asset_id: a.id,
          people: list,
          scene,
          frames_card: framesId,
          ...(chunks ? { swap_blocks: chunks } : {}),
          ...(photo ? { match: match || { id: null, label: null, why: 'o modelo não respondeu a comparação' } } : {}),
          hint: photo
            // O modelo de visão local erra essa comparação até com "confiança alta" (num teste
            // disse que o recorte de um homem magro com espada era o lutador de sumô). Uma
            // troca leva meia hora: confirma sempre, com um clique.
            ? match?.id
              ? `Sugestão do modelo de visão: a foto apontada parece ser ${match.id} ("${match.label}"). Essa comparação erra com frequência: confirme com ask_user ("Quem sai do vídeo?"), com essa pessoa como primeira opção e as outras depois, antes de swap_character.`
              : 'O modelo não achou a pessoa da foto no vídeo: pergunte com ask_user quem sai, com as pessoas como opções.'
            : list.length > 1
              ? 'Mais de uma pessoa: se o pedido não diz quem sai, pergunte com ask_user antes de swap_character.'
              : undefined,
        },
      };
    }

    case 'swap_character':
      return swapCharacter(ctx, args);

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

    case 'ask_user': {
      // Aceita também o formato antigo (uma pergunta solta).
      const list = Array.isArray(args.questions) && args.questions.length ? args.questions : [{ question: args.question, options: args.options }];
      const questions = list
        .filter((q) => q && String(q.question || '').trim())
        .slice(0, 6)
        .map((q) => ({ question: String(q.question).trim(), options: (q.options || []).map(String).filter(Boolean).slice(0, 5), multiple: Boolean(q.multiple) }));
      if (!questions.length) throw new Error('ask_user precisa de pelo menos uma pergunta com texto.');
      return {
        label: 'Pergunta',
        question: { intro: args.intro ? String(args.intro).trim() : undefined, questions },
        endTurn: true,
        result: { ok: true, note: 'Pergunta mostrada ao usuário. Aguarde a resposta dele.' },
      };
    }

    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

export { emit };
