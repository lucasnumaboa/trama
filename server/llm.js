// Cérebro do agente: vários provedores de IA, cada um com a sua configuração
// guardada (trocar de provedor não apaga a chave nem o modelo do outro).
//
// O histórico do agente fica sempre no formato da OpenAI (mensagens com tool_calls e
// role "tool"). Cada provedor recebe esse formato e devolve uma resposta no mesmo
// formato:
//   - openai: DeepSeek, OpenAI, OpenRouter e Personalizado (LM Studio, Ollama, vLLM…),
//     todos falam a API /chat/completions;
//   - anthropic: SDK oficial da Anthropic (Messages API); a resposta original do
//     Claude vai junto em _anthropic, para os blocos de raciocínio voltarem intactos;
//   - comfyui: modelo de texto do próprio ComfyUI (workflow trama_texto_ia_local),
//     sem ferramentas nativas: as chamadas vêm num JSON combinado no prompt.
import Anthropic from '@anthropic-ai/sdk';
import { getSettings, providerConfig, PROVIDERS } from './settings.js';

export { PROVIDERS };

/** Provedor ativo (ou o pedido) com a configuração salva dele. */
export function getProvider(id) {
  const s = getSettings();
  const pid = id && PROVIDERS[id] ? id : s.llmProvider;
  return { id: pid, ...PROVIDERS[pid], ...providerConfig(pid) };
}

const name = (p) => p.label || p.id;

async function readError(res) {
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body).error?.message || body;
  } catch {
    return body || `HTTP ${res.status}`;
  }
}

// Uma queda de rede ou um 429/5xx passageiro não pode derrubar a conversa inteira.
const RETRY_WAIT = [2000, 5000, 15000, 30000];
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Cancelado'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason || new Error('Cancelado'))), { once: true });
  });
}

// Campos internos do Trama (começam com "_") não vão para APIs compatíveis com OpenAI.
const forOpenAI = (messages) => messages.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))));

// ---- Compatíveis com OpenAI --------------------------------------------------------
function openaiHeaders(p) {
  if (p.needsKey && !p.apiKey) throw new Error(`Configure a chave do ${name(p)} em Configurações`);
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  if (p.id === 'openrouter') Object.assign(h, { 'HTTP-Referer': 'https://github.com/lucasnumaboa/trama', 'X-Title': 'Trama' });
  return h;
}

async function postOpenAI(p, body, signal, onRetry = () => {}) {
  if (!p.baseUrl) throw new Error(`Configure o endereço da API do ${name(p)} em Configurações`);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: openaiHeaders(p),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = error.cause?.code || error.cause?.message || error.message;
      if (attempt >= RETRY_WAIT.length) throw new Error(`Sem conexão com o ${name(p)} depois de ${attempt + 1} tentativas (${why})`);
      onRetry({ attempt: attempt + 1, why });
      await sleep(RETRY_WAIT[attempt], signal);
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (error) {
        if (signal?.aborted || attempt >= RETRY_WAIT.length) throw error;
        onRetry({ attempt: attempt + 1, why: error.message });
        await sleep(RETRY_WAIT[attempt], signal);
        continue;
      }
    }
    if (RETRY_STATUS.has(res.status) && attempt < RETRY_WAIT.length) {
      await res.text().catch(() => '');
      onRetry({ attempt: attempt + 1, why: `HTTP ${res.status}` });
      await sleep(RETRY_WAIT[attempt], signal);
      continue;
    }
    const msg = await readError(res);
    // Modelos de raciocínio (ex.: OpenAI) recusam temperature: tenta de novo sem.
    if (res.status === 400 && 'temperature' in body && /temperature/i.test(msg)) {
      const { temperature, ...rest } = body;
      return postOpenAI(p, rest, signal, onRetry);
    }
    throw new Error(`${name(p)}: ${msg}`);
  }
}

// ---- Anthropic (SDK oficial) ----------------------------------------------------------
const anthropicClients = new Map();
function anthropicClient(p) {
  if (!p.apiKey) throw new Error(`Configure a chave da ${name(p)} em Configurações`);
  const key = `${p.apiKey}|${p.baseUrl || ''}`;
  if (!anthropicClients.has(key)) {
    anthropicClients.clear();
    anthropicClients.set(key, new Anthropic({ apiKey: p.apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}), maxRetries: 4, timeout: 300000 }));
  }
  return anthropicClients.get(key);
}

const parseArgs = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

/**
 * Histórico no formato da OpenAI → { system, messages } da Anthropic.
 * Mensagens do assistente que vieram do Claude voltam com o conteúdo original
 * (_anthropic), com os blocos de raciocínio intactos; respostas de ferramenta
 * seguidas viram uma única mensagem do usuário com vários tool_result.
 */
export function toAnthropic(messages) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role && role === 'user') last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      if (!out.length) system.push(String(m.content || ''));
      else push('user', [{ type: 'text', text: `[Sistema] ${m.content}` }]);
    } else if (m.role === 'user') {
      push('user', [{ type: 'text', text: String(m.content || '') || '(vazio)' }]);
    } else if (m.role === 'assistant') {
      if (Array.isArray(m._anthropic) && m._anthropic.length) {
        out.push({ role: 'assistant', content: m._anthropic });
        continue;
      }
      const blocks = [];
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]);
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(início da conversa)' }] });
  return { system: system.join('\n\n'), messages: out };
}

