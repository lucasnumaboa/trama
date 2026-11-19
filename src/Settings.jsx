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

/** Endereço do MCP e como ligar o Trama num agente de fora (Claude Code, Codex, Cursor). */
function McpSettings({ setMessage }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    api.mcpInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  const copy = (text) => navigator.clipboard.writeText(text).then(() => setMessage('Copiado.')).catch(() => setMessage(text));
  if (!info) return null;
  const rows = [
    ['Claude Code (terminal)', info.claudeCode],
    ['Codex (~/.codex/config.toml)', info.codex],
    ['Cursor, Claude Desktop e outros (JSON)', info.json],
  ];
  return (
    <section>
      <h3>MCP: usar o Trama de outro agente</h3>
      <p className="hint">
        Um agente de fora (Claude Code, Codex, Cursor…) pode usar o Trama como estúdio: criar projetos, gerar imagens, música, vídeo, voz e
        modelos 3D, e copiar os arquivos para o que ele estiver construindo. Tudo aparece aqui no canvas, com uma mensagem "Via MCP" no chat.
        O Trama precisa estar aberto.
      </p>
      <label className="field">
        <span>Endereço</span>
        <div className="row">
          <input readOnly value={info.url} onFocus={(e) => e.target.select()} />
          <button onClick={() => copy(info.url)}>Copiar</button>
        </div>
      </label>
      {rows.map(([label, value]) => (
        <label className="field" key={label}>
          <span>{label}</span>
          <div className="mcp-snippet">
            <pre>{value}</pre>
            <button onClick={() => copy(value)}>Copiar</button>
          </div>
        </label>
      ))}
      <p className="hint">
        {info.tools.length} ferramentas. Se a porta {info.port} estiver ocupada quando o Trama abrir, ele usa a próxima livre e o endereço muda: confira aqui.
      </p>
    </section>
  );
}

const gb = (bytes) => {
  if (!bytes) return '0 GB';
  const v = bytes / 1e9;
  return `${v < 0.1 ? '<0,1' : v.toFixed(v >= 10 ? 0 : 1).replace('.', ',')} GB`;
};
const versionLess = (a, b) => {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};
const STEP_ICON = { done: '✓', error: '✕', warning: '!', running: '…' };

/**
 * Preparar ComfyUI: o que cada workflow do Trama precisa (workflow salvo, nós, pacotes
 * do Python, modelos), com tamanho, e o botão que instala o que falta.
 */
