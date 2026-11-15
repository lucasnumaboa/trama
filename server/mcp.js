// Servidor MCP do Trama: deixa um agente de fora (Claude Code, Codex, Cursor, outro
// harness) usar o Trama como estúdio. Ele cria projetos, gera imagens, música,
// vídeo, voz e modelos 3D pelos workflows do ComfyUI e pega os arquivos prontos
// para usar no que estiver construindo (um jogo, um site, um vídeo).
//
// Transporte: Streamable HTTP em /mcp, sem sessão (cada requisição tem o próprio
// servidor). Gerações longas viram tarefas: a chamada espera até wait_seconds e,
// se não terminou, devolve o job_id para acompanhar com wait_job.
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS, runTool, workflowCatalog } from './tools.js';
import { listProjects, getProject, createProject, saveProject, emit, shortId, describeAsset, projectEvents } from './projects.js';
import { sendMessage, isRunning, stopAgent } from './agent.js';
import { listCapabilities, capabilityPromptBlock } from './capabilities.js';
import * as comfy from './comfy.js';
import { getProvider } from './llm.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_WAIT = 240; // s; clientes como o Codex cortam a chamada em 60 s se não configurar
const MAX_WAIT = 3600;
const INLINE_IMAGE_MAX = 4 * 1024 * 1024;

export const INSTRUCTIONS = `Trama é um estúdio criativo local que roda os workflows do ComfyUI do usuário (GPU local). Use para criar os assets do que você estiver construindo: concept art, sprites, texturas, ícones, personagens consistentes, música, efeitos e vozes, vídeo, modelos 3D com esqueleto e animações (andar, correr, pular, parado) prontos para jogo.

Como usar:
1. create_project (um projeto por trabalho; tudo aparece no canvas do Trama, que o usuário acompanha ao vivo) ou list_projects para continuar um.
2. list_capabilities mostra o que dá para gerar e o workflow padrão de cada categoria. get_workflow mostra os campos (ids) de um workflow; o texto vai no prompt_field.
3. run_workflow gera um card novo. Escreva os prompts em inglês, detalhados e visuais. Use os ids dos cards como entradas (inputs) dos próximos passos: imagem → vídeo, imagem → modelo 3D, personagem registrado com define_character → cenas com o mesmo personagem.
4. Para mudar um card: revise_asset (gera de novo, nova versão) ou edit_media (corte, tamanho, formato, volume; instantâneo).
5. get_asset devolve o caminho do arquivo neste computador e mostra a imagem; export_assets copia os arquivos para a pasta do seu projeto (ex.: assets/ do jogo).
6. Pedido grande e aberto? ask_agent passa o pedido ao agente interno do Trama, que planeja e gera sozinho. Ele pode devolver perguntas: responda chamando ask_agent de novo.

Gerações levam de segundos (imagem) a minutos (vídeo, 3D, música). Se a resposta vier com status "running", chame wait_job com o job_id até terminar; não rode o mesmo pedido de novo. Toda geração volta com "checks" e "warnings" (medidas reais do arquivo): leia antes de usar.`;

// ---- Tarefas ------------------------------------------------------------------
const jobs = new Map(); // job_id -> { id, tool, projectId, status, promise, controller, result, error, startedAt, progress }

