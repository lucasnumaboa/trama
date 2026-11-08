// Testa os workflows do registro de capacidades no ComfyUI local.
//   node tools/test_workflows.mjs            roda os rápidos e valida os pesados
//   node tools/test_workflows.mjs --validate só valida (nada é gerado)
// "Validar" = o ComfyUI aceita o prompt (arquivos de modelo, valores, ligações);
// o pedido é tirado da fila logo em seguida.
import { listCapabilities } from '../server/capabilities.js';
import { buildPrompt, runWorkflow, describeByName } from '../server/exec.js';
import * as comfy from '../server/comfy.js';
import { getSettings } from '../server/settings.js';

const onlyValidate = process.argv.includes('--validate');
const HEAVY = /video|ampliar_video|troca_personagem|trocar_voz|musica_com_voz/;
// Arquivos de entrada para os testes (precisam existir no ComfyUI).
const SAMPLE = {
  image: { filename: process.env.TRAMA_TEST_IMAGE || 'z-image-turbo-3x_00127_.png', subfolder: '', type: 'output' },
  video: { filename: process.env.TRAMA_TEST_VIDEO || 'trama_h3_quadros_00001_.mp4', subfolder: 'video', type: 'output' },
  audio: { filename: process.env.TRAMA_TEST_AUDIO || 'trama_musica_00001.mp3', subfolder: 'audio', type: 'output' },
};

async function inputsFor(name) {
  const d = await describeByName(name);
  const media = {};
  for (const m of d.mediaInputs) media[m.id] = SAMPLE[m.kind];
  const values = {};
  const text = d.fields.find((f) => f.kind === 'text');
  if (text) values[text.id] = d.mediaInputs.some((m) => m.kind === 'image') ? 'make it look like a watercolor painting, keep the composition' : 'a red apple on a wooden table, soft studio light, photo';
  const dur = d.fields.find((f) => f.kind === 'number' && /dura|second/i.test(`${f.label} ${f.nodeTitle} ${f.input}`));
  if (dur && !HEAVY.test(name)) values[dur.id] = 15;
  return { media, values };
}

async function validate(name) {
  const { prompt } = await buildPrompt({ name, ...(await inputsFor(name)) });
  const res = await fetch(`${getSettings().comfyUrl}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: 'trama-validate' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const det = Object.entries(body.node_errors || {}).flatMap(([id, e]) => (e.errors || []).map((x) => `${prompt[id]?._meta?.title || id}: ${x.message} ${x.details || ''}`));
    throw new Error(`${body.error?.message || res.status} ${det.join('; ')}`);
  }
  await comfy.deleteFromQueue([body.prompt_id]);
  await comfy.interrupt(body.prompt_id);
  return 'aceito pelo ComfyUI';
}

async function run(name) {
  const t0 = Date.now();
  const { files } = await runWorkflow({ name, ...(await inputsFor(name)) });
  if (!files.length) throw new Error('terminou sem arquivos');
  return `${files.length} arquivo(s): ${files.map((f) => `${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`).join(', ')} em ${Math.round((Date.now() - t0) / 1000)}s`;
}

const names = new Set((await comfy.listWorkflows()).map((w) => w.name));
// Filtros opcionais: --only <regex> roda só esses; --skip <regex> pula esses.
const argOf = (flag) => (process.argv.includes(flag) ? new RegExp(process.argv[process.argv.indexOf(flag) + 1]) : null);
const only = argOf('--only');
const skip = argOf('--skip');
for (const cat of listCapabilities()) {
  for (const m of cat.models) {
    if ((only && !only.test(m.workflow)) || (skip && skip.test(m.workflow))) continue;
    const label = `${cat.label} | ${m.label}`.padEnd(78);
    if (!names.has(m.workflow)) { console.log('FALTA', label, `(${m.workflow} não está no ComfyUI)`); continue; }
    const mode = onlyValidate || HEAVY.test(m.workflow) ? 'validar' : 'rodar';
    try {
      console.log(mode === 'rodar' ? 'OK RUN' : 'OK VAL', label, mode === 'rodar' ? await run(m.workflow) : await validate(m.workflow));
    } catch (e) {
      console.log('ERRO  ', label, e.message.slice(0, 300));
    }
  }
}