/** Resposta da Anthropic → mensagem do assistente no formato da OpenAI (+ _anthropic). */
export function fromAnthropic(response) {
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const calls = response.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  let content = text;
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation || response.stop_details?.category || '';
    content = `${text ? `${text}\n\n` : ''}(O Claude recusou este pedido${why ? `: ${why}` : ''}. Tente outro provedor ou reformule.)`;
  }
  return { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}), _anthropic: response.content };
}

async function anthropicCall(p, { messages, tools, maxTokens = 16000, signal }) {
  const client = anthropicClient(p);
  const { system, messages: msgs } = toAnthropic(messages);
  const params = {
    model: p.model || 'claude-opus-5-5',
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: msgs,
    ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } })) } : {}),
    output_config: { effort: 'high' },
  };
  // Recusa por política: a Anthropic refaz o pedido num modelo de reserva na mesma
  // chamada (fallbacks "default"), em vez de só parar.
  try {
    return await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal });
  } catch (error) {
    // Endereço próprio (proxy) ou modelo que não aceita o fallback: tenta sem ele.
    if (error instanceof Anthropic.BadRequestError && /fallback|beta/i.test(error.message)) return client.messages.create(params, { signal });
    if (error instanceof Anthropic.AuthenticationError) throw new Error(`${name(p)}: chave inválida`);
    if (error instanceof Anthropic.APIError) throw new Error(`${name(p)}: ${error.message}`);
    throw error;
  }
}

// ---- ComfyUI (modelo de texto local) --------------------------------------------------
export const LOCAL_WORKFLOW = 'trama_texto_ia_local.json';

/** Ferramentas resumidas para caber no prompt de um modelo local. */
function toolGuide(tools) {
  return tools
    .map((t) => {
      const props = Object.entries(t.parameters?.properties || {}).map(([k, v]) => `${k}${(t.parameters.required || []).includes(k) ? '' : '?'}: ${v.type || (v.enum ? 'enum' : 'any')}${v.enum ? ` (${v.enum.join('|')})` : ''}`);
      return `- ${t.name}(${props.join(', ')}): ${String(t.description || '').split(/(?<=\.)\s/)[0]}`;
    })
    .join('\n');
}

/** Conversa inteira num texto só (o TextGenerate recebe um prompt único). */
export function localPrompt(messages, tools) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'system') lines.push(`### SISTEMA\n${m.content}`);
    else if (m.role === 'user') lines.push(`### USUÁRIO\n${m.content}`);
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c) => ({ name: c.function.name, arguments: parseArgs(c.function.arguments) }));
      lines.push(`### ASSISTENTE\n${JSON.stringify({ say: m.content || '', calls })}`);
    } else if (m.role === 'tool') lines.push(`### RESULTADO DA FERRAMENTA (${m.tool_call_id})\n${String(m.content || '').slice(0, 4000)}`);
  }
  if (tools?.length) {
    lines.push(`### COMO RESPONDER
Você pode usar estas ferramentas:
${toolGuide(tools)}

Responda SOMENTE com um objeto JSON, sem markdown e sem texto fora dele:
{"say": "o que dizer ao usuário (pode ser vazio)", "calls": [{"name": "nome_da_ferramenta", "arguments": {...}}]}
Use "calls": [] quando não precisar de ferramenta. Depois de cada ferramenta você recebe o RESULTADO e responde de novo no mesmo formato.`);
  }
  lines.push('### ASSISTENTE');
  return lines.join('\n\n');
}

/** Lê a resposta do modelo local: JSON {say, calls} ou, se não for JSON, texto puro. */
/**
 * Primeiro objeto JSON completo do texto. Modelos pequenos às vezes escrevem a chamada e
 * depois inventam a própria próxima resposta ({"say": ...}{"say": "pronto"}): só a
 * primeira vale (antes o texto inteiro falhava no parse e a chamada não rodava).
 */
export function firstJsonObject(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  // Lê do primeiro "{" até fechar, consertando colchetes trocados: o Qwen3-VL 8B escreve
  // [{"name": ..., "arguments": {...}]} esquecendo o "}" da chamada antes do "]".
  const CLOSE = { '{': '}', '[': ']' };
  const stack = [];
  let out = '';
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < raw.length) out += raw[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      // Fecha o que ficou aberto até achar o par certo.
      while (stack.length && CLOSE[stack[stack.length - 1]] !== ch) out += CLOSE[stack.pop()];
      if (!stack.length) break;
      stack.pop();
      out += ch;
      if (!stack.length) break;
      continue;
    }
    out += ch;
  }
  while (stack.length) out += CLOSE[stack.pop()];
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

