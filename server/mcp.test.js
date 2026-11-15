import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, INSTRUCTIONS } from './mcp.js';

test('MCP expõe as ferramentas do agente com project_id, sem ask_user', () => {
  const tools = listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['create_project', 'get_asset', 'export_assets', 'ask_agent', 'wait_job', 'run_workflow', 'edit_media']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('ask_user'));
  assert.equal(new Set(names).size, names.length, 'nomes repetidos');
  const run = tools.find((t) => t.name === 'run_workflow');
  assert.deepEqual(run.inputSchema.required.slice(0, 2), ['project_id', 'name']);
  assert.ok(run.inputSchema.properties.wait_seconds);
  const list = tools.find((t) => t.name === 'list_workflows');
  assert.ok(!list.inputSchema.properties.project_id, 'catálogo não precisa de projeto');
  for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);
  assert.match(INSTRUCTIONS, /wait_job/);
});

test('MCP recusa ferramenta desconhecida e tarefa inexistente', async () => {
  await assert.rejects(callTool('nao_existe', {}), /desconhecida/);
  await assert.rejects(callTool('wait_job', { job_id: 'job_x' }), /não encontrada/);
});
