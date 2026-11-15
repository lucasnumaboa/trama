import { useEffect, useState } from 'react';
import { api } from './api.js';

const PROVIDER_ORDER = ['deepseek', 'openai', 'anthropic', 'openrouter', 'comfyui', 'custom'];
const PROVIDER_HELP = {
  deepseek: 'Chave em platform.deepseek.com. Modelos: deepseek-chat (rápido) e deepseek-reasoner.',
  openai: 'Chave em platform.openai.com. Use um modelo que chame ferramentas (ex.: gpt-4.1).',
  anthropic: 'Chave em console.anthropic.com. Padrão: claude-opus-5-5. Usa o SDK oficial da Anthropic; se o Claude recusar, a Anthropic tenta de novo num modelo de reserva.',
  openrouter: 'Chave em openrouter.ai: um só lugar para vários modelos (nome no formato empresa/modelo).',
  comfyui: 'Roda um modelo de texto do seu ComfyUI (workflow trama_texto_ia_local). Sem chave e sem internet; modelos locais pequenos erram mais nas ferramentas.',
  custom: 'Qualquer servidor compatível com a API da OpenAI: LM Studio (http://127.0.0.1:1234/v1), Ollama (http://127.0.0.1:11434/v1), vLLM, LocalAI… Chave só se o servidor pedir.',
};

/** Um bloco por provedor: chave, modelo e endereço salvos separadamente. */
function ProviderSettings({ settings, onSaved, initial, setMessage }) {
  const providers = settings?.providers || {};
  const [tab, setTab] = useState(initial && providers[initial] ? initial : settings?.llmProvider || 'deepseek');
  const cfg = providers[tab] || {};
  const [key, setKey] = useState('');
  const [model, setModel] = useState(cfg.model || '');
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl || '');
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKey('');
    setModel(providers[tab]?.model || '');
    setBaseUrl(providers[tab]?.baseUrl || '');
    setModels([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function save(extra = {}, test = false) {
    setBusy(true);
    try {
      const patch = { model, ...(cfg.kind !== 'comfyui' ? { baseUrl } : {}), ...(key.trim() ? { apiKey: key.trim() } : {}), ...extra };
      const next = await api.saveSettings({ providers: { [tab]: patch } });
      setKey('');
      onSaved(next);
      if (test) {
        setMessage(`Testando ${cfg.label}…`);
        const { models: list } = await api.llmModels(tab);
        setModels(list);
        setMessage(`${cfg.label} OK: ${list.length} modelos disponíveis.`);
      } else setMessage(`${cfg.label}: configuração salva.`);
    } catch (e) {
      setMessage(`${cfg.label}: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  async function useInChat() {
    try {
      onSaved(await api.saveSettings({ llmProvider: tab }));
      setMessage(`O agente do chat agora usa ${cfg.label}.`);
    } catch (e) {
      setMessage(e.message);
    }
  }

  const modelOptions = [...new Set([model, ...models].filter(Boolean))];
  return (
    <section>
      <h3>Agente do chat (provedor de IA)</h3>
      <div className="provider-tabs">
        {PROVIDER_ORDER.filter((id) => providers[id]).map((id) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <span className={`agent-dot ${providers[id].ready ? 'ok' : ''}`} />
            {providers[id].label.replace(/\s*\(.*\)$/, '')}
            {settings?.llmProvider === id && <small> · no chat</small>}
          </button>
        ))}
      </div>
      <p className="muted small">{PROVIDER_HELP[tab]}</p>
      {(cfg.needsKey || tab === 'custom') && (
        <label className="field">
          <span>
            Chave da API {cfg.keySet ? <small>atual: {cfg.keyMasked}</small> : <small>{cfg.needsKey ? 'nenhuma chave salva' : 'opcional'}</small>}
          </span>
          <input
            type="password"
            autoComplete="off"
            placeholder={cfg.keySet ? 'Deixe em branco para manter a atual' : 'cole a chave aqui'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>Modelo</span>
        <input list={`models-${tab}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="nome do modelo" />
        <datalist id={`models-${tab}`}>
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {cfg.kind !== 'comfyui' && (
        <label className="field">
          <span>Endereço da API {tab === 'anthropic' && <small>em branco = api.anthropic.com</small>}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button onClick={() => save({}, true)} disabled={busy}>
          Salvar e listar modelos
        </button>
        {settings?.llmProvider !== tab && (
          <button className="primary" onClick={useInChat} disabled={!cfg.ready || busy} title={cfg.ready ? '' : 'Salve a chave primeiro'}>
            Usar no chat
          </button>
        )}
        {cfg.keySet && (
          <button className="danger" onClick={() => save({ apiKey: '' })} disabled={busy}>
            Remover chave
          </button>
        )}
      </div>
    </section>
  );
}

export default function Settings({ settings, onClose, onSaved, initialProvider }) {
  const [comfyUrl, setComfyUrl] = useState(settings?.comfyUrl || '');
  const [review, setReview] = useState(settings?.reviewGenerations !== false);
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

  async function testComfy() {
    setMessage('Testando o ComfyUI…');
    const s = await api.comfyStatus().catch((e) => ({ ok: false, error: e.message }));
    setMessage(s.ok ? `ComfyUI ${s.version} OK (${(s.devices || []).join(', ')})` : `ComfyUI: ${s.error}`);
  }

  async function save(extra = {}) {
    setSaving(true);
    try {
      const next = await api.saveSettings({ comfyUrl, reviewGenerations: review, ...extra });
      onSaved(next);
      setMessage('Configurações salvas.');
    } catch (e) {
      setMessage(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Configurações</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <ProviderSettings settings={settings} onSaved={onSaved} initial={initialProvider} setMessage={setMessage} />

        <section>
          <h3>ComfyUI (imagem, vídeo e áudio)</h3>
          <label className="field">
            <span>Endereço do ComfyUI</span>
            <input value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
            <span>
              Conferir cada imagem e vídeo gerado
              <small>O modelo de visão descreve o resultado e a IA do agente compara com o pedido (pessoa duplicada ou faltando, formato errado). Leva 1 a 3 minutos a mais por geração.</small>
            </span>
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