export function parseLocalReply(text, step = 0) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const found = firstJsonObject(raw);
  if (found && typeof found === 'object') {
    try {
      const j = found;
      const calls = (Array.isArray(j.calls) ? j.calls : [])
        .filter((c) => c && typeof c.name === 'string')
        .map((c, i) => ({ id: `local_${Date.now().toString(36)}_${step}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
      return { role: 'assistant', content: String(j.say ?? j.reply ?? ''), ...(calls.length ? { tool_calls: calls } : {}) };
    } catch {}
  }
  return { role: 'assistant', content: raw };
}

let localStep = 0;
async function localCall(p, { messages, tools, maxTokens = 2048, signal }) {
  // Import tardio: exec.js depende do ComfyUI e não precisa carregar nos outros provedores.
  const { runWorkflow, describeByName } = await import('./exec.js');
  const d = await describeByName(LOCAL_WORKFLOW).catch(() => {
    throw new Error(`Falta o workflow ${LOCAL_WORKFLOW} no ComfyUI (vem na pasta server/fixtures/workflows do Trama)`);
  });
  const field = (input) => d.fields.find((f) => f.input === input)?.id;
  const values = { [field('prompt')]: localPrompt(messages, tools), [field('max_length')]: maxTokens };
  const [file, type] = String(p.model || '').split('|');
  if (file && field('clip_name')) values[field('clip_name')] = file;
  if (type && field('type')) values[field('type')] = type;
  const { files } = await runWorkflow({ name: LOCAL_WORKFLOW, values, signal });
  const text = files.filter((f) => f.kind === 'text').map((f) => f.text).join('\n');
  if (!text.trim()) throw new Error(`${name(p)}: o modelo local não devolveu texto`);
  return tools?.length ? parseLocalReply(text, localStep++) : { role: 'assistant', content: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
}

/** Modelos de texto do ComfyUI que funcionam no TextGenerate ("arquivo|tipo"). */
const LOCAL_MODELS = [
  ['qwen3vl_8b_int8_convrot.safetensors', 'qwen_image', 'Qwen3-VL 8B'],
  ['qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors', 'qwen_image', 'Qwen 3.5 9B'],
  ['gemma_3_12B_it_fp4_mixed.safetensors', 'ltxv', 'Gemma 3 12B'],
  ['qwen_3_4b.safetensors', 'lumina2', 'Qwen 3 4B'],
];

// ---- Interface usada pelo agente ------------------------------------------------------
/** Uma chamada de chat com ferramentas. Devolve a mensagem do assistente (formato OpenAI). */
export async function chatWithTools({ provider, model, messages, tools, signal, onRetry }) {
  const p = getProvider(provider);
  if (model) p.model = model;
  if (p.kind === 'anthropic') return { message: fromAnthropic(await anthropicCall(p, { messages, tools, signal })), model: p.model };
  if (p.kind === 'comfyui') return { message: await localCall(p, { messages, tools, signal }), model: p.model };
  const data = await postOpenAI(p, { model: p.model, messages: forOpenAI(messages), tools: tools.map((t) => ({ type: 'function', function: t })), stream: false }, signal, onRetry);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(`${name(p)} devolveu uma resposta vazia`);
  return { message, usage: data.usage, model: data.model };
}

/** Gera texto (triagem, revisões). `context` são textos de entrada. */
export async function generateText({ system, prompt, context = [], model, temperature, signal, provider }) {
  const p = getProvider(provider);
  if (model) p.model = model;
  const messages = [];
  if (system?.trim()) messages.push({ role: 'system', content: system.trim() });
  const parts = [];
  context.forEach((text, i) => parts.push(`[Entrada ${i + 1}]\n${text}`));
  if (prompt?.trim()) parts.push(prompt.trim());
  if (!parts.length) throw new Error('Sem instrução e sem entrada para gerar texto');
  messages.push({ role: 'user', content: parts.join('\n\n') });
  let text;
  if (p.kind === 'anthropic') text = fromAnthropic(await anthropicCall(p, { messages, signal })).content;
  else if (p.kind === 'comfyui') text = (await localCall(p, { messages, signal })).content;
  else {
    const data = await postOpenAI(p, { model: p.model, messages, ...(typeof temperature === 'number' ? { temperature } : {}), stream: false }, signal);
    text = data.choices?.[0]?.message?.content ?? '';
  }
  if (!text) throw new Error(`${name(p)} devolveu uma resposta vazia`);
  return text;
}

/** Modelos disponíveis no provedor (para escolher na tela). */
export async function listModels(provider) {
  const p = getProvider(provider);
  if (p.kind === 'comfyui') {
    const { objectInfo } = await import('./comfy.js');
    const info = await objectInfo();
    const have = info.CLIPLoader?.input?.required?.clip_name?.[0] || [];
    return LOCAL_MODELS.filter(([file]) => have.includes(file)).map(([file, type]) => `${file}|${type}`);
  }
  if (p.kind === 'anthropic') {
    const page = await anthropicClient(p).models.list({ limit: 100 });
    return page.data.map((m) => m.id);
  }
  if (!p.baseUrl) throw new Error(`Configure o endereço da API do ${name(p)}`);
  const res = await fetch(`${p.baseUrl}/models`, { headers: openaiHeaders(p), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${name(p)}: ${await readError(res)}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
