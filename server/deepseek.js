// Cliente mínimo da API do DeepSeek (compatível com OpenAI).
import { getSettings } from './settings.js';

function headers() {
  const { deepseekApiKey } = getSettings();
  if (!deepseekApiKey) throw new Error('Configure a chave do DeepSeek em Configurações');
  return { Authorization: `Bearer ${deepseekApiKey}`, 'Content-Type': 'application/json' };
}

async function readError(res) {
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body).error?.message || body;
  } catch {
    return body || `HTTP ${res.status}`;
  }
}

// Uma queda de rede ou um 429/5xx passageiro não pode derrubar a conversa inteira
// (antes, um "fetch failed" no meio de um trabalho longo parava o agente).
const RETRY_WAIT = [2000, 5000, 15000, 30000];
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Cancelado'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason || new Error('Cancelado'))), { once: true });
  });
}

/** POST em /chat/completions com novas tentativas para falhas passageiras. */
async function postChat(body, signal, onRetry = () => {}) {
  const s = getSettings();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${s.deepseekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        // Sem resposta em 5 min conta como queda (a chamada normal leva segundos).
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = error.cause?.code || error.cause?.message || error.message;
      if (attempt >= RETRY_WAIT.length) throw new Error(`Sem conexão com o DeepSeek depois de ${attempt + 1} tentativas (${why})`);
      onRetry({ attempt: attempt + 1, why });
      await sleep(RETRY_WAIT[attempt], signal);
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (error) {
        // Conexão caiu no meio do corpo da resposta.
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
    throw new Error(`DeepSeek: ${await readError(res)}`);
  }
}

export async function listModels() {
  const { deepseekBaseUrl } = getSettings();
  const res = await fetch(`${deepseekBaseUrl}/models`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`DeepSeek: ${await readError(res)}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

/** Uma chamada de chat com ferramentas (formato OpenAI). Devolve a mensagem do assistente. */
export async function chatWithTools({ model, messages, tools, signal, onRetry }) {
  const s = getSettings();
  const data = await postChat(
    { model: model || s.deepseekModel, messages, tools: tools.map((t) => ({ type: 'function', function: t })), stream: false },
    signal,
    onRetry,
  );
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('DeepSeek devolveu uma resposta vazia');
  return { message, usage: data.usage, model: data.model };
}

/** Gera texto. `context` são textos vindos de nós conectados. */
export async function generateText({ system, prompt, context = [], model, temperature, signal }) {
  const s = getSettings();
  const messages = [];
  if (system?.trim()) messages.push({ role: 'system', content: system.trim() });
  const parts = [];
  context.forEach((text, i) => parts.push(`[Entrada ${i + 1}]\n${text}`));
  if (prompt?.trim()) parts.push(prompt.trim());
  if (!parts.length) throw new Error('O nó de texto está sem instrução e sem entrada');
  messages.push({ role: 'user', content: parts.join('\n\n') });

  const data = await postChat(
    { model: model || s.deepseekModel, messages, ...(typeof temperature === 'number' ? { temperature } : {}), stream: false },
    signal,
  );
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('DeepSeek devolveu uma resposta vazia');
  return text;
}
