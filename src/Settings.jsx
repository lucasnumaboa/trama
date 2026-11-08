import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Settings({ settings, onClose, onSaved }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings?.deepseekModel || '');
  const [baseUrl, setBaseUrl] = useState(settings?.deepseekBaseUrl || '');
  const [comfyUrl, setComfyUrl] = useState(settings?.comfyUrl || '');
  const [models, setModels] = useState([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [caps, setCaps] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [newWorkflow, setNewWorkflow] = useState('');
  const [newLabel, setNewLabel] = useState('');

  async function loadCaps() {
    const r = await api.capabilities().catch(() => null);
    if (!r) return;
    setCaps(r.categories);
    setWorkflows(r.workflows);
    setNewCategory((c) => c || r.categories[0]?.id || '');
  }
  useEffect(() => {
    loadCaps().then(() => {
      // #modal=settings&section=models abre já na lista de modelos padrão.
      if (new URLSearchParams(window.location.hash.slice(1)).get('section') === 'models') {
        setTimeout(() => document.getElementById('settings-models')?.scrollIntoView(), 50);
      }
    });
  }, []);

  async function setDefault(category, id) {
    try {
      await api.setDefaultCapability(category, id);
      await loadCaps();
      setMessage('Modelo padrão atualizado.');
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function addCapModel() {
    try {
      await api.addCapabilityModel({ category: newCategory, workflow: newWorkflow, label: newLabel });
      setNewWorkflow('');
      setNewLabel('');
      await loadCaps();
      setMessage('Modelo adicionado.');
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function removeCapModel(id) {
    try {
      await api.removeCapabilityModel(id);
      await loadCaps();
      setMessage('Modelo removido.');
    } catch (e) {
      setMessage(e.message);
    }
  }
  const extras = caps.flatMap((c) => c.models.filter((m) => !m.builtin).map((m) => ({ ...m, categoryLabel: c.label })));
  const availableWorkflows = workflows.filter((w) => {
    const cat = caps.find((c) => c.id === newCategory);
    return !cat || !cat.models.some((m) => m.workflow === w);
  });

  async function testDeepseek() {
    setMessage('Testando o DeepSeek…');
    try {
      const { models: list } = await api.deepseekModels();
      setModels(list);
      setMessage(`DeepSeek OK: ${list.length} modelos disponíveis.`);
    } catch (e) {
      setMessage(`DeepSeek: ${e.message}`);
    }
  }
  async function testComfy() {
    setMessage('Testando o ComfyUI…');
    const s = await api.comfyStatus().catch((e) => ({ ok: false, error: e.message }));
    setMessage(s.ok ? `ComfyUI ${s.version} OK (${(s.devices || []).join(', ')})` : `ComfyUI: ${s.error}`);
  }

  useEffect(() => {
    if (settings?.deepseekKeySet) api.deepseekModels().then((r) => setModels(r.models)).catch(() => {});
  }, [settings?.deepseekKeySet]);

  async function save(extra = {}) {
    setSaving(true);
    try {
      const patch = { deepseekModel: model, deepseekBaseUrl: baseUrl, comfyUrl, ...extra };
      if (key.trim()) patch.deepseekApiKey = key.trim();
      const next = await api.saveSettings(patch);
      setKey('');
      onSaved(next);
      setMessage('Configurações salvas.');
    } catch (e) {
      setMessage(e.message);
    } finally {
      setSaving(false);
    }
  }

  const modelOptions = [...new Set([model, ...models].filter(Boolean))];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configurações</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <section>
          <h3>DeepSeek (o agente do chat)</h3>
          <label className="field">
            <span>
              Chave da API{' '}
              {settings?.deepseekKeySet ? <small>atual: {settings.deepseekKeyMasked}</small> : <small>nenhuma chave salva</small>}
            </span>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings?.deepseekKeySet ? 'Deixe em branco para manter a atual' : 'sk-...'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Modelo padrão</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Endereço da API</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <div className="row">
            <button onClick={testDeepseek}>Testar chave e listar modelos</button>
            {settings?.deepseekKeySet && (
              <button className="danger" onClick={() => save({ deepseekApiKey: '' })}>
                Remover chave
              </button>
            )}
          </div>
        </section>

        <section>
          <h3>ComfyUI (imagem, vídeo e áudio)</h3>
          <label className="field">
            <span>Endereço do ComfyUI</span>
            <input value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} />
          </label>
          <p className="hint">
            Os workflows, modelos e LoRAs são lidos direto do ComfyUI. O agente escolhe qual usar; se quiser outro modelo ou LoRA, peça no chat.
          </p>
          <div className="row">
            <button onClick={testComfy}>Testar conexão</button>
          </div>
        </section>

        <section id="settings-models">
          <h3>Modelos padrão</h3>
          <p className="hint">
            Escolha qual modelo o agente usa em cada tipo de criação. Ele usa outro da mesma lista quando o padrão não aceita as entradas do pedido
            (ex.: animar uma imagem) ou quando você pedir outro pelo nome.
          </p>
          {caps.map((c) => (
            <label className="field" key={c.id}>
              <span>
                {c.label} <small>{c.description}</small>
              </span>
              <select value={c.defaultId || ''} onChange={(e) => setDefault(c.id, e.target.value)}>
                {c.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.available === false ? ' (workflow não encontrado no ComfyUI)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ))}

          <h3>Adicionar modelo</h3>
          <p className="hint">Para um modelo novo: salve o workflow no ComfyUI (formato de tela) e escolha aqui a categoria e o arquivo.</p>
          <label className="field">
            <span>Categoria</span>
            <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
              {caps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Workflow salvo no ComfyUI</span>
            <select value={newWorkflow} onChange={(e) => setNewWorkflow(e.target.value)}>
              <option value="">Escolha um workflow…</option>
              {availableWorkflows.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Nome que aparece no Trama</span>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Ex.: Meu modelo de cartaz" />
          </label>
          <div className="row">
            <button disabled={!newWorkflow || !newLabel.trim()} onClick={addCapModel}>
              Adicionar modelo
            </button>
          </div>

          {extras.length > 0 && (
            <>
              <h3>Modelos que você adicionou</h3>
              {extras.map((m) => (
                <div className="row" key={m.id}>
                  <span>
                    {m.label} <small>({m.categoryLabel})</small>
                  </span>
                  <button className="danger" onClick={() => removeCapModel(m.id)}>
                    Remover
                  </button>
                </div>
              ))}
            </>
          )}
        </section>

        {message && <div className="message">{message}</div>}
        <div className="modal-footer">
          <button onClick={onClose}>Fechar</button>
          <button className="primary" disabled={saving} onClick={() => save()}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
