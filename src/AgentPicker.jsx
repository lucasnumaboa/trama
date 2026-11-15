// Quem é o agente do chat: provedor (DeepSeek, OpenAI, Anthropic, OpenRouter,
// ComfyUI local, Personalizado) e o modelo dele. Cada provedor guarda a própria
// chave e modelo nas Configurações; trocar aqui não apaga a configuração dos outros.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

const ORDER = ['deepseek', 'openai', 'anthropic', 'openrouter', 'comfyui', 'custom'];

/** Nome curto do modelo (no ComfyUI o valor é "arquivo|tipo"). */
export function modelLabel(model) {
  const m = String(model || '').split('|')[0];
  return m.replace(/\.safetensors$/, '') || 'sem modelo';
}

/** Lista de provedores e, do ativo, os modelos para escolher. */
export function AgentMenu({ settings, onSaved, onOpenSettings }) {
  const active = settings?.llmProvider;
  const providers = settings?.providers || {};
  const [models, setModels] = useState(null);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setModels(null);
    setError('');
    if (!active || !providers[active]?.ready) return;
    let alive = true;
    api
      .llmModels(active)
      .then((r) => alive && setModels(r.models))
      .catch((e) => alive && (setModels([]), setError(e.message)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, providers[active]?.ready, providers[active]?.baseUrl]);

  async function save(patch, tag) {
    setBusy(tag);
    try {
      onSaved(await api.saveSettings(patch));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  const current = providers[active]?.model;
  const list = [...new Set([current, ...(models || [])].filter(Boolean))];
  return (
    <div className="agent-menu">
      <div className="mp-section">Provedor</div>
      {ORDER.filter((id) => providers[id]).map((id) => {
        const p = providers[id];
        return (
          <button
            key={id}
            className={`mp-item ${id === active ? 'selected' : ''}`}
            onClick={() => (p.ready ? save({ llmProvider: id }, id) : onOpenSettings?.(id))}
            title={p.ready ? '' : 'Configure a chave nas Configurações'}
          >
            <span className={`agent-dot ${p.ready ? 'ok' : ''}`} />
            <span className="mp-text">
              <span className="mp-name">{p.label}</span>
              <span className="mp-meta">{p.ready ? modelLabel(p.model) : 'sem chave · configurar'}</span>
            </span>
            {busy === id ? <span className="mini-spin" /> : id === active && <Icon name="check" size={15} className="mp-check" />}
          </button>
        );
      })}
      {active && providers[active]?.ready && (
        <>
          <div className="mp-section">Modelo do {providers[active].label}</div>
          {models === null && <div className="muted small pad">Carregando modelos…</div>}
          {error && <div className="msg-error small">{error}</div>}
          <div className="agent-models">
            {list.map((m) => (
              <button key={m} className={`mp-item ${m === current ? 'selected' : ''}`} onClick={() => save({ providers: { [active]: { model: m } } }, m)}>
                <span className="mp-text">
                  <span className="mp-name">{modelLabel(m)}</span>
                </span>
                {busy === m ? <span className="mini-spin" /> : m === current && <Icon name="check" size={15} className="mp-check" />}
              </button>
            ))}
          </div>
          <form
            className="agent-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) save({ providers: { [active]: { model: custom.trim() } } }, 'custom').then(() => setCustom(''));
            }}
          >
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Outro modelo (nome exato)" />
            <button type="submit" disabled={!custom.trim()}>
              Usar
            </button>
          </form>
        </>
      )}
      {onOpenSettings && (
        <button className="link-btn" onClick={() => onOpenSettings(active)}>
          <Icon name="gear" size={13} /> Chaves e endereços dos provedores
        </button>
      )}
    </div>
  );
}

/** Botão no topo do chat: mostra o agente atual e abre o menu. */
export default function AgentPicker({ settings, onSaved, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const p = settings?.providers?.[settings?.llmProvider];
  if (!p) return null;
  return (
    <div className="agent-picker" ref={box}>
      <button className={`agent-btn ${p.ready ? '' : 'warn'}`} onClick={() => setOpen((o) => !o)} title="Trocar a IA do agente">
        <span className={`agent-dot ${p.ready ? 'ok' : ''}`} />
        <span className="agent-name">{p.label.replace(/\s*\(.*\)$/, '')}</span>
        <span className="agent-model">{p.ready ? modelLabel(p.model) : 'sem chave'}</span>
        <Icon name="chevron" size={11} className="agent-chev" />
      </button>
      {open && (
        <div className="agent-pop">
          <AgentMenu
            settings={settings}
            onSaved={onSaved}
            onOpenSettings={(id) => {
              setOpen(false);
              onOpenSettings?.(id);
            }}
          />
        </div>
      )}
    </div>
  );
}
