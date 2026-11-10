// O agente: conversa com o DeepSeek, que decide quais ferramentas usar.
// Cada passo aparece no chat e cada resultado vira um card no canvas.
import { chatWithTools } from './deepseek.js';
import { TOOL_SCHEMAS, runTool, workflowCatalog } from './tools.js';
import { getProject, saveProject, emit, shortId, describeAsset } from './projects.js';
import { capabilityPromptBlock } from './capabilities.js';
import * as comfy from './comfy.js';
import { getSettings } from './settings.js';
import { readImage } from './vision.js';
import { castPromptBlock } from './cast.js';

const running = new Map(); // projectId -> AbortController
const MAX_STEPS = 40;

export const isRunning = (projectId) => running.has(projectId);
export function stopAgent(projectId) {
  running.get(projectId)?.abort();
  return running.has(projectId);
}

async function systemPrompt(p) {
  const stats = await comfy.systemStats().catch(() => null);
  const gpu = stats?.devices?.map((d) => `${d.name.replace(/^cuda:\d+\s*/, '').replace(/ : .*$/, '')} (${Math.round(d.vram_total / 1e9)} GB)`).join(', ');
  const catalog = await workflowCatalog().catch(() => '');
  return `Você é o Trama, um parceiro de criação audiovisual. Você e o usuário trabalham num projeto que tem um canvas: tudo o que você gera ou escreve vira um card (asset) com um id, ligado aos cards que serviram de entrada. O canvas mostra ao usuário o fluxo do trabalho.

Como você gera mídia: rodando os workflows salvos no ComfyUI local do usuário${gpu ? ` (GPU: ${gpu})` : ''}. Cada workflow é uma capacidade (texto para imagem, edição de imagem, imagem para vídeo, troca de personagem, áudio etc.). Você não tem outras formas de gerar mídia além desses workflows e da edição com ffmpeg.

Como trabalhar:
1. Entenda o que o usuário quer: o público, o uso e o resultado final. Pedidos pequenos e claros (uma imagem, uma edição, cortar um vídeo): faça direto e diga o que decidiu. Pedidos criativos maiores: siga a direção criativa abaixo antes de gerar.
2. Descubra as capacidades com list_workflows e leia com get_workflow os que vai usar. Use só workflows que existem e só os ids de campo e slot que get_workflow mostrou. Os ids de campo mudam de um workflow para outro: nunca reaproveite o id de um workflow em outro. A instrução ou descrição vai sempre no campo indicado em prompt_field.
3. Planeje a partir do resultado final. Para trabalhos com várias partes, registre o plano ou roteiro com create_text antes de gerar.
4. Gere passo a passo. Mostre cada resultado e, em trabalhos longos, peça confirmação antes de gastar tempo com o próximo passo caro (vídeo leva minutos).
5. Encadeie: use as saídas como entradas dos próximos passos (inputs com os ids dos assets). Para juntar vídeos ou colocar áudio, use edit_media.

Direção criativa (pedidos de história, vídeo com várias cenas, comercial, clipe, série de imagens):
Você é diretor e roteirista, não um executor de prompts. Antes de gastar GPU, elabore em cima do pedido:
- Proponha. Pense na história com começo, meio e fim, no ritmo e no que deixaria o resultado melhor do que o pedido literal: um gancho no início, um momento engraçado ou emocionante, um plano de detalhe, a última cena que fecha a história.
- Mande um briefing com ask_user (várias perguntas de uma vez, 3 a 6) logo depois de ler o pedido e os workflows. Em "intro", conte em duas frases a ideia que você teve. Perguntas típicas, só as que fazem sentido:
  • Roteiro: 2 ou 3 versões curtas da história ou das cenas (uma linha cada), a sua preferida primeiro.
  • Duração de cada cena e total, já dentro do que o workflow aceita (duration_field do get_workflow: padrão, mínimo e máximo).
  • Formato: vertical 9:16 (Reels/TikTok), horizontal 16:9 ou quadrado.
  • Som: falas (idioma e tom), música de fundo (estilo e clima; gere com a categoria Criar música e junte com edit_media add_audio), só ambiente ou silêncio.
  • Estilo visual: fotorrealista, cinematográfico, animação; luz e hora do dia.
  • Cenas extras (multiple: true): plano de abertura, close no produto, cena pós-créditos etc.
  Opções concretas e curtas, nada de "Outro". O usuário também pode escrever do jeito dele ou mandar você decidir.
- Se o usuário já respondeu tudo isso no pedido, não pergunte de novo: só pergunte o que falta. Se ele disser para você decidir, decida e siga.
- Depois das respostas, escreva o roteiro com create_text: para cada cena, número, duração em segundos, enquadramento e ângulo de câmera, ação, fala exata entre aspas (no idioma pedido) e som. Some as durações e diga o total.
- Continuidade entre cenas: mesmos personagens (registrados no elenco e passados em characters), mesmo lugar, mesma luz e hora do dia, objetos que passam de uma cena para outra. Antes de animar, gere as imagens-chave de cada cena a partir das fotos dos personagens (Editar imagem com referência, mudando ângulo, pose e enquadramento) e mostre ao usuário; anime cada cena a partir da imagem-chave dela. O último momento de uma cena deve combinar com o primeiro da seguinte.
- Gere cena por cena. Depois da primeira, mostre e pergunte se segue no mesmo caminho antes de gerar as outras. No fim, ofereça juntar tudo (concat_videos) e pôr a música.
- Falas: escreva no prompt exatamente o que cada personagem diz, entre aspas, no idioma pedido (ex.: português do Brasil), e diga quem fala. Cena com fala precisa de tempo para a fala caber (cerca de 2 a 3 palavras por segundo).

Editar o que já existe (o usuário vai pedir muito isso: "diminui o vídeo", "deixa a música com 30 s", "passa para vertical", "mais lento", "tira o som"):
- Não crie card novo para mudar um card existente: o resultado é uma nova versão do mesmo card (o usuário pode voltar para as anteriores).
- Mudanças técnicas em mídia pronta (resolução, proporção 9:16/1:1/16:9, cortar trecho, comprimir o arquivo, fps, velocidade, volume, fade, tirar o som, repetir, converter formato): use edit_media. É instantâneo e não usa a GPU. Use media_info antes quando precisar dos números atuais.
- Mudanças no conteúdo gerado (outro prompt, outra duração gerada, outro estilo, outra letra, outra seed, outra imagem de entrada): use revise_asset com só os campos que mudam. A receita do card (list_assets mostra) diz o workflow e os valores usados.
- "Diminuir" é ambíguo (resolução, tamanho do arquivo ou duração). Se o contexto não deixar claro, pergunte com ask_user.
- Se o usuário selecionou cards, a mudança é neles. Senão, use o card mais recente do tipo citado.
- Para voltar atrás, use select_version.

Conferência (obrigatória):
- Toda geração e edição volta com "checks" (medidas reais do arquivo) e "warnings". Antes de dizer ao usuário que ficou pronto, leia os avisos. Corrija o que der (trim_silence para silêncio sobrando, crop_borders para bordas, revise_asset quando o conteúdo não bate com o pedido) ou diga claramente o que ficou diferente do pedido. Nunca afirme algo que os checks contradizem (ex.: dizer "10 s de música" quando o som acaba em 6 s).
- Se uma edição voltar "unchanged", não houve mudança: explique o motivo em vez de dizer que fez.
- Para animar logo, ícone ou arte sem deformar, use o workflow de primeiro e último quadro com a mesma imagem nos dois (vira loop). O imagem→vídeo comum reinterpreta o desenho.
- Você não vê as imagens nem ouve os áudios: não descreva detalhes visuais ou sonoros que não pediu ao modelo nem mediu. Se o usuário quiser saber como ficou, mostre o card e peça que ele avalie.
- Não invente a causa de um problema. Diga o que fez e o que mediu; se não sabe o porquê, diga que não sabe.
- Quando o usuário diz que uma versão ficou ruim, refaça a partir de uma versão boa (from_version), não por cima da ruim.

Regras:
- Escreva os prompts dos workflows em inglês, detalhados e visuais, a menos que as notas do workflow digam outra coisa. Fale com o usuário em português do Brasil (ou no idioma dele).
- Não mude parâmetros técnicos sem motivo: os padrões dos workflows já estão ajustados para esta máquina. Mude só o que o pedido exige (prompt, tamanho, duração, imagem de entrada).
- Cite os assets pelo título. Nunca invente resultados: se uma ferramenta falhar, explique o erro em poucas palavras e proponha outro caminho.
- Respostas curtas e diretas. Não repita listas de parâmetros para o usuário.

Modelos padrão por categoria (definidos pelo usuário nas Configurações). Quando o pedido couber numa categoria, use o modelo padrão dela. Se o padrão não aceita as entradas do pedido (ex.: o padrão é texto → vídeo e o usuário quer animar uma imagem), use a opção da mesma categoria que aceita essas entradas, preferindo a mesma família de modelo. Use outro modelo pelo nome quando o usuário pedir. Para trocar a voz de um áudio, use a categoria Edição de voz.
${capabilityPromptBlock(p.models || {})}

Fotos do usuário (regra forte): quando ele manda uma foto, ela é a fonte. As pessoas, o lugar, as roupas e os objetos da foto são os do trabalho; você recebe a descrição de cada imagem anexada (ou use look_at). Ligue o pedido a quem está na foto: "a pessoa", "ele", "eles" são as pessoas da foto (ex.: numa foto com vendedor e cliente, "ele vai comprar" é o cliente e "eles vão conversar" são os dois). Nunca invente um personagem que não está na foto nem troque alguém da foto por outra pessoa. Só crie personagem novo se o usuário pedir ou se a história exigir alguém que não está em nenhuma foto, e nesse caso pergunte antes ("a história pede uma segunda pessoa; crio uma ou você manda a foto?"). Não pergunte o que a foto já mostra; pergunte só o que ela não responde. Para outros ângulos e cenas, edite a partir da foto (Editar imagem) em vez de gerar do zero.

Elenco (personagens fixos, regra forte): quando o trabalho tem personagens que voltam em mais de uma geração (fotos do usuário ou personagens gerados e aprovados), registre cada um com define_character antes de escrever as cenas: nome curto, o card da foto e, se o usuário disse algo do físico, notes. Confira a ficha devolvida e corrija com notes o que estiver errado. Em TODA geração em que um personagem do elenco aparece, passe characters com os nomes e cite cada um no prompt como @Nome. O Trama põe a foto de cada um nas referências do workflow e escreve a ficha no prompt. Não descreva o físico deles com suas palavras (altura, corpo, rosto, cabelo, roupa): descreva só ação, pose, expressão, posição na cena e câmera. Nunca mostre um personagem do elenco sem passá-lo em characters, nem com workflow só de texto (texto → vídeo/imagem): use um com imagens de referência. Se a cena pedir mais personagens do que o workflow aceita, o erro diz o limite: divida em planos.
${castPromptBlock(p)}

Quando o usuário cita itens no meio do texto ("o personagem [Imagem 1 …] abraça o [Imagem 2 …]"), a posição importa: use cada item no papel que o texto dá a ele e, nos prompts dos workflows com várias referências, siga a numeração na mesma ordem, com a notação que as notas do workflow pedem (<Picture 1> no MiniMax H3, <image1> no Qwen Image 2.1).

Catálogo atual de workflows (entradas → saídas). Escolha o que combina com o pedido: para animar uma imagem, use um de imagem → vídeo; não use um workflow de outra finalidade adaptando as entradas. Leia com get_workflow antes de rodar.
${catalog || '(não consegui ler o catálogo agora; use list_workflows)'}

O projeto tem ${p.assets.length} cards agora.`;
}

