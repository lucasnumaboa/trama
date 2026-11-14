import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, meshStats, glbToStl, glbToObj, exportModel } from './model3d.js';

// Monta um GLB com uma caixa (8 vértices, 12 triângulos) de 2 x 4 x 1 num nó com escala 0,5
// e translação, como o Trellis/Pixal3D salvam (uma malha num nó).
function boxGlb({ uv = true } = {}) {
  const [sx, sy, sz] = [1, 2, 0.5];
  const pos = [];
  for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) pos.push(x, y, z);
  const tri = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  const uvs = pos.length / 3 === 8 ? Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.25 : 0.75)) : [];
  const parts = [new Float32Array(pos), new Uint16Array(tri), ...(uv ? [new Float32Array(uvs)] : [])];
  const views = [];
  const chunks = [];
  let off = 0;
  for (const a of parts) {
    const b = Buffer.from(a.buffer);
    const pad = (4 - (b.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    chunks.push(b, Buffer.alloc(pad));
    off += b.length + pad;
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, scale: [0.5, 0.5, 0.5], translation: [3, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(uv ? { TEXCOORD_0: 2 } : {}) }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      ...(uv ? [{ bufferView: 2, componentType: 5126, count: 8, type: 'VEC2' }] : []),
    ],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([head, ch(0x4e4f534a, js), ch(0x004e4942, bin)]);
}

test('lê o GLB e mede a malha com a transformação do nó', () => {
  const glb = boxGlb();
  assert.equal(parseGlb(glb).json.meshes.length, 1);
  assert.deepEqual(meshStats(glb), { triangles: 12, vertices: 8, size: [1, 2, 0.5], textured: false });
});

test('STL: Z para cima, no chão, centralizado e na altura pedida em mm', () => {
  const stl = glbToStl(boxGlb(), { heightMm: 100 });
  assert.equal(stl.readUInt32LE(80), 12);
  assert.equal(stl.length, 84 + 12 * 50);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < 12; t++) {
    for (let v = 0; v < 3; v++) {
      for (let i = 0; i < 3; i++) {
        const x = stl.readFloatLE(84 + t * 50 + 12 + v * 12 + i * 4);
        min[i] = Math.min(min[i], x);
        max[i] = Math.max(max[i], x);
      }
    }
  }
  const r = (x) => Math.round(x * 1000) / 1000;
  // altura (Y do glTF = 2) vira Z = 100 mm; largura 1 → 50 mm; profundidade 0,5 → 25 mm
  assert.deepEqual(min.map(r), [-25, -12.5, 0]);
  assert.deepEqual(max.map(r), [25, 12.5, 100]);
});

test('OBJ com UV (V invertido) e faces numeradas a partir de 1', () => {
  const obj = glbToObj(boxGlb()).toString();
  const lines = obj.trim().split('\n');
  assert.equal(lines.filter((l) => l.startsWith('v ')).length, 8);
  assert.equal(lines.filter((l) => l.startsWith('vt ')).length, 8);
  assert.equal(lines.filter((l) => l.startsWith('f ')).length, 12);
  assert.match(obj, /^vt 0\.75 0\.75$/m);
  assert.match(obj, /^f 1\/1 2\/2 4\/4$/m);
  const plain = glbToObj(boxGlb({ uv: false })).toString();
  assert.match(plain, /^f 1 2 4$/m);
});

test('exportModel: GLB passa direto e formato desconhecido avisa', () => {
  const glb = boxGlb();
  assert.equal(exportModel(glb, 'glb'), glb);
  assert.throws(() => exportModel(glb, 'fbx'), /formato desconhecido/);
  assert.throws(() => parseGlb(Buffer.from('not a glb at all')), /não é um arquivo GLB/);
});
