// Elenco do projeto: personagens fixos, cada um com a foto de referência e uma ficha
// física travada (lida uma vez pelo modelo de visão). Em toda geração com um
// personagem do elenco, o Trama anexa a foto dele como referência e escreve a ficha
// no prompt, em vez de deixar o agente descrever o físico com as palavras dele
// (era aí que o personagem mudava de uma cena para outra).
import { refTag } from './describe.js';

export const castOf = (p) => (p.cast ||= []);

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findCharacter(p, name) {
  const key = norm(String(name).replace(/^@/, ''));
  return castOf(p).find((c) => norm(c.name) === key || c.id === name) || null;
}

/** Cria ou atualiza (mesmo nome) um personagem. */
export function upsertCharacter(p, { name, assetId, sheet, brief, notes }) {
  const cast = castOf(p);
  const old = findCharacter(p, name);
  const c = {
    id: old?.id || `char_${Math.random().toString(16).slice(2, 10)}`,
    name: String(name).replace(/^@/, '').trim(),
    assetId,
    sheet,
    // O que o usuário disse vale mais que o modelo de visão: vem primeiro.
    brief: notes ? `${notes.trim().replace(/[.;]\s*$/, '')}; ${brief}` : brief,
    notes: notes || undefined,
    updatedAt: Date.now(),
  };
  if (old) cast[cast.indexOf(old)] = c;
  else cast.push(c);
  return c;
}

export function removeCharacter(p, name) {
  const c = findCharacter(p, name);
  if (!c) return null;
  p.cast = castOf(p).filter((x) => x !== c);
  return c;
}

// Sem acento, mas respeitando maiúsculas.
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Personagens do elenco citados no texto: como @Nome (qualquer caixa) ou pelo nome
 * escrito como nome próprio, com inicial maiúscula. "Sumo" conta, "sumo ring" não:
 * o nome de um personagem pode ser uma palavra comum.
 */
export function mentionedCharacters(p, text) {
  const t = deaccent(text);
  const edge = '(?![\\p{L}\\p{N}])';
  return castOf(p).filter((c) => {
    const name = escape(deaccent(c.name).trim());
    if (new RegExp(`@\\{?${name}\\}?${edge}`, 'iu').test(t)) return true;
    for (const m of t.matchAll(new RegExp(`(^|[^\\p{L}\\p{N}@])(${name})${edge}`, 'giu'))) {
      const first = m[2][0];
      if (first !== first.toLowerCase()) return true;
    }
    return false;
  });
}

/**
 * Distribui os personagens nas referências do workflow e monta o prompt.
 * @param {object} desc       descritor do workflow (mediaInputs com refNumber, references)
 * @param {object} inputs     slot -> asset já escolhidos pelo agente
 * @param {Array}  characters personagens do elenco, cada um com .asset (o card da foto)
 * @param {string} prompt     texto do agente, citando os personagens como @Nome
 * @returns {{ slots: object, extra: Array, prompt: string, refs: Array<{name, n}> }}
 *   slots: slot -> asset para os slots livres; extra: assets além dos slots do workflow.
 */
export function placeCharacters(desc, inputs, characters, prompt) {
  const refs = desc.references || { tagStyle: 'picture', maxImages: 0, grow: null };
  const imageSlots = desc.mediaInputs.filter((m) => m.kind === 'image').sort((a, b) => (a.refNumber || 0) - (b.refNumber || 0));
  if (!refs.maxImages) {
    throw new Error(
      `O workflow ${desc.name} não recebe imagens de referência, então não tem como manter ${characters.map((c) => c.name).join(', ')} iguais às fotos. Use um workflow com referência de imagem (ex.: o de vídeo com referências).`,
    );
  }
  const slots = {};
  const extra = [];
  const placed = [];
  const taken = new Map(Object.entries(inputs || {}).map(([slot, assetId]) => [slot, assetId]));
  for (const c of characters) {
    // A foto do personagem já está num slot (o agente passou): usa o mesmo número.
    const same = imageSlots.find((m) => taken.get(m.id) === c.asset.id);
    if (same) {
      placed.push({ c, n: same.refNumber });
      continue;
    }
    const free = imageSlots.find((m) => !taken.has(m.id));
    if (free) {
      taken.set(free.id, c.asset.id);
      slots[free.id] = c.asset;
      placed.push({ c, n: free.refNumber });
      continue;
    }
    if (refs.grow && extra.length < refs.grow.extra) {
      extra.push(c.asset);
      placed.push({ c, n: refs.grow.linkedCount + extra.length });
      continue;
    }
    const others = Object.keys(inputs || {}).length;
    throw new Error(
      `O workflow ${desc.name} aceita no máximo ${refs.maxImages} imagens de referência${others ? ` (${others} já usadas por outras entradas)` : ''}, e a cena pede ${characters.length} personagens. Divida a cena em planos com menos personagens ou tire uma entrada que não seja personagem.`,
    );
  }

  const tag = (n) => refTag(refs.tagStyle, n);
  let text = String(prompt || '');
  for (const { c, n } of placed) {
    text = text.replace(new RegExp(`@\\{?${escape(c.name)}\\}?(?![\\p{L}\\p{N}])`, 'giu'), tag(n));
  }
  const block = placed.map(({ c, n }) => `${tag(n)} is ${c.name}: ${c.brief}`).join('\n');
  // "Uma vez só": pedindo um ângulo diferente do da foto (ex.: de costas), o modelo de
  // imagem desenhou o personagem no ângulo pedido E de novo na pose da foto.
  const once = placed.length === 1
    ? `${placed[0].c.name} appears exactly once in the picture, only in the pose and angle described below, never a second time in the pose of the reference picture.`
    : `Each of these ${placed.length} characters appears exactly once in the picture, only in the pose and angle described below — never draw anyone twice, and never add an extra copy in the pose of their reference picture.`;
  const head = `Characters — keep each one exactly as in their reference picture: same height and body proportions, build, face, hair, facial hair, glasses and outfit. Do not change anyone's body type.\n${block}\n${once}`;
  return { slots, extra, prompt: `${head}\n\n${text}`, refs: placed.map(({ c, n }) => ({ name: c.name, n })) };
}

/** Bloco do elenco para o prompt de sistema do agente. */
export function castPromptBlock(p) {
  const cast = castOf(p);
  if (!cast.length) return 'Elenco deste projeto: nenhum personagem registrado ainda.';
  return `Elenco deste projeto (use os nomes em characters e cite como @Nome):\n${cast.map((c) => `- ${c.name} (foto: ${c.assetId}): ${c.brief}`).join('\n')}`;
}
