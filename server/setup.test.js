// Manifesto de "Preparar ComfyUI" conferido contra os workflows empacotados, e a
// detecção (o que falta por workflow) com um /object_info montado à mão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// capabilities.js lê os padrões de DATA_DIR: usa uma pasta vazia para não pegar os do usuário.
process.env.TRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trama-setup-test-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const { NODE_PACKS, MODELS, WORKFLOWS, modelSize, pipOf, pipName, pipVersion, packOfClass } = await import('./setup-manifest.js');
const { scanWorkflow, comboHas, evaluateWorkflow, missingSummary, planInstall, bundledWorkflowNames, BUNDLED_WORKFLOWS_DIR, BUNDLED_NODES_DIR } = await import('./setup.js');
const { capabilityPromptBlock, listCapabilities } = await import('./capabilities.js');
const { PATCHES, applyEdits, isPatched } = await import('./setup-patches.js');

const CORE = new Set(JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'core_nodes.json'), 'utf8')).classes);
const load = (name) => JSON.parse(fs.readFileSync(path.join(BUNDLED_WORKFLOWS_DIR, name), 'utf8'));

/** /object_info de mentira: cada nó do workflow com uma lista que contém os modelos dele. */
function fakeInfo(workflow, { drop = [], dropModels = [] } = {}) {
  const { classes, models } = scanWorkflow(workflow);
  const info = {};
  for (const c of classes) {
    if (drop.includes(c)) continue;
    const values = models.filter((m) => m.classType === c && !dropModels.includes(m.value)).map((m) => m.value);
    info[c] = { input: { required: { model_name: [values.length ? values : ['outro.safetensors']] } } };
  }
  return info;
}

// ---- Manifesto x workflows empacotados -------------------------------------------

test('todo workflow empacotado está no manifesto e vice-versa, todos com prefixo trama_', () => {
  const bundled = bundledWorkflowNames();
  assert.ok(bundled.length >= 30, `poucos workflows em comfy-workflows/: ${bundled.length}`);
  assert.deepEqual([...bundled].sort(), Object.keys(WORKFLOWS).sort());
  for (const name of bundled) assert.match(name, /^trama_.*\.json$/);
});

test('ComfyUI-Trama vem junto com o Trama', () => {
  assert.ok(fs.existsSync(path.join(BUNDLED_NODES_DIR, 'ComfyUI-Trama', '__init__.py')));
});

test('cada modelo citado num workflow está no manifesto dele, e nenhum sobra', () => {
  for (const name of Object.keys(WORKFLOWS)) {
    const files = new Set(WORKFLOWS[name].models.flatMap((id) => MODELS[id].files.map((f) => f.name)));
    const { models } = scanWorkflow(load(name));
    for (const m of models) assert.ok(files.has(m.value), `${name}: ${m.value} (${m.classType}) não está em WORKFLOWS`);
    // Os modelos que o workflow não cita (pastas que o nó lê sozinho) têm de ser de um nó do workflow.
    const cited = new Set(models.map((m) => m.value));
    for (const id of WORKFLOWS[name].models) {
      const named = MODELS[id].files.some((f) => cited.has(f.name));
      assert.ok(named || WORKFLOWS[name].packs.length, `${name}: ${id} não é citado e o workflow não tem nó de terceiros`);
    }
  }
});

test('nós fora do ComfyUI têm pacote no manifesto, listado no workflow', () => {
  for (const name of Object.keys(WORKFLOWS)) {
    const { classes } = scanWorkflow(load(name));
    for (const c of classes) {
      const pack = packOfClass(c);
      if (!pack) assert.ok(CORE.has(c), `${name}: ${c} não é nó do ComfyUI ${'0.43.0'} nem de NODE_PACKS`);
      else assert.ok(WORKFLOWS[name].packs.includes(pack), `${name}: usa ${c} mas não lista ${pack}`);
    }
  }
});

