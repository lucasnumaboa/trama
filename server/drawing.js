// Desenho chapado antes do 3D. O TRELLIS.2 aprende com objetos que têm volume e luz:
// com um desenho em preto e branco sem sombra (traço, cartum 2D) ele pinta a textura
// quase toda escura e perde as partes brancas. Antes de gerar o modelo, o Trama mede
// a imagem (nó TramaImageStyle do ComfyUI-Trama) e, se for chapada, transforma o
// desenho num boneco 3D com as mesmas cores (Editar imagem) e usa essa versão.
import * as comfy from './comfy.js';
import { asComfyInput, describeByName } from './exec.js';
import { defaultWorkflow } from './capabilities.js';

export const STYLE_VERSION = 1;
export const FALLBACK_EDIT = 'trama_editar_imagem_qwen_2_1.json';

export const TOON_PROMPT =
  'Turn this flat 2D drawing into a 3D cartoon figure render, like a vinyl toy. Keep exactly the same character or object, ' +
  'the same pose, the same proportions and the same colors in the same places: every white or light area stays white or light ' +
  '(face, gloves, shoes, details), every black area stays black. Smooth matte shading with soft volume, soft even studio lighting, ' +
  'plain light gray background, the whole figure in frame, front view.';

/** Lê o relatório do nó (texto JSON) no registro do ComfyUI. */
export function parseStyle(history) {
  const outs = comfy.collectOutputs(history);
  const text = Object.values(outs).flat().find((o) => o.kind === 'text')?.text;
  if (!text) throw new Error('o nó TramaImageStyle não devolveu o relatório');
  return JSON.parse(text);
}

/**
 * true se a imagem é um desenho chapado em preto e branco. O resultado fica guardado
 * no asset (drawingStyle). Sem o nó no ComfyUI (versão antiga do ComfyUI-Trama),
 * devolve null e o 3D segue com a imagem como está.
 */
export async function isFlatDrawing(asset, { signal } = {}) {
  if (asset.drawingStyle?.version === STYLE_VERSION && asset.drawingStyle.file === asset.file?.filename) return asset.drawingStyle.flat;
  const info = await comfy.objectInfo().catch(() => ({}));
  if (!info.TramaImageStyle) return null;
  const image = await asComfyInput(asset.file);
  const history = await comfy.runPrompt(
    {
      1: { class_type: 'LoadImage', inputs: { image } },
      2: { class_type: 'TramaImageStyle', inputs: { image: ['1', 0], mask: ['1', 1] } },
    },
    { signal },
  );
  const report = parseStyle(history);
  asset.drawingStyle = { version: STYLE_VERSION, file: asset.file?.filename, ...report };
  return Boolean(report.flat);
}

/** Workflow de edição com uma imagem de entrada só (o padrão da categoria, ou o Qwen 2.1). */
export async function toonWorkflow() {
  for (const name of [defaultWorkflow('image_edit'), FALLBACK_EDIT].filter(Boolean)) {
    try {
      const d = await describeByName(name);
      if (d.mediaInputs.filter((m) => m.kind === 'image').length === 1) return d;
    } catch {
      // workflow faltando: tenta o próximo
    }
  }
  return null;
}
