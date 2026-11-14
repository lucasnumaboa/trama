// Modelos 3D (GLB) gerados no ComfyUI: medidas e exportação para STL e OBJ sem
// dependências. Lê o GLB (glTF binário), junta as malhas em coordenadas do mundo
// (aplicando as transformações dos nós) e escreve o formato pedido.
//
// O glTF usa Y para cima e não tem unidade fixa; os modelos do Trellis/Pixal3D saem
// num cubo de ~1. Impressão 3D usa Z para cima e milímetros, então o STL gira o
// modelo, assenta no chão (Z = 0), centraliza e escala para a altura pedida em mm.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Separa o JSON e o bloco binário de um arquivo GLB. */
export function parseGlb(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('não é um arquivo GLB');
  let offset = 12;
  let json;
  let bin;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error('GLB sem bloco JSON');
  return { json, bin: bin || Buffer.alloc(0) };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READERS = {
  5120: [1, (b, o) => b.readInt8(o)],
  5121: [1, (b, o) => b.readUInt8(o)],
  5122: [2, (b, o) => b.readInt16LE(o)],
  5123: [2, (b, o) => b.readUInt16LE(o)],
  5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};

/** Lê um accessor como lista plana de números. */
function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index];
  const n = COMPONENTS[acc.type];
  const [size, read] = READERS[acc.componentType] || [];
  if (!n || !read) throw new Error(`accessor ${index} com tipo não suportado`);
  const out = new Float64Array(acc.count * n);
  if (acc.bufferView === undefined) return out; // accessor vazio (zeros)
  const view = json.bufferViews[acc.bufferView];
  const stride = view.byteStride || size * n;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) out[i * n + c] = read(bin, base + i * stride + c * size);
  }
  return out;
}

// Matriz 4x4 em ordem de coluna (como o glTF).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

/**
 * Junta todas as malhas de triângulos da cena em coordenadas do mundo.
 * @returns {{ positions: number[][], uvs: (number[]|null)[], triangles: number[][] }}
 *   vértices (com UV, se houver) e triângulos como índices nessa lista.
 */
export function collectMesh(glb) {
  const { json } = glb;
  const positions = [];
  const uvs = [];
  const triangles = [];
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const m = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
        const pos = readAccessor(glb, prim.attributes.POSITION);
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(glb, prim.attributes.TEXCOORD_0) : null;
        const base = positions.length;
        for (let i = 0; i < pos.length / 3; i++) {
          positions.push(apply(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
          uvs.push(uv ? [uv[i * 2], uv[i * 2 + 1]] : null);
        }
        const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices) : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
        // Matriz espelhada (determinante negativo) inverte a ordem dos vértices.
        const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
        for (let i = 0; i + 2 < idx.length; i += 3) {
          triangles.push(det < 0 ? [base + idx[i], base + idx[i + 2], base + idx[i + 1]] : [base + idx[i], base + idx[i + 1], base + idx[i + 2]]);
        }
      }
    }
    for (const child of node.children || []) visit(child, m);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes || (json.nodes || []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY);
  if (!triangles.length) throw new Error('o modelo não tem malha de triângulos');
  return { positions, uvs, triangles };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  return { min, max, size: max.map((v, i) => v - min[i]) };
}

/** Medidas do modelo: triângulos, vértices, tamanho (eixos do glTF, Y para cima) e textura. */
export function meshStats(buffer) {
  const glb = parseGlb(buffer);
  const { positions, triangles } = collectMesh(glb);
  const { size } = bounds(positions);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    triangles: triangles.length,
    vertices: positions.length,
    size: size.map(round),
    textured: Boolean(glb.json.images?.length),
  };
}

/**
 * Pronto para impressão: Z para cima, no chão, centralizado, altura em mm.
 * @returns {number[][]} vértices transformados
 */
function forPrinting(positions, heightMm) {
  const { min, max, size } = bounds(positions);
  const scale = heightMm > 0 && size[1] > 0 ? heightMm / size[1] : 1;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  // glTF (x, y-cima, z-frente) → impressão (x, y = -z, z-cima)
  return positions.map(([x, y, z]) => [(x - cx) * scale, -(z - cz) * scale, (y - min[1]) * scale]);
}

/** STL binário. heightMm: altura final em milímetros (padrão 100). */
export function glbToStl(buffer, { heightMm = 100 } = {}) {
  const { positions, triangles } = collectMesh(parseGlb(buffer));
  const v = forPrinting(positions, heightMm);
  const out = Buffer.alloc(84 + triangles.length * 50);
  out.write('Trama STL', 0, 'ascii');
  out.writeUInt32LE(triangles.length, 80);
  let o = 84;
  for (const [a, b, c] of triangles) {
    const [p, q, r] = [v[a], v[b], v[c]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const x of [...n.map((k) => k / len), ...p, ...q, ...r]) {
      out.writeFloatLE(x, o);
      o += 4;
    }
    out.writeUInt16LE(0, o);
    o += 2;
  }
  return out;
}

/** OBJ (malha e UVs, sem material). Com heightMm, usa a mesma orientação e escala do STL. */
export function glbToObj(buffer, { heightMm } = {}) {
  const { positions, uvs, triangles } = collectMesh(parseGlb(buffer));
  const v = heightMm ? forPrinting(positions, heightMm) : positions;
  const hasUv = uvs.every(Boolean);
  const f = (x) => (Math.round(x * 1e6) / 1e6).toString();
  const lines = ['# Trama'];
  for (const p of v) lines.push(`v ${f(p[0])} ${f(p[1])} ${f(p[2])}`);
  // glTF conta o V de cima para baixo; OBJ, de baixo para cima.
  if (hasUv) for (const t of uvs) lines.push(`vt ${f(t[0])} ${f(1 - t[1])}`);
  for (const t of triangles) {
    const [a, b, c] = t.map((i) => i + 1);
    lines.push(hasUv ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

export const EXPORT_FORMATS = {
  glb: { ext: 'glb', type: 'model/gltf-binary', label: 'GLB (com textura)' },
  stl: { ext: 'stl', type: 'model/stl', label: 'STL (impressão 3D)' },
  obj: { ext: 'obj', type: 'model/obj', label: 'OBJ (só a malha)' },
};

/** Converte um GLB para o formato pedido. */
export function exportModel(buffer, format, { heightMm } = {}) {
  if (format === 'glb') return buffer;
  if (format === 'stl') return glbToStl(buffer, { heightMm: heightMm || 100 });
  if (format === 'obj') return glbToObj(buffer, { heightMm });
  throw new Error(`formato desconhecido: ${format}. Use glb, stl ou obj.`);
}
