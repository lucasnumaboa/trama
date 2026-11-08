import { fileUrl } from './api.js';
import { Icon } from './ui.jsx';

export default function Sidebar({ projects, currentId, onSelect, onNew, onDelete, onWorkflows, onSettings, comfy, settings }) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <img src="/logo.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
        <span>Trama</span>
      </div>

      <button className="side-item primary-item" onClick={onNew}>
        <Icon name="plus" />
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
              {p.cover?.kind === 'image' ? <img src={fileUrl(p.cover.file)} alt="" /> : <Icon name={p.cover?.kind || 'chat'} size={13} />}
            </span>
            <span className="project-title">{p.title}</span>
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
          <span>DeepSeek {settings?.deepseekKeySet ? '' : '(sem chave)'}</span>
        </div>
        <button className="side-item" onClick={onSettings}>
          <Icon name="gear" />
          Configurações
        </button>
      </div>
    </nav>
  );
}
