import { fileUrl } from './api.js';
import { Icon } from './ui.jsx';

function ago(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!t) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

export default function Sidebar({ projects, currentId, onSelect, onNew, onDelete, onWorkflows, onSettings, comfy, settings }) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <img src="/logo.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
        <span>Trama</span>
      </div>

      <button className="new-project" onClick={onNew}>
        <Icon name="plus" size={15} />
        Novo projeto
      </button>
      <button className="side-item" onClick={onWorkflows}>
        <Icon name="flow" />
        Workflows do ComfyUI
      </button>

      <div className="side-section">Projetos</div>
      <div className="project-list">
        {projects.length === 0 && <div className="muted small pad">Nenhum projeto ainda</div>}
        {projects.map((p) => (
          <div key={p.id} className={`project-item ${p.id === currentId ? 'active' : ''}`} onClick={() => onSelect(p.id)} title={p.title}>
            <span className="project-thumb">
              {p.cover?.kind === 'image' ? <img src={fileUrl(p.cover.file)} alt="" /> : <Icon name={p.cover?.kind || 'chat'} size={14} />}
            </span>
            <span className="project-text">
              <span className="project-title">{p.title}</span>
              <span className="project-time">{ago(p.updatedAt)}</span>
            </span>
            <button
              className="project-del"
              title="Apagar projeto"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Apagar o projeto "${p.title}"? A conversa e o canvas somem. Os arquivos gerados continuam na pasta do ComfyUI.`)) onDelete(p.id);
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="side-footer">
        <div className="status-line">
          <span className={`dot ${comfy?.ok ? 'ok' : 'bad'}`} />
          <span title={comfy?.ok ? (comfy.devices || []).join(', ') : comfy?.error}>ComfyUI {comfy?.ok ? comfy.version : 'offline'}</span>
        </div>
        <div className="status-line">
          <span className={`dot ${settings?.deepseekKeySet ? 'ok' : 'bad'}`} />
          <span>DeepSeek {settings?.deepseekKeySet ? 'conectado' : '(sem chave)'}</span>
        </div>
        <button className="side-item" onClick={onSettings}>
          <Icon name="gear" />
          Configurações
        </button>
      </div>
    </nav>
  );
}