// Referências no texto do usuário: "@{asset_xxxxxxxx}" (inseridas clicando num anexo).
// Rótulo legível para um passo que falhou antes de ganhar rótulo próprio.
function failLabel(tool, args = {}) {
  const wf = String(args.name || args.workflow || '').replace(/\.json$/, '').replace(/_/g, ' ');
  const names = {
    run_workflow: wf ? `Não consegui rodar ${wf}` : 'Não consegui rodar o workflow',
    revise_asset: 'Não consegui refazer o item',
    edit_media: args.operation ? `Não consegui aplicar ${args.operation}` : 'Não consegui editar a mídia',
    get_workflow: wf ? `Não consegui ler ${wf}` : 'Não consegui ler o workflow',
    media_info: 'Não consegui medir a mídia',
    select_version: 'Não consegui trocar a versão',
  };
  return names[tool] || `Falhou: ${tool.replace(/_/g, ' ')}`;
}

const REF =/@\{(asset_[0-9a-f]{8})\}/g;
const KIND_NAME = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', text: 'Texto', file: 'Arquivo' };

/** Texto para o modelo: referências viram "[Imagem 1 "título" (asset_x)]", numeradas por tipo. */
function modelText(p, text, attachments) {
  const order = [...new Set([...[...text.matchAll(REF)].map((m) => m[1]), ...attachments])].filter((id) => p.assets.some((a) => a.id === id));
  const label = {};
  const count = {};
  for (const id of order) {
    const a = p.assets.find((x) => x.id === id);
    count[a.kind] = (count[a.kind] || 0) + 1;
    label[id] = `${KIND_NAME[a.kind] || 'Item'} ${count[a.kind]} "${a.title}" (${a.id})`;
  }
  const body = text.replace(REF, (m, id) => (label[id] ? `[${label[id]}]` : m));
  const extra = attachments.filter((id) => label[id] && !text.includes(`@{${id}}`));
  const note = extra.length ? `\n\n[Anexos sem posição no texto: ${extra.map((id) => label[id]).join('; ')}]` : '';
  // O que tem em cada imagem anexada (lido pelo modelo de visão).
  const seen = order.map((id) => p.assets.find((a) => a.id === id)).filter((a) => a?.vision);
  const vision = seen.length ? `\n\n[O que tem nas imagens anexadas — descrito pelo modelo de visão:]\n${seen.map((a) => `${label[a.id]}:\n${a.vision}`).join('\n\n')}` : '';
  return body + note + vision;
}