function ComfySetup({ setMessage, onChanged }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(() => new Set());
  const [updateBase, setUpdateBase] = useState(true);
  const [job, setJob] = useState(null);

  async function check() {
    setLoading(true);
    setError('');
    try {
      const s = await api.setupStatus();
      setStatus(s);
      onChanged?.();
      setChosen((prev) => new Set([...prev].filter((n) => s.categories.some((c) => c.workflows.some((w) => w.name === n && !w.ready)))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    check();
    api.setupJob().then((r) => r.job && setJob(r.job)).catch(() => {});
  }, []);
  // Acompanha a instalação; quando termina, confere de novo.
  useEffect(() => {
    if (job?.state !== 'running') return undefined;
    const t = setInterval(async () => {
      const r = await api.setupJob().catch(() => null);
      if (!r?.job) return;
      setJob(r.job);
      if (r.job.state !== 'running') check();
    }, 1000);
    return () => clearInterval(t);
  }, [job?.state, job?.id]);

  const all = status?.categories?.flatMap((c) => c.workflows) || [];
  const missing = all.filter((w) => !w.ready);
  const selectedModels = [...new Set(all.filter((w) => chosen.has(w.name)).flatMap((w) => w.missingModels))];
  const selectedBytes = selectedModels.reduce((s, id) => s + (status?.models?.[id]?.size || 0), 0);
  const free = status?.comfy?.freeBytes ?? null;
  const tooBig = free !== null && selectedBytes + 2e9 > free;
  const base = status?.base;
  const baseOutdated = base && (base.tramaNode === 'outdated' || base.different?.length > 0);
  const running = job?.state === 'running';
  const canInstall = !running && (chosen.size > 0 || (baseOutdated && updateBase)) && !tooBig;

  const toggle = (name) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  async function install() {
    try {
      const r = await api.setupInstall({ workflows: [...chosen], updateBase: Boolean(baseOutdated && updateBase) });
      setJob(r.job);
      setMessage('Instalando… pode fechar as Configurações: a instalação continua.');
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function cancel() {
    const r = await api.setupCancel().catch(() => null);
    if (r?.job) setJob(r.job);
  }

  const c = status?.comfy;
  const progress = job?.current?.total ? Math.min(100, Math.round((job.current.bytes / job.current.total) * 100)) : null;
  return (
    <section id="settings-setup">
      <h3>Preparar ComfyUI</h3>
      <p className="hint">
        Confere se o seu ComfyUI tem o que cada workflow do Trama precisa (o workflow salvo, os nós, os pacotes do Python e os modelos) e
        instala o que faltar. Marque só o que vai usar: os modelos de vídeo têm dezenas de GB. Só mexe em workflows que começam com
        "trama_"; nunca fecha nem reinicia o ComfyUI.
      </p>
      {loading && !status && <p className="muted small">Conferindo o ComfyUI…</p>}
      {error && <p className="setup-warn">{error}</p>}
      {c && !c.online && <p className="setup-warn">{c.error}</p>}
      {c?.online && (
        <>
          <p className="muted small">
            ComfyUI {c.version}
            {c.gpu?.length ? ` · ${c.gpu.join(', ')}` : ''}
            {c.cuda ? ` · torch CUDA ${c.cuda}` : ''}
            {free !== null ? ` · disco ${c.drive} com ${gb(free)} livres` : ''}
          </p>
          {versionLess(c.version, c.tested) && (
            <p className="setup-warn">Os workflows do Trama foram testados no ComfyUI {c.tested}. Se algum aparecer como "ComfyUI antigo", atualize o ComfyUI.</p>
          )}
          {!c.local && <p className="setup-warn">O ComfyUI roda em outra máquina: aqui dá para ver o que falta e copiar os workflows; nós e modelos são instalados na máquina dele.</p>}
          {c.local && !c.python && <p className="setup-warn">Não achei o Python do ComfyUI (python_embeded ou venv): os pacotes do Python não serão conferidos nem instalados.</p>}
          {c.local && !c.git && <p className="muted small">Sem git neste computador: os nós são baixados como zip do GitHub.</p>}

          {baseOutdated && (
            <label className="check">
              <input type="checkbox" checked={updateBase} onChange={(e) => setUpdateBase(e.target.checked)} disabled={running} />
              <span>
                Atualizar a base do Trama
                <small>
                  {[
                    base.tramaNode === 'outdated' ? 'o nó ComfyUI-Trama está numa versão antiga' : null,
                    base.different?.length ? `${base.different.length} workflow(s) trama_ diferentes da versão do Trama (a versão atual fica em workflows/.trama-backup)` : null,
                  ].filter(Boolean).join('; ')}
                  .
                </small>
              </span>
            </label>
          )}

          {status.categories.map((cat) => (
            <div className="setup-cat" key={cat.id}>
              <div className="setup-cat-title">{cat.label}</div>
              {cat.workflows.map((w) => (
                <label className={`setup-row ${w.ready ? 'ready' : ''}`} key={w.name} title={w.name}>
                  <input type="checkbox" disabled={w.ready || running} checked={!w.ready && chosen.has(w.name)} onChange={() => toggle(w.name)} />
                  <span className="setup-name">
                    {w.label}
                    <small>{w.ready ? 'Pronto' : w.summary}</small>
                  </span>
                  {!w.ready && w.missingBytes > 0 && <span className="setup-size">{gb(w.missingBytes)}</span>}
                  {w.ready && <span className="setup-ok">✓</span>}
                </label>
              ))}
            </div>
          ))}

          <div className="row setup-actions">
            <span className="muted small">
              {missing.length ? `${missing.length} workflow(s) com algo faltando.` : 'Tudo pronto.'}
              {chosen.size > 0 && ` Marcados: ${chosen.size}, ${gb(selectedBytes)} de modelos.`}
            </span>
            {missing.length > 0 && (
              <button disabled={running} onClick={() => setChosen(new Set(chosen.size ? [] : missing.map((w) => w.name)))}>
                {chosen.size ? 'Desmarcar' : 'Marcar todos'}
              </button>
            )}
            <button onClick={check} disabled={loading || running}>
              {loading ? 'Conferindo…' : 'Conferir de novo'}
            </button>
            <button className="primary" disabled={!canInstall} onClick={install}>
              Instalar o que falta
            </button>
          </div>
          {tooBig && <p className="setup-warn">Os modelos marcados ({gb(selectedBytes)}) não cabem no disco {c.drive} ({gb(free)} livres, o Trama deixa 2 GB de folga). Desmarque alguns.</p>}
          {selectedModels.some((id) => status.models[id]?.manual) && <p className="muted small">Algum modelo marcado não tem link público: ele é listado no fim para você copiar à mão.</p>}
        </>
      )}

      {job && (
        <div className="setup-job">
          <div className="setup-cat-title">
            {running ? 'Instalando' : job.state === 'done' ? 'Instalação concluída' : job.state === 'cancelled' ? 'Instalação cancelada' : 'A instalação parou'}
          </div>
          {job.steps.map((s, i) => (
            <div className={`setup-step ${s.status}`} key={i}>
              <span className="setup-step-icon">{STEP_ICON[s.status] || '•'}</span>
              <span>
                {s.label}
                {s.detail && <small>{s.detail}</small>}
              </span>
            </div>
          ))}
          {running && job.current?.file && (
            <div className="setup-progress">
              <div className="setup-bar">
                <div style={{ width: `${progress || 0}%` }} />
              </div>
              <small>
                {job.current.file}: {gb(job.current.bytes)} de {gb(job.current.total)}
              </small>
            </div>
          )}
          {job.error && <p className="setup-warn">{job.error}</p>}
          {!running && job.restartNeeded && (
            <p className="setup-restart">Reinicie o ComfyUI (feche e abra pelo atalho) para ele carregar os nós e pacotes novos. Depois clique em Conferir de novo.</p>
          )}
          {job.log?.length > 0 && (
            <details>
              <summary className="muted small">Detalhes</summary>
              <pre className="setup-log">{job.log.slice(-60).join('\n')}</pre>
            </details>
          )}
          {running && (
            <div className="row">
              <button className="danger" onClick={cancel}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

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

        <ComfySetup setMessage={setMessage} onChanged={loadCaps} />

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
                    {m.available === false ? ` (não roda no ComfyUI: ${m.missing || 'workflow não encontrado'})` : ''}
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

        <McpSettings setMessage={setMessage} />

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
