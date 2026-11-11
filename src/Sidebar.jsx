import { useEffect, useRef, useState } from 'react';
import { api, fileUrl } from './api.js';
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

// Pastas fechadas e "Arquivados" aberto: lembrado só neste computador.
const UI_KEY = 'trama.sidebar';
function loadUi() {
  try {
    return { closed: [], archived: false, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') };
  } catch {
    return { closed: [], archived: false };
  }
}

/** Campo de texto no lugar do nome: Enter salva, Esc cancela, sair do campo salva. */
function NameInput({ value, placeholder, onDone }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current.value.trim();
    onDone(save && v ? v : null);
  };
  return (
    <input
      ref={ref}
      className="name-input"
      defaultValue={value}
      placeholder={placeholder}
      maxLength={80}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

export default function Sidebar({ projects, folders = [], currentId, onSelect, onNew, onDelete, onChanged, onError, onWorkflows, onSettings, comfy, settings }) {
  const [menu, setMenu] = useState(null); // { x, y, project } | { x, y, folder }
  const [editing, setEditing] = useState(null); // { kind: 'project' | 'folder' | 'newFolder', id, moveId }
  const [ui, setUi] = useState(loadUi);
  const [dropOn, setDropOn] = useState(null);

  const saveUi = (next) => {
    setUi(next);
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(next));
    } catch {
      /* sem storage */
    }
  };
  const toggleFolder = (id) => saveUi({ ...ui, closed: ui.closed.includes(id) ? ui.closed.filter((x) => x !== id) : [...ui.closed, id] });

  // Fecha o menu ao clicar fora, rolar ou apertar Esc.
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && e.target.closest?.('.side-menu')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const act = async (fn) => {
    setMenu(null);
    try {
      await fn();
    } catch (err) {
      onError?.(err.message);
    }
    onChanged?.();
  };

  const openMenu = (e, target) => {
    e.preventDefault();
    e.stopPropagation();
    // Mantém o menu dentro da janela.
    const x = Math.min(e.clientX, window.innerWidth - 250);
    const y = Math.min(e.clientY, window.innerHeight - 330);
    setMenu({ x, y, ...target });
  };

  const finishEdit = (value) => {
    const ed = editing;
    setEditing(null);
    if (!value || !ed) return;
    if (ed.kind === 'project') act(() => api.renameProject(ed.id, value));
    if (ed.kind === 'folder') act(() => api.renameFolder(ed.id, value));
    if (ed.kind === 'newFolder')
      act(async () => {
        const f = await api.createFolder(value);
        if (ed.moveId) await api.moveProject(ed.moveId, f.id);
      });
  };

  const live = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const known = new Set(folders.map((f) => f.id));
  const loose = live.filter((p) => !p.folder || !known.has(p.folder));

  const row = (p) => (
    <div
      key={p.id}
      className={`project-item ${p.id === currentId ? 'active' : ''} ${menu?.project?.id === p.id ? 'menu-open' : ''}`}
      onClick={() => onSelect(p.id)}
      onContextMenu={(e) => openMenu(e, { project: p })}
      title={p.title}
      draggable={!p.archived && editing?.id !== p.id}
      onDragStart={(e) => {
        e.dataTransfer.setData('trama/project', p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span className="project-thumb">
        {p.cover?.kind === 'image' ? <img src={fileUrl(p.cover.file)} alt="" /> : <Icon name={p.cover?.kind || 'chat'} size={14} />}
      </span>
      <span className="project-text">
        {editing?.kind === 'project' && editing.id === p.id ? (
          <NameInput value={p.title} onDone={finishEdit} />
        ) : (
          <span className="project-title">{p.title}</span>
        )}
        <span className="project-time">{ago(p.updatedAt)}</span>
      </span>
      <button className="project-del" title="Mais opções" onClick={(e) => openMenu(e, { project: p })}>
        <span className="dots">⋯</span>
      </button>
    </div>
  );

  // Soltar um projeto arrastado numa pasta (ou na lista solta, para tirar da pasta).
  const dropZone = (folderId) => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes('trama/project')) return;
      e.preventDefault();
      setDropOn(folderId ?? 'root');
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDropOn(null);
    },
    onDrop: (e) => {
      const id = e.dataTransfer.getData('trama/project');
      setDropOn(null);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const p = projects.find((x) => x.id === id);
      if (p && (p.folder || null) !== (folderId || null)) act(() => api.moveProject(id, folderId || null));
    },
  });

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

      <div className="side-section">
        Projetos
        <button className="section-btn" title="Nova pasta" onClick={() => setEditing({ kind: 'newFolder' })}>
          <Icon name="folderPlus" size={14} />
        </button>
      </div>
      <div className={`project-list ${dropOn === 'root' ? 'drop-on' : ''}`} {...dropZone(null)}>
        {editing?.kind === 'newFolder' && (
          <div className="folder-head editing">
            <Icon name="folder" size={14} />
            <NameInput placeholder="Nome da pasta" onDone={finishEdit} />
          </div>
        )}
        {folders.map((f) => {
          const items = live.filter((p) => p.folder === f.id);
          const open = !ui.closed.includes(f.id);
          return (
            <div key={f.id} className={`folder ${dropOn === f.id ? 'drop-on' : ''}`} {...dropZone(f.id)}>
              <div
                className={`folder-head ${menu?.folder?.id === f.id ? 'menu-open' : ''}`}
                onClick={() => editing?.id !== f.id && toggleFolder(f.id)}
                onContextMenu={(e) => openMenu(e, { folder: f })}
                title={f.name}
              >
                <Icon name="chevron" size={12} className={`folder-chev ${open ? 'open' : ''}`} />
                <Icon name="folder" size={14} />
                {editing?.kind === 'folder' && editing.id === f.id ? (
                  <NameInput value={f.name} onDone={finishEdit} />
                ) : (
                  <span className="folder-name">{f.name}</span>
                )}
                <span className="folder-count">{items.length || ''}</span>
              </div>
              {open && <div className="folder-items">{items.length ? items.map(row) : <div className="folder-empty">Vazia. Arraste um projeto para cá.</div>}</div>}
            </div>
          );
        })}
        {projects.length === 0 && <div className="muted small pad">Nenhum projeto ainda</div>}
        {loose.map(row)}

        {archived.length > 0 && (
          <div className="folder archived">
            <div className="folder-head" onClick={() => saveUi({ ...ui, archived: !ui.archived })}>
              <Icon name="chevron" size={12} className={`folder-chev ${ui.archived ? 'open' : ''}`} />
              <Icon name="archive" size={14} />
              <span className="folder-name">Arquivados</span>
              <span className="folder-count">{archived.length}</span>
            </div>
            {ui.archived && <div className="folder-items">{archived.map(row)}</div>}
          </div>
        )}
      </div>

      {menu?.project && (() => {
        const p = menu.project;
        return (
          <div className="card-menu side-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
            <div className="card-menu-title">{p.title}</div>
            <button
              onClick={() => {
                setMenu(null);
                setEditing({ kind: 'project', id: p.id });
              }}
            >
              <Icon name="pencil" size={14} /> Renomear
            </button>
            <button onClick={() => act(() => api.archiveProject(p.id, !p.archived))}>
              <Icon name="archive" size={14} /> {p.archived ? 'Desarquivar' : 'Arquivar'}
            </button>
            <span className="card-menu-sep" />
            <div className="card-menu-label">Mover para pasta</div>
            {folders.map((f) => (
              <button key={f.id} disabled={p.folder === f.id} onClick={() => act(() => api.moveProject(p.id, f.id))}>
                <Icon name={p.folder === f.id ? 'check' : 'folder'} size={14} /> {f.name}
              </button>
            ))}
            <button
              onClick={() => {
                setMenu(null);
                setEditing({ kind: 'newFolder', moveId: p.id });
              }}
            >
              <Icon name="folderPlus" size={14} /> Nova pasta…
            </button>
            {p.folder && known.has(p.folder) && (
              <button onClick={() => act(() => api.moveProject(p.id, null))}>
                <Icon name="folderOut" size={14} /> Tirar da pasta
              </button>
            )}
            <span className="card-menu-sep" />
            <button
              className="danger"
              onClick={() => {
                setMenu(null);
                if (confirm(`Apagar o projeto "${p.title}"? A conversa e o canvas somem. Os arquivos gerados continuam na pasta do ComfyUI.`)) onDelete(p.id);
              }}
            >
              <Icon name="trash" size={14} /> Apagar
            </button>
          </div>
        );
      })()}

      {menu?.folder && (() => {
        const f = menu.folder;
        const n = live.filter((p) => p.folder === f.id).length;
        return (
          <div className="card-menu side-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
            <div className="card-menu-title">{f.name}</div>
            <button
              onClick={() => {
                setMenu(null);
                setEditing({ kind: 'folder', id: f.id });
              }}
            >
              <Icon name="pencil" size={14} /> Renomear pasta
            </button>
            <span className="card-menu-sep" />
            <button
              className="danger"
              onClick={() => {
                setMenu(null);
                if (!n || confirm(`Apagar a pasta "${f.name}"? Os ${n} projeto(s) dela voltam para a lista, nada é apagado.`)) act(() => api.deleteFolder(f.id));
              }}
            >
              <Icon name="trash" size={14} /> Apagar pasta
            </button>
          </div>
        );
      })()}

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