function startJob(tool, projectId, run) {
  const controller = new AbortController();
  const job = { id: shortId('job'), tool, projectId, status: 'running', controller, startedAt: Date.now(), progress: null };
  job.promise = run(controller.signal, job).then(
    (result) => Object.assign(job, { status: 'done', result, finishedAt: Date.now() }),
    (error) => Object.assign(job, { status: controller.signal.aborted ? 'cancelled' : 'error', error: error.message, finishedAt: Date.now() }),
  );
  jobs.set(job.id, job);
  // Tarefas antigas saem da memória depois de uma hora.
  for (const [id, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > 3600_000) jobs.delete(id);
  return job;
}

async function awaitJob(job, waitSeconds, onTick) {
  const ms = Math.min(Math.max(Number(waitSeconds ?? DEFAULT_WAIT), 0), MAX_WAIT) * 1000;
  let timer;
  const tick = setInterval(() => onTick?.(job), 5000);
  try {
    await Promise.race([job.promise, new Promise((r) => (timer = setTimeout(r, ms)))]);
  } finally {
    clearTimeout(timer);
    clearInterval(tick);
  }
  return jobView(job);
}

function jobView(job) {
  if (job.status === 'done') return { job_id: job.id, status: 'done', ...job.result };
  if (job.status === 'running') {
    return {
      job_id: job.id,
      status: 'running',
      running_for_s: Math.round((Date.now() - job.startedAt) / 1000),
      ...(job.progress ? { progress: job.progress } : {}),
      next: 'Ainda gerando. Chame wait_job com este job_id (não rode o pedido de novo).',
    };
  }
  return { job_id: job.id, status: job.status, error: job.error };
}

// ---- Registro no chat do projeto ----------------------------------------------
// O que o agente de fora faz aparece no chat do Trama como uma mensagem "Via MCP",
// com um passo por chamada, para o usuário acompanhar.
function mcpMessage(p, client) {
  const last = p.messages[p.messages.length - 1];
  if (last?.source === 'mcp' && last.client === client && Date.now() - (last.updatedAt || last.createdAt) < 30 * 60_000) return last;
  const m = { id: shortId('msg'), role: 'assistant', source: 'mcp', client, parts: [], status: 'done', createdAt: Date.now() };
  p.messages.push(m);
  return m;
}

function findAsset(p, id) {
  const a = p.assets.find((x) => x.id === id);
  if (!a) throw new Error(`O card ${id} não existe no projeto ${p.id}. Use get_project para ver os cards.`);
  return a;
}

function currentFile(a) {
  const v = a.versions?.[a.current ?? a.versions.length - 1];
  return a.file || v?.file || null;
}

async function assetView(p, a) {
  const out = describeAsset(a);
  const file = currentFile(a);
  if (file) {
    out.file = await comfy.localPathOf(file).catch(() => null);
    out.url = comfy.viewUrl(file);
  }
  return out;
}

const slug = (s) => String(s || 'asset').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'asset';

// ---- Ferramentas ----------------------------------------------------------------
const PROJECT_ID = { type: 'string', description: 'Id do projeto (create_project ou list_projects)' };
const WAIT = { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: `Quanto esperar a geração, em segundos (padrão ${DEFAULT_WAIT}). Se passar disso, volta status "running" e um job_id para wait_job.` };
const NO_PROJECT = new Set(['list_workflows', 'get_workflow']);
const HIDDEN = new Set(['ask_user']); // o agente de fora pergunta ao usuário do jeito dele

const OWN_TOOLS = [
  {
    name: 'list_projects',
    description: 'Lista os projetos do Trama (id, título, última mudança).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description: 'Cria um projeto no Trama. Tudo que for gerado nele aparece no canvas do Trama, ligado às entradas.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Título do projeto (ex.: "Jogo do pato - assets")' } } },
  },
  {
    name: 'get_project',
    description: 'Mostra os cards de um projeto: id, tipo, título, status, prompt, receita, caminho do arquivo neste computador.',
    inputSchema: { type: 'object', properties: { project_id: PROJECT_ID }, required: ['project_id'] },
  },
  {
    name: 'list_capabilities',
    description: 'O que o Trama sabe gerar (categorias como criar imagem, editar imagem, imagem → vídeo, música, voz, modelo 3D) e o workflow padrão de cada uma, mais o catálogo de workflows do ComfyUI com entradas e saídas.',
    inputSchema: { type: 'object', properties: { project_id: { ...PROJECT_ID, description: 'Opcional: usa os modelos padrão escolhidos neste projeto' } } },
  },
  {
    name: 'get_asset',
    description: 'Detalhes de um card com o caminho do arquivo neste computador. Imagens voltam junto (para você ver), textos voltam inteiros.',
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID, asset_id: { type: 'string' }, include_content: { type: 'boolean', description: 'Padrão true: manda a imagem ou o texto junto' } },
      required: ['project_id', 'asset_id'],
    },
  },
  {
    name: 'export_assets',
    description: 'Copia os arquivos dos cards para uma pasta deste computador (ex.: a pasta assets do jogo). Devolve o caminho de cada arquivo copiado.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        asset_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        folder: { type: 'string', description: 'Pasta de destino, caminho absoluto. É criada se não existir.' },
        names: { type: 'object', additionalProperties: { type: 'string' }, description: 'Opcional: id do card -> nome do arquivo sem extensão (ex.: {"asset_ab12cd34": "player_idle"})' },
      },
      required: ['project_id', 'asset_ids', 'folder'],
    },
  },
  {
    name: 'ask_agent',
    description: 'Passa um pedido em linguagem natural ao agente interno do Trama, que planeja e gera sozinho (escolhe workflows, encadeia, confere). Bom para pedidos abertos ("crie a trilha do menu e 3 efeitos"). Volta a resposta do agente, os cards criados e, se ele tiver perguntas, as perguntas (responda chamando ask_agent de novo).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        message: { type: 'string', description: 'O pedido, em português ou inglês' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Ids de cards que o pedido usa' },
        wait_seconds: WAIT,
      },
      required: ['project_id', 'message'],
    },
  },
  {
    name: 'wait_job',
    description: 'Espera uma geração que voltou com status "running" e devolve o resultado quando terminar.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, wait_seconds: WAIT }, required: ['job_id'] },
  },
  {
    name: 'cancel_job',
    description: 'Cancela uma geração em andamento.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
];

