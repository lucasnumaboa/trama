import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api } from './api.js';
import Sidebar from './Sidebar.jsx';
import Canvas from './Canvas.jsx';
import Chat from './Chat.jsx';
import Settings from './Settings.jsx';
import { WorkflowsModal, PreviewModal } from './Modals.jsx';

const LAST = 'trama:project';
// Endereço pode abrir um projeto ou janela: #project=prj_x&modal=settings&section=models
const HASH = new URLSearchParams(window.location.hash.slice(1));

export default function App() {
  const [projects, setProjects] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [project, setProject] = useState(null);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState([]);
  // Anexos da próxima mensagem: cards selecionados entram, desmarcar não tira.
  const [attachments, setAttachments] = useState([]);
  const fromChat = useRef(false); // seleção feita ao localizar um card pelo chat não vira anexo
  useEffect(() => {
    if (fromChat.current) {
      fromChat.current = false;
      return;
    }
    if (selected.length) setAttachments((list) => [...new Set([...list, ...selected])]);
  }, [selected]);
  const [focus, setFocus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [modal, setModal] = useState(['settings', 'workflows'].includes(HASH.get('modal')) ? HASH.get('modal') : null);
  const [settings, setSettings] = useState(null);
  const [comfy, setComfy] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(localStorage.getItem('trama:model') || '');
  const [toast, setToast] = useState('');

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 6000);
  }, []);
  const refreshProjects = useCallback(() => api.projects().then((r) => setProjects(r.projects)).catch(() => {}), []);

  // Carga inicial
  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setModel((m) => m || s.deepseekModel);
      if (s.deepseekKeySet) api.deepseekModels().then((r) => setModels(r.models)).catch(() => {});
      else setModal('settings');
    });
    api.comfyStatus().then(setComfy).catch(() => setComfy({ ok: false }));
    api.projects().then(async (r) => {
      setProjects(r.projects);
      const last = HASH.get('project') || localStorage.getItem(LAST);
      if (r.projects.some((p) => p.id === last)) setCurrentId(last);
      else if (r.projects.length) setCurrentId(r.projects[0].id);
      else {
        const p = await api.createProject();
        setProjects([{ id: p.id, title: p.title, updatedAt: p.updatedAt }]);
        setCurrentId(p.id);
      }
    });
    const t = setInterval(() => api.comfyStatus().then(setComfy).catch(() => setComfy({ ok: false })), 30000);
    return () => clearInterval(t);
  }, []);

  // Projeto atual + eventos ao vivo
  useEffect(() => {
    if (!currentId) return undefined;
    localStorage.setItem(LAST, currentId);
    setSelected([]);
    setAttachments([]);
    let alive = true;
    api
      .project(currentId)
      .then((p) => {
        if (!alive) return;
        setProject(p);
        setRunning(p.running);
      })
      .catch((e) => say(e.message));

    const es = new EventSource(`/api/projects/${currentId}/events`);
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.type === 'running') {
        setRunning(ev.running);
        if (!ev.running) refreshProjects();
        return;
      }
      setProject((p) => {
        if (!p) return p;
        switch (ev.type) {
          case 'asset': {
            const exists = p.assets.some((a) => a.id === ev.asset.id);
            return { ...p, assets: exists ? p.assets.map((a) => (a.id === ev.asset.id ? ev.asset : a)) : [...p.assets, ev.asset] };
          }
          case 'asset-removed':
            return { ...p, assets: p.assets.filter((a) => a.id !== ev.id), edges: p.edges.filter((e) => e.source !== ev.id && e.target !== ev.id) };
          case 'edge':
            return p.edges.some((e) => e.id === ev.edge.id) ? p : { ...p, edges: [...p.edges, ev.edge] };
          case 'message': {
            const exists = p.messages.some((m) => m.id === ev.message.id);
            return { ...p, messages: exists ? p.messages.map((m) => (m.id === ev.message.id ? ev.message : m)) : [...p.messages, ev.message] };
          }
          case 'project':
            setProjects((list) => list.map((x) => (x.id === p.id ? { ...x, title: ev.title } : x)));
            return { ...p, title: ev.title };
          default:
            return p;
        }
      });
    };
    return () => {
      alive = false;
      es.close();
    };
  }, [currentId, say, refreshProjects]);

  async function newProject() {
    const p = await api.createProject();
    await refreshProjects();
    setCurrentId(p.id);
  }

  async function send(text) {
    try {
      setRunning(true);
      await api.send(project.id, { text, attachments, model });
      setAttachments([]);
      setSelected([]);
    } catch (e) {
      setRunning(false);
      say(e.message);
    }
  }

  const openAsset = useCallback((a) => setPreview(a), []);
  const focusAsset = useCallback((id) => {
    setFocus({ id, at: Date.now() });
    fromChat.current = true;
    setSelected([id]);
  }, []);

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        currentId={currentId}
        onSelect={setCurrentId}
        onNew={newProject}
        onDelete={async (id) => {
          await api.deleteProject(id);
          const r = await api.projects();
          setProjects(r.projects);
          if (id === currentId) {
            if (r.projects.length) setCurrentId(r.projects[0].id);
            else newProject();
          }
        }}
        onWorkflows={() => setModal('workflows')}
        onSettings={() => setModal('settings')}
        comfy={comfy}
        settings={settings}
      />
      <main className="stage">
        <ReactFlowProvider>
          <Canvas project={project} onOpen={openAsset} selectedIds={selected} onSelect={setSelected} focusId={focus} />
        </ReactFlowProvider>
      </main>
      <Chat
        project={project}
        running={running}
        onSend={send}
        onStop={() => api.stop(project.id)}
        attachments={attachments}
        setAttachments={setAttachments}
        models={[...new Set([model, settings?.deepseekModel, ...models].filter(Boolean))]}
        model={model}
        setModel={(m) => {
          setModel(m);
          localStorage.setItem('trama:model', m);
        }}
        onFocus={focusAsset}
        onRename={(title) => api.renameProject(project.id, title).catch((e) => say(e.message))}
      />

      {toast && <div className="toast">{toast}</div>}
      {preview && (
        <PreviewModal
          asset={project?.assets.find((a) => a.id === preview.id) || preview}
          onClose={() => setPreview(null)}
          onSaveText={(text) => api.updateAsset(project.id, preview.id, { text }).then(() => say('Texto salvo')).catch((e) => say(e.message))}
          onVersion={(assetId, index) => api.updateAsset(project.id, assetId, { current: index }).catch((e) => say(e.message))}
        />
      )}
      {modal === 'workflows' && <WorkflowsModal onClose={() => setModal(null)} />}
      {modal === 'settings' && (
        <Settings
          settings={settings}
          onClose={() => setModal(null)}
          onSaved={(s) => {
            setSettings(s);
            api.comfyStatus().then(setComfy).catch(() => setComfy({ ok: false }));
            if (s.deepseekKeySet) api.deepseekModels().then((r) => setModels(r.models)).catch(() => setModels([]));
          }}
        />
      )}
    </div>
  );
}
