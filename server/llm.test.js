import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Configurações num diretório temporário (o módulo lê TRAMA_DATA_DIR ao carregar).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-llm-'));
process.env.TRAMA_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ deepseekApiKey: 'sk-antiga-123456', deepseekModel: 'deepseek-chat', comfyUrl: 'http://127.0.0.1:8188' }));
const settings = await import('./settings.js');
const { toAnthropic, fromAnthropic, localPrompt, parseLocalReply, getProvider } = await import('./llm.js');

test('a configuração antiga do DeepSeek vira o provedor deepseek, sem perder a chave', () => {
  const p = getProvider();
  assert.equal(p.id, 'deepseek');
  assert.equal(p.apiKey, 'sk-antiga-123456');
  assert.equal(p.baseUrl, 'https://api.deepseek.com');
  assert.equal(settings.publicSettings().providers.deepseek.keyMasked, 'sk-••••3456');
});

test('trocar de provedor guarda a config de cada um', () => {
  settings.updateSettings({ llmProvider: 'openrouter', providers: { openrouter: { apiKey: 'or-chave-999999', model: 'x/y' } } });
  assert.equal(getProvider().id, 'openrouter');
  assert.equal(getProvider().model, 'x/y');
  assert.equal(getProvider('deepseek').apiKey, 'sk-antiga-123456', 'a chave do DeepSeek continua lá');
  settings.updateSettings({ llmProvider: 'deepseek' });
  assert.equal(getProvider('openrouter').apiKey, 'or-chave-999999', 'e a do OpenRouter também');
  const pub = settings.publicSettings();
  assert.equal(pub.providers.custom.ready, true, 'personalizado não exige chave');
  assert.equal(pub.providers.anthropic.ready, false);
  assert.ok(!JSON.stringify(pub).includes('or-chave-999999'), 'a chave nunca vai inteira para a tela');
  assert.throws(() => settings.updateSettings({ llmProvider: 'nada' }), /desconhecido/);
});

test('histórico OpenAI → Anthropic: system à parte, tool_use e tool_result juntos', () => {
  const { system, messages } = toAnthropic([
    { role: 'system', content: 'regras' },
    { role: 'user', content: 'gera' },
    { role: 'assistant', content: 'vou gerar', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_workflow', arguments: '{"name":"a"}' } }, { id: 'c2', type: 'function', function: { name: 'look_at', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'c2', content: '{"ok":false}' },
    { role: 'user', content: 'e agora?' },
  ]);
  assert.equal(system, 'regras');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(messages[1].content[1], { type: 'tool_use', id: 'c1', name: 'run_workflow', input: { name: 'a' } });
  assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
});

test('resposta do Claude volta no formato OpenAI e o conteúdo original vai junto', () => {
  const content = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Pronto.' }, { type: 'tool_use', id: 't1', name: 'look_at', input: { asset_id: 'asset_1' } }];
  const m = fromAnthropic({ content, stop_reason: 'tool_use' });
  assert.equal(m.content, 'Pronto.');
  assert.deepEqual(m.tool_calls, [{ id: 't1', type: 'function', function: { name: 'look_at', arguments: '{"asset_id":"asset_1"}' } }]);
  assert.equal(m._anthropic, content);
  // e na volta para a Anthropic, o bloco de raciocínio vai intacto
  const back = toAnthropic([{ role: 'user', content: 'oi' }, m, { role: 'tool', tool_call_id: 't1', content: 'ok' }]);
  assert.equal(back.messages[1].content, content);
  const refused = fromAnthropic({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } });
  assert.match(refused.content, /recusou.*cyber/);
});

test('modelo local: conversa num texto só e resposta em JSON com chamadas', () => {
  const tools = [{ name: 'look_at', description: 'Olha uma imagem. Mais texto.', parameters: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } }];
  const prompt = localPrompt([{ role: 'system', content: 'regras' }, { role: 'user', content: 'olha' }], tools);
  assert.match(prompt, /### SISTEMA\nregras/);
  assert.match(prompt, /- look_at\(asset_id: string\): Olha uma imagem\./);
  assert.match(prompt, /### ASSISTENTE$/);
  const r = parseLocalReply('```json\n{"say":"vou olhar","calls":[{"name":"look_at","arguments":{"asset_id":"asset_9"}}]}\n```');
  assert.equal(r.content, 'vou olhar');
  assert.equal(r.tool_calls[0].function.name, 'look_at');
  assert.equal(JSON.parse(r.tool_calls[0].function.arguments).asset_id, 'asset_9');
  assert.deepEqual(parseLocalReply('Oi! Tudo bem?'), { role: 'assistant', content: 'Oi! Tudo bem?' });
});
