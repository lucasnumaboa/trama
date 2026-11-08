// Converte um workflow salvo pela interface do ComfyUI (nodes/links/subgrafos)
// para o formato de API aceito por POST /prompt.
//
// Regras seguidas (as mesmas do frontend do ComfyUI):
// - nós "mudos" (mode 2) e notas não entram no prompt;
// - nós em bypass (mode 4) somem e cada saída é ligada à entrada do mesmo tipo;
// - Reroute é atravessado; PrimitiveNode vira valor;
// - subgrafos são achatados com ids "pai:filho";
// - widgets_values seguem a ordem das entradas de widget em /object_info,
//   com valores extras para "control_after_generate" e botões de upload.

const SKIP_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const UPLOAD_FLAGS = ['image_upload', 'video_upload', 'audio_upload', 'animated_image_upload'];
const SUBGRAPH_INPUT = -10;
const SUBGRAPH_OUTPUT = -20;

export class ConvertError extends Error {}

function normLink(l) {
  if (Array.isArray(l)) {
    const [id, origin_id, origin_slot, target_id, target_slot, type] = l;
    return { id, origin_id, origin_slot, target_id, target_slot, type };
  }
  return l;
}

const DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3';
const UPLOAD_PLACEHOLDERS = new Set(['image', 'video', 'audio', 'upload']);

/** Entradas de um bloco {required, optional} na ordem declarada. */
function orderedSpecs(inputs, order) {
  const list = [];
  for (const section of ['required', 'optional']) {
    const names = order?.[section] || Object.keys(inputs?.[section] || {});
    for (const name of names) {
      const spec = inputs?.[section]?.[name];
      if (spec) list.push([name, spec]);
    }
  }
  return list;
}

export function isWidgetSpec(spec) {
  const [type, opts = {}] = spec;
  if (opts.forceInput) return false;
  if (Array.isArray(type) || WIDGET_TYPES.has(type) || type === DYNAMIC_COMBO || opts.widgetType) return true;
  // Tipos múltiplos como "FLOAT,INT" também são campos.
  return typeof type === 'string' && type.includes(',') && type.split(',').every((t) => WIDGET_TYPES.has(t.trim()));
}

/** Opções de um combo, venham no formato antigo ([lista, opts]) ou novo ({options}). */
export function comboOptions(spec) {
  const [type, opts = {}] = spec;
  if (Array.isArray(type)) return type;
  if (type === DYNAMIC_COMBO) return (opts.options || []).map((o) => o.key);
  if (type === 'COMBO') return opts.options || [];
  return null;
}

/** Acha a especificação de uma entrada, inclusive subcampos "pai.filho" de dynamic combos. */
export function findInputSpec(def, name) {
  const top = orderedSpecs(def.input, def.input_order);
  const [head, ...rest] = name.split('.');
  let spec = top.find(([n]) => n === head)?.[1];
  for (const part of rest) {
    if (!spec || spec[0] !== DYNAMIC_COMBO) return null;
    const merged = {};
    for (const option of spec[1].options || []) {
      Object.assign(merged, option.inputs?.required, option.inputs?.optional);
    }
    spec = merged[part];
  }
  return spec || null;
}

/** Associa widgets_values (lista ou objeto) aos nomes das entradas do prompt de API. */
export function mapWidgetValues(def, widgetsValues, nodeType) {
  const values = {};
  if (!widgetsValues) return values;
  if (!Array.isArray(widgetsValues)) {
    for (const [name, spec] of orderedSpecs(def.input, def.input_order)) {
      if (isWidgetSpec(spec) && name in widgetsValues) values[name] = widgetsValues[name];
    }
    return values;
  }
  // CustomCombo: o frontend acrescenta "index" e "option1..N" depois da escolha.
  if (nodeType === 'CustomCombo') {
    values.choice = widgetsValues[0];
    if (widgetsValues.length > 1) values.index = widgetsValues[1];
    widgetsValues.slice(2).forEach((v, k) => (values[`option${k + 1}`] = v));
    return values;
  }
  let i = 0;
  const consume = (specs, prefix) => {
    for (const [name, spec] of specs) {
      if (i >= widgetsValues.length) return;
      if (!isWidgetSpec(spec)) continue;
      const [type, opts = {}] = spec;
      const key = prefix + name;
      values[key] = widgetsValues[i++];
      if (type === DYNAMIC_COMBO) {
        const option = (opts.options || []).find((o) => o.key === values[key]);
        if (option) consume(orderedSpecs(option.inputs), `${key}.`);
        continue;
      }
      if (opts.control_after_generate) i += 1;
      // O botão de upload às vezes é salvo como um valor extra ("image").
      if (UPLOAD_FLAGS.some((f) => opts[f]) && UPLOAD_PLACEHOLDERS.has(widgetsValues[i])) i += 1;
    }
  };
  consume(orderedSpecs(def.input, def.input_order), '');
  // Workflows salvos antes de um campo existir (ou sem os campos "avançados")
  // não guardam o valor dele: o frontend usa o padrão do nó. Fazemos o mesmo.
  if (i >= widgetsValues.length) {
    for (const [name, spec] of orderedSpecs(def.input, def.input_order)) {
      if (name in values || !isWidgetSpec(spec)) continue;
      const [type, opts = {}] = spec;
      if (type === DYNAMIC_COMBO) continue;
      if (opts.default !== undefined) values[name] = opts.default;
      else if (comboOptions(spec)?.length) values[name] = comboOptions(spec)[0];
    }
  }
  return values;
}

