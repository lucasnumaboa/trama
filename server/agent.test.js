import test from 'node:test';
import assert from 'node:assert/strict';
import { repairHistory } from './agent.js';

const call = (id, name = 'run_workflow') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const tool = (id, content = '{"ok":true}') => ({ role: 'tool', tool_call_id: id, content });

test('histórico em ordem fica como está', () => {
  const llm = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: '', tool_calls: [call('a'), call('b')] },
    tool('a'),
    tool('b'),
    { role: 'assistant', content: 'pronto' },
  ];
  const r = repairHistory(llm);
  assert.equal(r.changed, false);
  assert.deepEqual(r.messages, llm);
});

test('servidor caiu no meio da segunda ferramenta: a chamada ganha "interrompido" logo depois', () => {
  const llm = [
    { role: 'user', content: 'gera as cenas' },
    { role: 'assistant', content: '', tool_calls: [call('a'), call('b')] },
    tool('a'),
    // queda aqui; depois o usuário mandou "continue"
    { role: 'user', content: 'continue' },
  ];
  const r = repairHistory(llm);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages.map((m) => m.role + (m.tool_call_id ? `:${m.tool_call_id}` : '')), ['user', 'assistant', 'tool:a', 'tool:b', 'user']);
  assert.match(r.messages[3].content, /interrompido/);
});

test('respostas soltas ou repetidas saem', () => {
  const llm = [
    { role: 'user', content: 'x' },
    tool('perdida'),
    { role: 'assistant', content: '', tool_calls: [call('a')] },
    tool('a'),
    tool('a'),
    tool('outra'),
    { role: 'user', content: 'y' },
    // chamada no fim, sem resposta (queda antes da primeira ferramenta)
    { role: 'assistant', content: '', tool_calls: [call('z')] },
  ];
  const r = repairHistory(llm);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages.map((m) => m.role + (m.tool_call_id ? `:${m.tool_call_id}` : '')), ['user', 'assistant', 'tool:a', 'user', 'assistant', 'tool:z']);
});