test('modelos e pacotes citados existem; nada sobra no manifesto', () => {
  const usedModels = new Set(Object.values(WORKFLOWS).flatMap((w) => w.models));
  const usedPacks = new Set(Object.values(WORKFLOWS).flatMap((w) => w.packs));
  for (const id of usedModels) assert.ok(MODELS[id], `modelo ${id} sem entrada em MODELS`);
  for (const id of usedPacks) assert.ok(NODE_PACKS[id], `nó ${id} sem entrada em NODE_PACKS`);
  assert.deepEqual(Object.keys(MODELS).filter((id) => !usedModels.has(id)), []);
  assert.deepEqual(Object.keys(NODE_PACKS).filter((id) => !usedPacks.has(id)), []);
});

test('nós de terceiros têm repositório e commit travado; pip tudo com ==', () => {
  for (const [id, p] of Object.entries(NODE_PACKS)) {
    if (!p.bundled) {
      assert.match(p.repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, id);
      assert.match(p.ref, /^[0-9a-f]{40}$/, `${id}: commit completo`);
    }
    for (const x of p.pip) assert.ok(pipVersion(x.spec), `${id}: ${x.spec} sem versão travada`);
  }
  const ort = NODE_PACKS['ComfyUI-ReActor'].pip.find((x) => pipName(x.spec) === 'onnxruntime-gpu');
  // 1.32 exige CUDA 13 e cai na CPU com o torch cu126.
  assert.equal(ort.spec, 'onnxruntime-gpu==1.24.4');
  assert.equal(ort.exact, true);
});