function trama_tools() {
  return TOOL_SCHEMAS.filter((t) => !HIDDEN.has(t.name)).map((t) => {
    const props = { ...(t.parameters?.properties || {}) };
    const required = [...(t.parameters?.required || [])];
    if (!NO_PROJECT.has(t.name)) {
      props.project_id = PROJECT_ID;
      required.unshift('project_id');
      props.wait_seconds = WAIT;
    }
    return { name: t.name, description: t.description, inputSchema: { ...t.parameters, type: 'object', properties: props, required } };
  });
}

export function listTools() {
  return [...OWN_TOOLS, ...trama_tools()];
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });

/**
 * Executa uma ferramenta do MCP.
 * @param {string} name
 * @param {object} args
 * @param {{ client?: string, progress?: (message: string) => void }} opts
 */
export async function callTool(name, args = {}, { client = 'Agente externo', progress } = {}) {
  switch (name) {
    case 'list_projects':
      return text({ projects: listProjects().map((p) => ({ id: p.id, title: p.title, updated_at: new Date(p.updatedAt).toISOString() })) });

    case 'create_project': {
      const p = createProject(String(args.title || '').trim() || 'Novo projeto');
      return text({ project_id: p.id, title: p.title, note: 'O projeto aparece na lista do Trama; abra-o lá para acompanhar o canvas.' });
    }

    case 'get_project': {
      const p = getProject(args.project_id);
      const assets = [];
      for (const a of p.assets) assets.push(await assetView(p, a));
      return text({ project_id: p.id, title: p.title, agent_running: isRunning(p.id), assets });
    }

    case 'list_capabilities': {
      const p = args.project_id ? getProject(args.project_id) : null;
      const names = (await comfy.listWorkflows().catch(() => [])).map((w) => w.name);
      const caps = listCapabilities({ workflowNames: names.length ? names : null, overrides: p?.models || {} }).map((c) => ({
        id: c.id,
        label: c.label,
        default_workflow: c.models.find((m) => m.isDefault)?.workflow || null,
        options: c.models.filter((m) => m.available !== false).map((m) => ({ label: m.label, workflow: m.workflow })),
      }));
      const stats = await comfy.systemStats().catch(() => null);
      return text({
        comfyui: stats ? 'online' : 'offline',
        gpu: stats?.devices?.map((d) => `${d.name} (${Math.round(d.vram_total / 1e9)} GB)`),
        categories: caps,
        defaults: capabilityPromptBlock(p?.models || {}),
        workflows: await workflowCatalog().catch((e) => `não consegui ler os workflows: ${e.message}`),
      });
    }

    case 'get_asset': {
      const p = getProject(args.project_id);
      const a = findAsset(p, args.asset_id);
      const view = await assetView(p, a);
      const content = [{ type: 'text', text: JSON.stringify(view, null, 1) }];
      if (args.include_content !== false) {
        if (a.kind === 'text') content.push({ type: 'text', text: a.text || '' });
        const file = currentFile(a);
        if (a.kind === 'image' && file) {
          try {
            const buf = Buffer.from(await (await comfy.fetchFile(file)).arrayBuffer());
            const ext = path.extname(file.filename).toLowerCase();
            const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
            if (buf.length <= INLINE_IMAGE_MAX) content.push({ type: 'image', data: buf.toString('base64'), mimeType: mime });
            else content.push({ type: 'text', text: `A imagem tem ${(buf.length / 1e6).toFixed(1)} MB e não foi enviada junto; abra pelo caminho do arquivo.` });
          } catch (e) {
            content.push({ type: 'text', text: `Não consegui ler a imagem: ${e.message}` });
          }
        }
      }
      return { content };
    }

    case 'export_assets': {
      const p = getProject(args.project_id);
      const folder = String(args.folder || '');
      if (!path.isAbsolute(folder)) throw new Error('Passe a pasta de destino com o caminho absoluto.');
      fs.mkdirSync(folder, { recursive: true });
      const out = [];
      for (const id of args.asset_ids || []) {
        const a = findAsset(p, id);
        const file = currentFile(a);
        if (a.kind === 'text') {
          const dest = path.join(folder, `${slug(args.names?.[id] || a.title)}.md`);
          fs.writeFileSync(dest, a.text || '');
          out.push({ asset_id: id, file: dest });
          continue;
        }
        if (!file) {
          out.push({ asset_id: id, error: a.status === 'generating' ? 'ainda gerando' : 'o card não tem arquivo' });
          continue;
        }
        const dest = path.join(folder, `${slug(args.names?.[id] || a.title)}${path.extname(file.filename)}`);
        const buf = Buffer.from(await (await comfy.fetchFile(file)).arrayBuffer());
        fs.writeFileSync(dest, buf);
        out.push({ asset_id: id, file: dest, bytes: buf.length });
      }
      return text({ exported: out });
    }

    case 'ask_agent': {
      const p = getProject(args.project_id);
      const before = new Set(p.assets.map((a) => a.id));
      const { reply } = await sendMessage(p.id, {
        text: `${args.message}\n\n(Pedido feito por ${client} pelo MCP: não pergunte o que der para decidir; ele não vê o canvas.)`,
        attachments: args.attachments || [],
        provider: getProvider().id,
      });
      const job = startJob('ask_agent', p.id, (signal) => {
        signal.addEventListener('abort', () => stopAgent(p.id));
        return new Promise((resolve) => {
          const done = () => {
            projectEvents.off(p.id, onEvent);
            const parts = reply.parts || [];
            resolve({
              reply: parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n\n'),
              steps: parts.filter((x) => x.type === 'step').map((x) => `${x.status === 'error' ? '✗' : '✓'} ${x.label}${x.error ? ` (${x.error})` : ''}`),
              questions: parts.filter((x) => x.type === 'question').map((q) => ({ intro: q.intro, questions: q.questions })),
              errors: parts.filter((x) => x.type === 'error').map((x) => x.text),
              created: p.assets.filter((a) => !before.has(a.id)).map(describeAsset),
              agent_status: reply.status,
            });
          };
          const onEvent = (ev) => {
            if (ev.type === 'running' && !ev.running) done();
            if (ev.type === 'message' && ev.message.id === reply.id) {
              const step = [...(ev.message.parts || [])].reverse().find((x) => x.type === 'step');
              if (step) job.progress = step.label;
            }
          };
          projectEvents.on(p.id, onEvent);
          if (!isRunning(p.id)) done();
        });
      });
      return text(await awaitJob(job, args.wait_seconds, (j) => j.progress && progress?.(j.progress)));
    }

    case 'wait_job': {
      const job = jobs.get(args.job_id);
      if (!job) throw new Error(`Tarefa ${args.job_id} não encontrada (o Trama foi reiniciado ou ela terminou há mais de uma hora). Veja os cards com get_project.`);
      return text(await awaitJob(job, args.wait_seconds, (j) => j.progress && progress?.(j.progress)));
    }

    case 'cancel_job': {
      const job = jobs.get(args.job_id);
      if (!job) throw new Error(`Tarefa ${args.job_id} não encontrada.`);
      job.controller.abort();
      return text({ job_id: job.id, status: 'cancelling' });
    }

    default:
      break;
  }

  // Ferramentas do agente do Trama, rodando direto num projeto.
  const schema = TOOL_SCHEMAS.find((t) => t.name === name && !HIDDEN.has(t.name));
  if (!schema) throw new Error(`Ferramenta desconhecida: ${name}`);
  const { project_id: projectId, wait_seconds: wait, ...toolArgs } = args;
  const p = NO_PROJECT.has(name) ? null : getProject(projectId);
  if (!p) {
    const out = await runTool(name, toolArgs, { project: null, signal: undefined, step: () => {} });
    return text(out.result);
  }

  const msg = mcpMessage(p, client);
  const part = { type: 'step', id: shortId('mcp'), tool: name, label: '…', status: 'running', assetIds: [] };
  msg.parts.push(part);
  msg.updatedAt = Date.now();
  const push = () => emit(p.id, { type: 'message', message: msg });
  saveProject(p);
  push();

  const job = startJob(name, p.id, async (signal, j) => {
    // Progresso dos cards que esta chamada está gerando.
    const onEvent = (ev) => {
      if (ev.type !== 'asset' || !part.assetIds.includes(ev.asset.id) || ev.asset.status !== 'generating') return;
      const pct = typeof ev.asset.progress === 'number' ? ` ${Math.round(ev.asset.progress * 100)}%` : '';
      j.progress = `${ev.asset.title}: ${ev.asset.detail || 'gerando'}${pct}`;
    };
    projectEvents.on(p.id, onEvent);
    try {
      const out = await runTool(name, toolArgs, {
        project: p,
        signal,
        step: (patch) => {
          Object.assign(part, patch);
          if (patch.label) j.progress = patch.label;
          push();
        },
      });
      Object.assign(part, { label: out.label, status: 'done', assetIds: out.assetIds || part.assetIds, warnings: out.warnings?.length ? out.warnings : undefined });
      const result = { ...out.result };
      // Caminho dos arquivos criados, para o agente de fora usar direto.
      if (Array.isArray(result.created)) {
        result.created = await Promise.all(result.created.map(async (c) => {
          const a = p.assets.find((x) => x.id === c.id);
          return a ? { ...c, ...(await assetView(p, a)) } : c;
        }));
      }
      return result;
    } catch (error) {
      Object.assign(part, { status: 'error', error: error.message, label: part.label === '…' ? `Falhou: ${name}` : part.label });
      throw error;
    } finally {
      projectEvents.off(p.id, onEvent);
      msg.updatedAt = Date.now();
      saveProject(p);
      push();
    }
  });
  const view = await awaitJob(job, wait, (j) => j.progress && progress?.(j.progress));
  if (view.status === 'error') throw new Error(view.error);
  return text(view);
}

// ---- HTTP -----------------------------------------------------------------------
function clientName(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (/claude-code|claude/i.test(ua)) return 'Claude Code';
  if (/codex/i.test(ua)) return 'Codex';
  if (/cursor/i.test(ua)) return 'Cursor';
  return String(req.query.client || '').slice(0, 40) || 'Agente externo';
}

function buildServer(client) {
  const server = new Server({ name: 'trama', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const token = request.params._meta?.progressToken;
    let n = 0;
    const progress = token === undefined
      ? undefined
      : (message) => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } }).catch(() => {});
    try {
      return await callTool(request.params.name, request.params.arguments || {}, { client, progress });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}

/** Liga o MCP no app Express em /mcp. */
export function mountMcp(app, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  app.post('/mcp', async (req, res) => {
    const server = buildServer(clientName(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection: true, allowedHosts: hosts });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    }
  });
  const notAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST (MCP sem sessão).' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
