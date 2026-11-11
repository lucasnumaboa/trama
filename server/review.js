// Triagem de uma geração: o modelo de visão local descreve o que saiu e o DeepSeek
// compara com o que foi pedido. Pega o que a conferência técnica (duração, tamanho)
// não vê: personagem duplicado ou faltando, gente a mais, formato errado.
import { generateText } from './deepseek.js';
import { reviewImage, readVideo } from './vision.js';

const SYSTEM = `Você é o revisor de qualidade de um estúdio de vídeo e imagem. Recebe o pedido que foi enviado ao gerador e a descrição do que saiu, feita por um modelo de visão (que pode errar detalhes pequenos, como cor de roupa).
Separe o que encontrar em dois grupos.
GRAVES (estragam a cena, precisa refazer):
- pessoa ou personagem a mais, faltando ou duplicado (a mesma pessoa desenhada duas vezes, mesmo em ângulos diferentes);
- formato diferente do pedido (pediu horizontal e saiu vertical, ou o contrário);
- defeito grave visível (rosto ou mãos deformados, membros a mais, pessoas grudadas).
MENORES (vale avisar, mas a cena serve):
- pose, ângulo ou ação de alguém diferente do pedido (ex.: de frente em vez de costas);
- objeto ou adereço diferente (ex.: duas espadas em vez de uma);
- texto pedido incompleto ou errado.
Não reprove por estilo, cor, luz, fundo ou detalhes pequenos. O cenário só conta se for um lugar completamente diferente do pedido (ex.: praia em vez de floresta); variações do mesmo tipo de lugar não contam. Figurantes no fundo (multidão, plateia) não contam como pessoa a mais, a não ser que o pedido diga que não pode haver ninguém.
Responda só com JSON, sem markdown: {"problems": ["frase curta em português para cada problema GRAVE"], "minor": ["frase curta para cada problema MENOR"]}. Listas vazias quando não houver.`;

/** Lê o JSON da resposta (tolera texto ou cercas em volta). */
export function parseVerdict(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(raw.slice(start, end + 1));
    const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);
    const problems = list(j.problems);
    // ok vem dos graves; um "ok": false explícito sem lista também reprova.
    return { ok: !problems.length && j.ok !== false, problems, minor: list(j.minor) };
  } catch {
    return null;
  }
}

const orientation = (w, h) => (!w || !h ? 'desconhecido' : Math.abs(w - h) / Math.max(w, h) < 0.05 ? 'quadrado' : w > h ? 'horizontal' : 'vertical');

/** Mensagem para o DeepSeek com o pedido, o elenco, o tamanho real e o que a visão viu. */
export function verdictPrompt({ request, characters = [], width, height, kind, seen }) {
  return [
    `PEDIDO ENVIADO AO GERADOR (${kind === 'video' ? 'vídeo' : 'imagem'}):\n${String(request || '(sem texto)').slice(0, 4000)}`,
    `PERSONAGENS DO ELENCO NESTA CENA: ${characters.length ? characters.join(', ') : 'nenhum indicado'}`,
    `TAMANHO REAL DO RESULTADO: ${width && height ? `${width}x${height}` : 'desconhecido'} (${orientation(width, height)})`,
    `O QUE SAIU (modelo de visão${kind === 'video' ? ', três quadros: início, meio e fim' : ''}):\n${seen}`,
  ].join('\n\n');
}

/**
 * @param {object} asset   card gerado (imagem ou vídeo)
 * @param {object} o
 * @param {string} o.request     prompt usado
 * @param {string[]} o.characters nomes do elenco na cena
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @returns {{ ok: boolean, problems: string[], seen: string }}
 */
export async function reviewGeneration(asset, { request, characters = [], width, height, signal } = {}) {
  const seen = asset.kind === 'video' ? await readVideo(asset, { signal }) : await reviewImage(asset, { signal });
  return { ...(await judge({ request, characters, width, height, kind: asset.kind, seen, signal })), seen };
}

/** Só a parte do DeepSeek: compara a descrição (seen) com o pedido. */
export async function judge({ request, characters = [], width, height, kind = 'image', seen, signal }) {
  const answer = await generateText({ system: SYSTEM, prompt: verdictPrompt({ request, characters, width, height, kind, seen }), temperature: 0, signal });
  const verdict = parseVerdict(answer);
  if (!verdict) throw new Error(`a resposta do revisor não veio em JSON: ${answer.slice(0, 200)}`);
  return verdict;
}