// Tipos de entrada de subgrafo que são campos (têm valor) e não dados ligados.
const isWidgetType = (type) => WIDGET_TYPES.has(type) || Array.isArray(type) || type === DYNAMIC_COMBO;

/**
 * @param {object} workflow  JSON salvo pela interface do ComfyUI
 * @param {object} objectInfo resposta de GET /object_info
 * @returns {{prompt: object, nodes: object, primitives: object}} prompt de API, metadados por id
 *   e valores de PrimitiveNode compartilhados ({ id: {title, value, targets: [[nó, entrada]]} })
 */
export function convertWorkflow(workflow, objectInfo) {
  if (!workflow || !Array.isArray(workflow.nodes)) throw new ConvertError('Workflow sem lista de nós');
  if (!Array.isArray(workflow.links) && workflow.nodes.length) {
    // Já está no formato de API? (objeto { id: {class_type, inputs} })
    throw new ConvertError('Workflow sem links: formato desconhecido');
  }
  const subgraphs = new Map((workflow.definitions?.subgraphs || []).map((s) => [s.id, s]));

  const makeScope = (nodes, links, prefix, parent, instance, def) => ({
    nodes: new Map(nodes.map((n) => [n.id, n])),
    links: new Map(links.map(normLink).map((l) => [l.id, l])),
    prefix,
    parent,
    instance,
    def,
  });
  const keyOf = (scope, id) => `${scope.prefix}${id}`;
  const childScopes = new Map(); // chave do nó-instância -> escopo do subgrafo

  function childScope(scope, node) {
    const key = keyOf(scope, node.id);
    if (!childScopes.has(key)) {
      const def = subgraphs.get(node.type);
      childScopes.set(key, makeScope(def.nodes || [], def.links || [], `${key}:`, scope, node, def));
    }
    return childScopes.get(key);
  }

  // Resolve a origem final de um link: {source:[id, slot]} | {value} | {inherit} | null
  function resolveOrigin(scope, originId, originSlot, seen = new Set()) {
    const mark = `${scope.prefix}|${originId}|${originSlot}`;
    if (seen.has(mark)) throw new ConvertError('Ciclo ao resolver links do workflow');
    seen.add(mark);

    if (originId === SUBGRAPH_INPUT) {
      const sgInput = scope.def.inputs?.[originSlot];
      const inst = scope.instance;
      // Entrada do subgrafo que alimenta vários nós internos: todos recebem o mesmo valor.
      const group = sgInput ? `${keyOf(scope.parent, inst.id)}>${sgInput.name}` : undefined;
      // Casa a entrada pelo nome (nunca pela posição: o nó mostra só parte delas).
      const instInput = sgInput ? inst.inputs?.find((i) => i.name === sgInput.name) : undefined;
      if (instInput?.link != null) {
        const link = scope.parent.links.get(instInput.link);
        if (link) return resolveOrigin(scope.parent, link.origin_id, link.origin_slot, seen);
      }
      // Campo "promovido" guardado no próprio nó de subgrafo: widgets_values segue a
      // ordem das entradas do subgrafo que são campos (quando não há proxyWidgets).
      const wv = inst.widgets_values;
      if (sgInput && !inst.properties?.proxyWidgets && Array.isArray(wv) && wv.length) {
        const fields = (scope.def.inputs || []).filter((i) => isWidgetType(i.type));
        const idx = fields.indexOf(sgInput);
        if (idx >= 0 && idx < wv.length) return { value: wv[idx], group };
      }
      // Senão vale o campo do próprio nó interno (ou de um irmão que recebe a mesma entrada).
      return { inherit: true, scope, sgInput, group };
    }

    const node = scope.nodes.get(originId);
    if (!node) return null;
    if (subgraphs.has(node.type)) {
      const child = childScope(scope, node);
      const out = child.def.outputs?.[originSlot];
      // A ligação que chega de fato ao nó de saída; linkIds pode ter ids antigos.
      const link =
        [...child.links.values()].find((l) => l.target_id === SUBGRAPH_OUTPUT && l.target_slot === originSlot) ||
        (out?.linkIds || []).map((id) => child.links.get(id)).find(Boolean) ||
        null;
      if (!link) return null;
      return resolveOrigin(child, link.origin_id, link.origin_slot, seen);
    }
    if (node.mode === 2) return null;
    if (node.type === 'Reroute' || node.mode === 4) {
      const outType = node.outputs?.[originSlot]?.type;
      const inputs = node.inputs || [];
      const candidate =
        node.type === 'Reroute'
          ? inputs[0]
          : (inputs[originSlot]?.type === outType && inputs[originSlot]?.link != null ? inputs[originSlot] : null) ||
            inputs.find((i) => i.link != null && i.type === outType);
      if (!candidate || candidate.link == null) return null;
      const link = scope.links.get(candidate.link);
      return link ? resolveOrigin(scope, link.origin_id, link.origin_slot, seen) : null;
    }
    if (node.type === 'PrimitiveNode') {
      return { value: node.widgets_values?.[0], primitive: keyOf(scope, node.id), title: node.title || node.outputs?.[0]?.widget?.name };
    }
    return { source: [keyOf(scope, node.id), originSlot] };
  }

  const prompt = {};
  const meta = {};
  const primitives = {};
  const groups = {}; // entrada de subgrafo -> [[nó, entrada], ...]

  // Valor de campo de outro nó interno ligado à mesma entrada do subgrafo.
  function siblingValue(scope, sgInput, exceptNodeId) {
    for (const linkId of sgInput?.linkIds || []) {
      const l = scope.links.get(linkId);
      if (!l || l.target_id === exceptNodeId) continue;
      const target = scope.nodes.get(l.target_id);
      const def = target && objectInfo[target.type];
      if (!def) continue;
      const name = target.inputs?.[l.target_slot]?.name;
      const v = name ? mapWidgetValues(def, target.widgets_values, target.type)[name] : undefined;
      if (v !== undefined) return v;
    }
    return undefined;
  }

  function emitScope(scope) {
    for (const node of scope.nodes.values()) {
      if (subgraphs.has(node.type)) {
        if (node.mode === 2 || node.mode === 4) continue;
        emitScope(childScope(scope, node));
        continue;
      }
      if (SKIP_TYPES.has(node.type) || node.mode === 2 || node.mode === 4) continue;
      const def = objectInfo[node.type];
      if (!def) throw new ConvertError(`Nó "${node.type}" não existe neste ComfyUI (falta instalar um custom node?)`);

      const inputs = mapWidgetValues(def, node.widgets_values, node.type);
      for (const input of node.inputs || []) {
        if (input.link == null) continue;
        const link = scope.links.get(input.link);
        if (!link) continue;
        const origin = resolveOrigin(scope, link.origin_id, link.origin_slot);
        if (origin?.group) (groups[origin.group] ||= []).push([keyOf(scope, node.id), input.name]);
        if (origin?.inherit) {
          if (inputs[input.name] === undefined) {
            const v = siblingValue(origin.scope, origin.sgInput, node.id);
            if (v !== undefined) inputs[input.name] = v;
          }
          continue;
        }
        if (!origin) continue;
        inputs[input.name] = origin.source ?? origin.value;
        if (origin.primitive) {
          // Um mesmo PrimitiveNode pode alimentar vários nós: guarda todos os destinos.
          const prim = (primitives[origin.primitive] ||= { title: origin.title, value: origin.value, targets: [] });
          prim.targets.push([keyOf(scope, node.id), input.name]);
        }
      }
      const key = keyOf(scope, node.id);
      prompt[key] = {
        class_type: node.type,
        inputs,
        _meta: { title: node.title || def.display_name || node.type },
      };
      meta[key] = { title: node.title || def.display_name || node.type, type: node.type };
    }
  }

  emitScope(makeScope(workflow.nodes, workflow.links || [], '', null, null, null));
  if (!Object.keys(prompt).length) throw new ConvertError('O workflow não tem nós executáveis');
  // Só vira grupo quando a mesma entrada chega a mais de um nó; mantém o id do campo.
  for (const [key, targets] of Object.entries(groups)) {
    if (targets.length > 1) primitives[key] = { targets, keepId: true };
  }
  return { prompt, nodes: meta, primitives };
}
