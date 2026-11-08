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
1. People: for EACH person, from left to right: position in frame, which side of any counter or stall they stand on (behind it = serving, in front = customer), gender, approximate age, build, skin tone, hair (color, length, cut), facial hair, clothing (colors, type), accessories, expression, exactly what each hand is doing or holding, and their likely role.
2. Setting: place, objects, colors, signs or text.
3. Light and time of day.
4. Camera: shot size, angle, orientation (vertical/horizontal).
Be factual and specific. No names, no guesses beyond what is visible. Plain text, no JSON, under 250 words.`;

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
export async function describeImage(asset, { signal } = {}) {
  const model = await visionModel();
  if (!model) throw new Error('Não há modelo de visão instalado no ComfyUI (TextGenerate + Qwen-VL).');
  const image = await asComfyInput(asset.file);
  const prompt = {
    1: { class_type: 'LoadImage', inputs: { image } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: model[0], type: model[1], device: 'default' } },
    3: {
      class_type: 'TextGenerate',
      inputs: { clip: ['2', 0], prompt: ASK, image: ['1', 0], max_length: 900, sampling_mode: 'off', thinking: false, use_default_template: true },
    },
    4: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  };
  const history = await comfy.runPrompt(prompt, { signal });
  const out = history?.outputs?.['4'];
  const text = cleanText(Array.isArray(out?.text) ? out.text.join('\n') : out?.text);
  if (!text) throw new Error('O modelo de visão não devolveu descrição.');
  return text;
}
