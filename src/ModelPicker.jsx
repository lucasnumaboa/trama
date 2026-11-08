// Seletor de modelos do chat: agente (DeepSeek) e o modelo de cada capacidade,
// escolhido para este projeto (e, opcionalmente, como padrão geral).
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

const TABS = [
  { id: 'agent', label: 'Agente', icon: 'chat' },
  { id: 'image', label: 'Imagem', icon: 'image', categories: ['image_create', 'image_edit', 'image_upscale', 'image_background'] },
  { id: 'video', label: 'Vídeo', icon: 'video', categories: ['video_create', 'video_edit'] },
  { id: 'audio', label: 'Áudio', icon: 'audio', categories: ['music_create', 'voice_edit'] },
];
const ALSO_DEFAULT = 'trama:alsoDefault';

// "Z-Image Turbo (rápido, fotorrealista)" -> ["Z-Image Turbo", "rápido, fotorrealista"]
function splitLabel(label) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label);
  return m ? [m[1], m[2]] : [label, ''];
}

function Avatar({ name }) {
  const letters = name.replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  let hue = 0;
  for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="model-avatar" style={{ background: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 80% 78%)` }}>
      {letters || '?'}
    </span>
  );
}

export default function ModelPicker({ project, models, model, setModel, onClose }) {
  const box = useRef(null);
  const [tab, setTab] = useState('video');
  const [caps, setCaps] = useState([]);
  const [alsoDefault, setAlsoDefault] = useState(() => {
    try {
      return localStorage.getItem(ALSO_DEFAULT) !== '0';
    } catch {
      return true;
    }
  });
  const [busy, setBusy] = useState('');

  const load = () => api.capabilities(project.id).then((r) => setCaps(r.categories)).catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    const close = (e) => {
      if (box.current && !box.current.contains(e.target) && !e.target.closest('.picker-anchor')) onClose();
    };
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  async function choose(category, id) {
    setBusy(id);
    try {
      await api.setProjectModel(project.id, category, id);
      if (alsoDefault) await api.setDefaultCapability(category, id);
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  const count = (t) => (t.categories ? caps.filter((c) => t.categories.includes(c.id)).reduce((n, c) => n + c.models.length, 0) : models.length);
  const current = TABS.find((t) => t.id === tab);

  return (
    <div className="model-picker" ref={box}>
      <div className="mp-head">
        <span>Configuração de modelos</span>
        <span className="muted small">o agente usa o marcado de cada tipo</span>
      </div>
      <div className="mp-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id !== 'agent' && <span className="mp-count">{count(t)}</span>}
          </button>
        ))}
      </div>

      <div className="mp-list">
        {tab === 'agent' &&
          (models.length ? (
            <>
              <div className="mp-section">Modelo que conversa e orquestra</div>
              {models.map((m) => (
                <button key={m} className={`mp-item ${m === model ? 'selected' : ''}`} onClick={() => setModel(m)}>
                  <Avatar name={m} />
                  <span className="mp-text">
                    <span className="mp-name">{m}</span>
                    <span className="mp-meta">DeepSeek · chamada de ferramentas</span>
                  </span>
                  {m === model && <Icon name="check" size={15} className="mp-check" />}
                </button>
              ))}
            </>
          ) : (
            <div className="muted small pad">Configure a chave do DeepSeek nas Configurações.</div>
          ))}

        {current.categories &&
          caps
            .filter((c) => current.categories.includes(c.id))
            .map((c) => (
              <div key={c.id}>
                <div className="mp-section">
                  {c.label} <span className="muted">· {c.description}</span>
                </div>
                {c.models.map((m) => {
                  const [name, meta] = splitLabel(m.label);
                  const selected = m.id === c.defaultId;
                  return (
                    <button
                      key={m.id}
                      className={`mp-item ${selected ? 'selected' : ''} ${m.available === false ? 'missing' : ''}`}
                      onClick={() => !selected && choose(c.id, m.id)}
                      disabled={Boolean(busy) || m.available === false}
                      title={m.available === false ? `O workflow ${m.workflow} não está no ComfyUI` : m.workflow}
                    >
                      <Avatar name={name} />
                      <span className="mp-text">
                        <span className="mp-name">
                          {name}
                          {m.id === c.globalDefaultId && <span className="mp-badge">padrão</span>}
                          {!m.builtin && <span className="mp-badge alt">seu</span>}
                        </span>
                        <span className="mp-meta">{m.available === false ? 'workflow não encontrado no ComfyUI' : meta || m.workflow}</span>
                      </span>
                      {busy === m.id ? <span className="mini-spin" /> : selected && <Icon name="check" size={15} className="mp-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
      </div>

      {tab !== 'agent' && (
        <label className="mp-foot">
          <input
            type="checkbox"
            checked={alsoDefault}
            onChange={(e) => {
              setAlsoDefault(e.target.checked);
              try {
                localStorage.setItem(ALSO_DEFAULT, e.target.checked ? '1' : '0');
              } catch {
                /* sem armazenamento local */
              }
            }}
          />
          Também usar como padrão nos novos projetos
        </label>
      )}
    </div>
  );
}