test('modelos: tamanho, pasta e URL https (ou à mão / baixado pelo nó)', () => {
  for (const [id, m] of Object.entries(MODELS)) {
    assert.ok(m.dir && !m.dir.startsWith('/') && !m.dir.includes('..'), id);
    assert.ok(modelSize(id) > 0, `${id} sem tamanho`);
    for (const f of m.files) {
      assert.ok(f.size > 0, `${id}/${f.name}`);
      if (f.url) assert.match(f.url, /^https:\/\/(huggingface\.co|github\.com)\//, `${id}/${f.name}`);
      else assert.ok(m.auto || m.source || id === 'h3_character_swap_pro4500_1000.safetensors', `${id}/${f.name} sem URL`);
    }
  }
});

test('pipOf junta sem repetir', () => {
  const specs = pipOf(['ComfyUI_Seed-VC', 'ComfyUI-MelBandRoFormer']).map((p) => pipName(p.spec));
  assert.equal(specs.filter((n) => n === 'einops').length, 1);
});

// ---- Leitura do workflow ------------------------------------------------------------

test('subgrafo de um nó mudo não entra (Flux.2 Klein base desligado)', () => {
  const { models } = scanWorkflow(load('trama_imagem_flux2_klein.json'));
  const values = models.map((m) => m.value);
  assert.ok(values.includes('flux-2-klein-4b-fp8.safetensors'));
  assert.ok(!values.includes('flux-2-klein-base-4b.safetensors'));
});

test('comboHas entende lista antiga e COMBO novo', () => {
  assert.ok(comboHas({ input: { required: { a: [['x.onnx', 'y.onnx']] } } }, 'y.onnx'));
  assert.ok(comboHas({ input: { optional: { a: ['COMBO', { options: ['z.pth'] }] } } }, 'z.pth'));
  assert.ok(!comboHas({ input: { required: { a: ['INT', {}] } } }, 'z.pth'));
});

// ---- Detecção --------------------------------------------------------------------------

const FACE = 'trama_face_swap_video.json';

test('ComfyUI sem o ReActor: falta o nó, o workflow e os modelos', () => {
  const wf = load(FACE);
  const s = evaluateWorkflow(FACE, { workflow: null, bundled: wf, objectInfo: fakeInfo(wf, { drop: ['ReActorFaceSwap'] }), files: () => false, packDir: () => false });
  assert.equal(s.ready, false);
  assert.equal(s.inComfy, 'missing');
  assert.deepEqual(s.packs, [{ id: 'ComfyUI-ReActor', status: 'missing' }]);
  assert.deepEqual(s.missingModels.sort(), ['GPEN-BFR-512.onnx', 'inswapper_128.onnx', 'vit-base-nsfw-detector']);
  assert.equal(s.models.find((m) => m.id === 'buffalo_l').status, 'auto');
  assert.equal(s.missingBytes, modelSize('GPEN-BFR-512.onnx') + modelSize('inswapper_128.onnx') + modelSize('vit-base-nsfw-detector'));
  const text = missingSummary(s);
  assert.match(text, /não está salvo/);
  assert.match(text, /ComfyUI-ReActor/);
});

test('pasta do nó existe mas não carregou: pede para reiniciar', () => {
  const wf = load(FACE);
  const s = evaluateWorkflow(FACE, { workflow: wf, bundled: wf, objectInfo: fakeInfo(wf, { drop: ['ReActorFaceSwap'] }), files: () => true, packDir: () => true });
  assert.equal(s.packs[0].status, 'not_loaded');
  assert.match(missingSummary(s), /reinicie o ComfyUI/);
});

test('tudo instalado: pronto; ComfyUI em outra máquina não derruba (modelos de pasta ficam "unknown")', () => {
  const wf = load(FACE);
  const s = evaluateWorkflow(FACE, { workflow: wf, bundled: wf, objectInfo: fakeInfo(wf), files: () => null, packDir: () => null });
  assert.equal(s.ready, true);
  assert.equal(s.models.find((m) => m.id === 'inswapper_128.onnx').status, 'ok'); // pela lista do nó
  assert.equal(s.models.find((m) => m.id === 'vit-base-nsfw-detector').status, 'unknown');
});

test('modelo fora da lista do nó conta como faltando mesmo sem olhar o disco', () => {
  const name = 'trama_imagem_z_image_turbo.json';
  const wf = load(name);
  const s = evaluateWorkflow(name, { workflow: wf, bundled: wf, objectInfo: fakeInfo(wf, { dropModels: ['z_image_turbo_bf16.safetensors'] }), files: () => null });
  assert.equal(s.ready, false);
  assert.deepEqual(s.missingModels, ['z_image_turbo_bf16.safetensors']);
});

test('nó do próprio ComfyUI faltando: ComfyUI antigo', () => {
  const name = 'trama_3d_trellis2.json';
  const wf = load(name);
  const s = evaluateWorkflow(name, { workflow: wf, bundled: wf, objectInfo: fakeInfo(wf, { drop: ['Trellis2ShapeStage'] }), files: () => true, packDir: () => true });
  assert.deepEqual(s.coreMissing, ['Trellis2ShapeStage']);
  assert.match(missingSummary(s), /atualize/);
});

test('workflow salvo diferente do empacotado e ComfyUI-Trama desatualizado', () => {
  const name = 'trama_3d_animar.json';
  const wf = load(name);
  const edited = { ...wf, extra: { mudou: true } };
  const s = evaluateWorkflow(name, { workflow: edited, bundled: wf, objectInfo: fakeInfo(wf, { drop: [] }), files: () => true, packDir: () => true, tramaNode: 'outdated' });
  assert.equal(s.inComfy, 'different');
  assert.ok(s.packs.some((p) => p.id === 'ComfyUI-Trama' && p.status === 'outdated'));
});

test('pip: onnxruntime-gpu 1.32 é versão errada; com CUDA 13 o Trama não escolhe a versão', () => {
  const wf = load(FACE);
  const base = { workflow: wf, bundled: wf, objectInfo: fakeInfo(wf), files: () => true, packDir: () => true };
  const all = new Map(pipOf(['ComfyUI-ReActor']).map((p) => [pipName(p.spec), pipVersion(p.spec)]));
  assert.equal(evaluateWorkflow(FACE, { ...base, pip: all, cuda: '12' }).ready, true);
  const wrong = new Map(all).set('onnxruntime-gpu', '1.32.0');
  const s = evaluateWorkflow(FACE, { ...base, pip: wrong, cuda: '12' });
  assert.equal(s.pip.find((p) => p.name === 'onnxruntime-gpu').status, 'wrong');
  assert.equal(s.ready, false);
  assert.match(missingSummary(s), /onnxruntime-gpu 1\.32\.0 \(precisa 1\.24\.4\)/);
  const missing = new Map(all);
  missing.delete('onnxruntime-gpu');
  assert.equal(evaluateWorkflow(FACE, { ...base, pip: missing, cuda: '13' }).pip.find((p) => p.name === 'onnxruntime-gpu').status, 'cuda');
  // opencv-python-headless serve no lugar do opencv-python
  const headless = new Map(all);
  headless.delete('opencv-python');
  headless.set('opencv-python-headless', '4.10.0');
  assert.equal(evaluateWorkflow(FACE, { ...base, pip: headless, cuda: '12' }).pip.find((p) => p.name === 'opencv-python').status, 'ok');
});

test('workflow do usuário com nó solto de interface não é marcado como indisponível', () => {
  const wf = {
    nodes: [
      { id: 1, type: 'Fast Groups Bypasser (rgthree)', mode: 0, inputs: [], outputs: [] },
      { id: 2, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', link: 1 }], outputs: [], widgets_values: ['x'] },
    ],
  };
  const s = evaluateWorkflow('meu.json', { workflow: wf, objectInfo: { SaveImage: { input: { required: {} } } } });
  assert.equal(s.ready, true);
  const linked = { nodes: [{ id: 3, type: 'NoInexistente', mode: 0, inputs: [], outputs: [{ links: [4] }] }] };
  assert.deepEqual(evaluateWorkflow('meu.json', { workflow: linked, objectInfo: {} }).unknownNodes, ['NoInexistente']);
});

// ---- Plano de instalação ---------------------------------------------------------------

function statusOf(entries, base = { tramaNode: 'ok' }) {
  return { comfy: { online: true }, base, categories: [{ id: 'x', label: 'x', workflows: entries }] };
}

test('plano: só os escolhidos, modelos sem repetir, nunca workflow sem trama_', () => {
  const wf = load('trama_trocar_voz.json');
  const voz = evaluateWorkflow('trama_trocar_voz.json', { workflow: null, bundled: wf, objectInfo: {}, files: () => false, packDir: () => false, pip: new Map(), cuda: '12' });
  const wf2 = load('trama_trocar_voz_musica.json');
  const musica = evaluateWorkflow('trama_trocar_voz_musica.json', { workflow: null, bundled: wf2, objectInfo: {}, files: () => false, packDir: () => false, pip: new Map(), cuda: '12', tramaNode: null });
  const pessoal = { ...voz, name: 'meu_workflow.json' };
  const plan = planInstall(statusOf([voz, musica, pessoal]), { workflows: ['trama_trocar_voz.json', 'trama_trocar_voz_musica.json', 'meu_workflow.json'] });
  assert.deepEqual(plan.workflows.sort(), ['trama_trocar_voz.json', 'trama_trocar_voz_musica.json']);
  assert.deepEqual(plan.packs.map((p) => `${p.id}:${p.action}`).sort(), ['ComfyUI-MelBandRoFormer:clone', 'ComfyUI-Trama:copy', 'ComfyUI_Seed-VC:clone']);
  assert.equal(plan.models.filter((m) => m === 'Seed-VC').length, 1);
  assert.equal(plan.bytes, plan.models.reduce((s, id) => s + modelSize(id), 0));
  assert.ok(plan.pip.includes('librosa==1.0.0'));
  assert.equal(plan.pip.filter((s) => s.startsWith('einops')).length, 1);
});

test('plano: atualizar a base troca os trama_ diferentes e o ComfyUI-Trama', () => {
  const wf = load('trama_ampliar_imagem.json');
  const diff = evaluateWorkflow('trama_ampliar_imagem.json', { workflow: { ...wf, x: 1 }, bundled: wf, objectInfo: fakeInfo(wf), files: () => true });
  const plan = planInstall(statusOf([diff], { tramaNode: 'outdated' }), { workflows: [], updateBase: true });
  assert.deepEqual(plan.workflows, ['trama_ampliar_imagem.json']);
  assert.deepEqual(plan.packs, [{ id: 'ComfyUI-Trama', action: 'copy' }]);
  assert.equal(plan.bytes, 0);
});

// ---- Agente ------------------------------------------------------------------------------

test('agente: padrão indisponível sai das opções e vira o primeiro que roda', () => {
  const availability = new Map([
    ['trama_imagem_z_image_turbo.json', { ok: false, reason: 'falta o modelo z_image_turbo_bf16.safetensors' }],
    ['trama_imagem_qwen_image.json', { ok: true, reason: '' }],
    ['trama_face_swap_video.json', { ok: false, reason: 'falta o nó ComfyUI-ReActor' }],
  ]);
  const block = capabilityPromptBlock({}, availability);
  const line = block.split('\n').find((l) => l.startsWith('- Criar imagem'));
  assert.match(line, /padrão "Qwen-Image/);
  assert.doesNotMatch(line, /z_image_turbo/);
  assert.match(block, /Indisponíveis.*trama_face_swap_video\.json \(falta o nó ComfyUI-ReActor\)/);
  assert.match(block.split('\n').find((l) => l.startsWith('- Criar música')), /nenhum modelo instalado/);
  const caps = listCapabilities({ availability });
  const face = caps.find((c) => c.id === 'video_edit').models.find((m) => m.workflow === 'trama_face_swap_video.json');
  assert.equal(face.available, false);
  assert.equal(face.missing, 'falta o nó ComfyUI-ReActor');
});

test('lip sync: tudo instalável, o ffmpeg vem do imageio-ffmpeg', () => {
  const name = 'trama_lip_sync_video.json';
  const wf = load(name);
  const s = evaluateWorkflow(name, { workflow: null, bundled: wf, objectInfo: fakeInfo(wf, { drop: ['LatentSyncNode', 'VideoLengthAdjuster', 'VHS_LoadVideo'] }), files: () => false, packDir: () => false });
  assert.equal(s.models.find((m) => m.id === 'latentsync-ffmpeg').status, 'missing'); // copiado, não "à mão"
  const plan = planInstall(statusOf([s]), { workflows: [name] });
  assert.deepEqual(plan.packs.map((p) => `${p.id}:${p.action}`).sort(), ['ComfyUI-LatentSyncWrapper:clone', 'ComfyUI-ReActor:clone', 'ComfyUI-VideoHelperSuite:clone']);
  assert.ok(plan.models.includes('latentsync_unet.pt'));
  assert.ok(!plan.models.includes('buffalo_l'));
});

test('nó instalado sem os ajustes do Trama: não está pronto e o plano ajusta', () => {
  const name = 'trama_lip_sync_video.json';
  const wf = load(name);
  const info = { ...fakeInfo(wf), ReActorFaceSwap: { input: { required: {} } } }; // o lip sync usa o ReActor por baixo
  const s = evaluateWorkflow(name, { workflow: wf, bundled: wf, objectInfo: info, files: () => true, packDir: () => true, packPatched: (id) => (id === 'ComfyUI-LatentSyncWrapper' ? false : null) });
  assert.equal(s.ready, false);
  assert.equal(s.packs.find((p) => p.id === 'ComfyUI-LatentSyncWrapper').status, 'unpatched');
  assert.match(missingSummary(s), /sem os ajustes do Trama/);
  assert.deepEqual(planInstall(statusOf([s]), { workflows: [name] }).packs, [{ id: 'ComfyUI-LatentSyncWrapper', action: 'patch' }]);
  const ok = evaluateWorkflow(name, { workflow: wf, bundled: wf, objectInfo: info, files: () => true, packDir: () => true, packPatched: () => true });
  assert.equal(ok.ready, true);
});

test('ajustes: aplicam uma vez, mantêm CRLF e recusam arquivo diferente', () => {
  const edits = [{ find: 'a = 1', replace: 'a = 2  # Trama' }, { find: 'import x', replace: 'import y' }];
  const r = applyEdits('import x\r\na = 1\r\n', edits);
  assert.equal(r.state, 'applied');
  assert.equal(r.text, 'import y\r\na = 2  # Trama\r\n');
  assert.equal(applyEdits(r.text, edits).state, 'patched');
  assert.ok(isPatched(r.text, edits));
  assert.equal(applyEdits('import z\na = 1\n', edits).state, 'mismatch');
  assert.equal(applyEdits('a = 1\na = 1\nimport x', edits).state, 'mismatch'); // trecho repetido: não chuta
});

test('ajustes do manifesto: cada trecho a procurar é diferente do que entra no lugar', () => {
  for (const [id, files] of Object.entries(PATCHES)) {
    assert.ok(NODE_PACKS[id]?.repo, `${id} sem nó no manifesto`);
    for (const p of files) for (const e of p.edits) {
      assert.ok(e.find && e.replace && e.find !== e.replace, `${id}/${p.file}`);
      assert.ok(!e.find.includes(String.fromCharCode(13)), `${id}/${p.file}: use \n`);
    }
  }
});
