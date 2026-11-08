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

export async function listModels() {
  const { deepseekBaseUrl } = getSettings();
  const res = await fetch(`${deepseekBaseUrl}/models`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`DeepSeek: ${await readError(res)}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

/** Uma chamada de chat com ferramentas (formato OpenAI). Devolve a mensagem do assistente. */
export async function chatWithTools({ model, messages, tools, signal }) {
  const s = getSettings();
  const res = await fetch(`${s.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: model || s.deepseekModel,
      messages,
      tools: tools.map((t) => ({ type: 'function', function: t })),
      stream: false,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`DeepSeek: ${await readError(res)}`);
  const data = await res.json();
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

  const res = await fetch(`${s.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: model || s.deepseekModel,
      messages,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      stream: false,
    }),
    signal: signal ?? AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`DeepSeek: ${await readError(res)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('DeepSeek devolveu uma resposta vazia');
  return text;
}