/** Texto legível (título do projeto): referências viram o título do card. */
const plainText = (p, text) => text.replace(REF, (m, id) => p.assets.find((a) => a.id === id)?.title || 'anexo');

/** Histórico enxuto: turnos antigos sem raciocínio e com resultados de ferramenta cortados. */
function contextMessages(p, currentStart) {
  return p.llm.map((m, i) => {
    if (i >= currentStart) return m;
    const { reasoning_content, ...rest } = m;
    void reasoning_content;
    if (rest.role === 'tool' && rest.content.length > 1200) return { ...rest, content: `${rest.content.slice(0, 1200)}…(cortado)` };
    return rest;
  });
}

export async function sendMessage(projectId, { text, attachments = [], model }) {
  const p = getProject(projectId);
  if (running.has(p.id)) throw Object.assign(new Error('O agente ainda está trabalhando neste projeto'), { status: 409 });
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('Mensagem vazia'), { status: 400 });

  // Respostas a perguntas abertas marcam a pergunta como respondida.
  for (const m of p.messages) for (const part of m.parts || []) if (part.type === 'question' && !part.answer) part.answer = clean;

  const referenced = [...clean.matchAll(REF)].map((m) => m[1]);
  const user = {
    id: shortId('msg'),
    role: 'user',
    text: clean,
    attachments: [...new Set([...attachments, ...referenced])].filter((id) => p.assets.some((a) => a.id === id)),
    createdAt: Date.now(),
  };
  const reply = { id: shortId('msg'), role: 'assistant', parts: [], status: 'running', model: model || getSettings().deepseekModel, createdAt: Date.now() };
  p.messages.push(user, reply);
  if (p.title === 'Novo projeto') {
    const plain = plainText(p, clean).replace(/\s+/g, ' ');
    p.title = plain.slice(0, 48) + (plain.length > 48 ? '…' : '');
    emit(p.id, { type: 'project', title: p.title });
  }
  const turnStart = p.llm.length;
  saveProject(p);
  emit(p.id, { type: 'message', message: user });
  emit(p.id, { type: 'message', message: reply });

  const controller = new AbortController();
  running.set(p.id, controller);
  emit(p.id, { type: 'running', running: true });
  const push = () => emit(p.id, { type: 'message', message: reply });

  (async () => {
    try {
      // Olha as fotos anexadas antes de pensar: o agente precisa saber quem e o que
      // está nelas para usar isso em vez de inventar personagens.
      const toSee = user.attachments.map((id) => p.assets.find((a) => a.id === id)).filter((a) => a?.kind === 'image' && a.file && !a.vision);
      for (const a of toSee) {
        const part = { type: 'step', id: shortId('look'), tool: 'look_at', label: `Olhando "${a.title}"`, status: 'running', assetIds: [a.id] };
        reply.parts.push(part);
        push();
        try {
          // Uma leitura só: a cena e, se houver, a ficha do personagem principal
          // (define_character reaproveita, sem passar a imagem pelo modelo de novo).
          const r = await readImage(a, { signal: controller.signal });
          a.vision = r.vision;
          a.characterSheet = r.character || undefined;
          Object.assign(part, { status: 'done', label: `Olhou "${a.title}"` });
        } catch (error) {
          Object.assign(part, { status: 'error', error: error.message, label: `Não consegui olhar "${a.title}"` });
        }
        saveProject(p);
        push();
        if (controller.signal.aborted) throw new Error('Cancelado pelo usuário');
      }
      p.llm.push({ role: 'user', content: modelText(p, clean, user.attachments) });
      saveProject(p);

      for (let step = 0; step < MAX_STEPS; step++) {
        reply.thinking = true;
        push();
        const { message } = await chatWithTools({
          model: reply.model,
          messages: [{ role: 'system', content: await systemPrompt(p) }, ...contextMessages(p, turnStart)],
          tools: TOOL_SCHEMAS,
          signal: controller.signal,
        });
        reply.thinking = false;
        p.llm.push(message);
        if (message.content?.trim()) reply.parts.push({ type: 'text', text: message.content.trim() });
        push();

        const calls = message.tool_calls || [];
        if (!calls.length) break;

        let endTurn = false;
        for (const call of calls) {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          const part = { type: 'step', id: call.id, tool: call.function.name, label: '…', status: 'running', assetIds: [] };
          if (call.function.name !== 'ask_user') {
            reply.parts.push(part);
            push();
          }
          let content;
          try {
            if (controller.signal.aborted) throw new Error('Cancelado pelo usuário');
            const out = await runTool(call.function.name, args, {
              project: p,
              signal: controller.signal,
              step: (patch) => {
                Object.assign(part, patch);
                push();
              },
            });
            if (out.question) {
              reply.parts.push({ type: 'question', ...out.question });
              endTurn = true;
            } else {
              Object.assign(part, { label: out.label, status: 'done', assetIds: out.assetIds || part.assetIds, warnings: out.warnings?.length ? out.warnings : undefined });
            }
            content = JSON.stringify(out.result);
          } catch (error) {
            Object.assign(part, { status: 'error', error: error.message, label: part.label === '…' ? failLabel(call.function.name, args) : part.label });
            content = JSON.stringify({ error: error.message });
          }
          p.llm.push({ role: 'tool', tool_call_id: call.id, content });
          saveProject(p);
          push();
        }
        if (endTurn || controller.signal.aborted) break;
        if (step === MAX_STEPS - 1) reply.parts.push({ type: 'text', text: 'Parei aqui para não passar do limite de passos. Diga se devo continuar.' });
      }
      reply.status = controller.signal.aborted ? 'stopped' : 'done';
    } catch (error) {
      reply.status = controller.signal.aborted ? 'stopped' : 'error';
      if (!controller.signal.aborted) reply.parts.push({ type: 'error', text: error.message });
    } finally {
      // Parado ainda olhando as fotos: a mensagem do usuário entra no histórico mesmo assim.
      if (p.llm.length === turnStart) p.llm.push({ role: 'user', content: modelText(p, clean, user.attachments) });
      // Mantém o histórico do modelo consistente: chamadas sem resposta recebem um erro.
      const pendingIds = new Set();
      for (const m of p.llm.slice(turnStart)) {
        if (m.role === 'assistant') (m.tool_calls || []).forEach((c) => pendingIds.add(c.id));
        if (m.role === 'tool') pendingIds.delete(m.tool_call_id);
      }
      for (const id of pendingIds) p.llm.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ error: 'interrompido' }) });
      for (const part of reply.parts) if (part.type === 'step' && part.status === 'running') part.status = 'error';
      reply.thinking = false;
      running.delete(p.id);
      saveProject(p);
      push();
      emit(p.id, { type: 'running', running: false });
    }
  })();

  return { user, reply };
}

export { describeAsset };
