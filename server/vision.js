// "Olhos" do agente: descreve imagens com um modelo de visão do próprio ComfyUI
// (TextGenerate com um codificador Qwen-VL). A descrição fica guardada no card,
// então cada imagem é lida uma vez só.
import * as comfy from './comfy.js';
import { asComfyInput } from './exec.js';

// Modelos de visão que funcionam no TextGenerate, do preferido para o mais leve.
// O Qwen3-VL 8B acerta quem faz o quê; o 9B (reescritor de prompt) troca papéis e vaza o raciocínio.
const VISION_MODELS = [
  ['qwen3vl_8b_int8_convrot.safetensors', 'qwen_image'],
  ['qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', 'qwen_image'],
];

const ASK = `Describe this image for a film director who must keep continuity in new scenes.
1. People: for EACH person, from left to right: position in frame, which side of any counter or stall they stand on (behind it = serving, in front = customer), gender, approximate age, height and body proportions compared with an average adult (e.g. very short with a large head, child-sized, tall, giant), build (slim, average, stocky, heavy, obese, muscular), skin tone, hair (color, length, cut), facial hair, glasses (shape), unusual features (pointed ears, scars, eyepatch, tattoos), clothing (colors, type), accessories, expression, exactly what each hand is doing or holding, and their likely role.
2. Setting: place, objects, colors, signs or text.
3. Light and time of day.
4. Camera: shot size, angle, orientation (vertical/horizontal).
Be factual and specific. No names, no guesses beyond what is visible. Plain text, no JSON, under 250 words.`;

// Ficha de personagem: só o físico e a roupa, para repetir o mesmo personagem em
// cenas novas. A última linha (BRIEF) é a versão curta que entra nos prompts.
const CHARACTER_ASK = (focus) => `You are writing a character model sheet so an animator can draw this exact character again in new scenes.
Describe ONLY the main character${focus ? ` (${focus})` : ''}, ignore the background and other people.
Answer each line, factual and specific, judging proportions against an average adult human:
HEIGHT & PROPORTIONS: overall height impression (very short / dwarf-like / child-sized / average / tall / giant), head-to-body ratio, leg and arm length.
BODY: build and weight (slim, average, stocky, heavy, obese, very muscular), shoulders, belly.
FACE: apparent age, face shape, skin tone, eyes, eyebrows, nose, mouth, typical expression.
EARS & MARKS: ear shape (normal or pointed), scars, eyepatch, moles, tattoos.
HAIR: color, length, texture (straight, wavy, curly), style (topknot, buzz cut, etc.).
FACIAL HAIR: none, stubble, mustache, goatee, beard — shape and color.
GLASSES: none, or frame shape, thickness and color.
OUTFIT: each garment from top to bottom with colors, material and condition (torn, patched), footwear.
PROPS: objects the character carries or wears (weapons, pipe, bag, basket, chain).
MUST KEEP: the 4 traits that make this character recognizable.
BRIEF: one line, at most 45 words, with height/proportions, build, face, hair, facial hair, glasses and outfit.
Plain text, these labels only, no extra commentary.`;

let chosen;
async function visionModel() {
  if (chosen !== undefined) return chosen;
  const info = await comfy.objectInfo();
  const options = info.CLIPLoader?.input?.required?.clip_name?.[0] || [];
  chosen = info.TextGenerate ? VISION_MODELS.find(([file]) => options.includes(file)) || null : null;
  return chosen;
}

/** Texto do modelo, sem raciocínio nem o JSON que alguns checkpoints acrescentam. */
function cleanText(raw) {
  let t = String(raw || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  // Raciocínio sem a tag de abertura: vale o que vem depois do último </think>.
  if (t.includes('</think>')) t = t.slice(t.lastIndexOf('</think>') + 8);
  // O checkpoint de prompt-enhancer às vezes continua "pensando" depois da resposta.
  const cut = t.search(/\n\s*(Output language:|Now, following the format|Let me carefully|Word count|Output must be|```json|\{\s*"image_description")/);
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/\n?(This is a factual inventory|Let me know if)[^\n]*/g, '');
  return t.trim();
}

/**
 * Descreve uma imagem (asset). Devolve o texto ou lança erro.
 * @param {{ file: {filename, subfolder, type} }} asset
 */
export const describeImage = (asset, opts) => ask(asset, ASK, opts);

/**
 * Ficha física de um personagem. Devolve { sheet, brief }.
 * focus: qual pessoa da imagem, quando houver mais de uma (ex.: "the man with the pipe").
 */
export async function describeCharacter(asset, { focus, signal } = {}) {
  const sheet = await ask(asset, CHARACTER_ASK(focus), { signal });
  // O BRIEF às vezes deixa de fora um traço marcante (ex.: orelhas pontudas) que está
  // em MUST KEEP: os dois entram no prompt.
  const keep = String(sheet).match(/^\s*\**MUST KEEP\s*:?\**\s*:?\s*(.+)$/im)?.[1]?.trim().replace(/[.\s]+$/, '');
  const brief = parseBrief(sheet).replace(/[.\s]+$/, '');
  return { sheet, brief: keep ? `${brief}. Must keep: ${keep}` : brief };
}

/** A linha BRIEF da ficha; sem ela, um resumo das primeiras linhas. */
export function parseBrief(sheet) {
  const m = String(sheet).match(/^\s*\**BRIEF\s*:?\**\s*:?\s*(.+)$/im);
  if (m) return m[1].trim().replace(/\*+$/, '');
  return String(sheet)
    .split('\n')
    .map((l) => l.replace(/^[A-Z &]+:\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('; ')
    .slice(0, 320);
}

async function ask(asset, question, { signal } = {}) {
  const model = await visionModel();
  if (!model) throw new Error('Não há modelo de visão instalado no ComfyUI (TextGenerate + Qwen-VL).');
  const image = await asComfyInput(asset.file);
  const prompt = {
    1: { class_type: 'LoadImage', inputs: { image } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: model[0], type: model[1], device: 'default' } },
    3: {
      class_type: 'TextGenerate',
      inputs: { clip: ['2', 0], prompt: question, image: ['1', 0], max_length: 900, sampling_mode: 'off', thinking: false, use_default_template: true },
    },
    4: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  };
  const history = await comfy.runPrompt(prompt, { signal });
  const out = history?.outputs?.['4'];
  const text = cleanText(Array.isArray(out?.text) ? out.text.join('\n') : out?.text);
  if (!text) throw new Error('O modelo de visão não devolveu descrição.');
  return text;
}
