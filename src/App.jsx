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
  const [folders, setFolders] = useState([]);
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
  // Qual provedor abrir nas Configurações (ao clicar num provedor sem chave).
  const [settingsProvider, setSettingsProvider] = useState(null);
  const [toast, setToast] = useState('');

  const say = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 6000);
  }, []);
  const refreshProjects = useCallback(
    () =>
      api
        .projects()
        .then((r) => {
          setProjects(r.projects);
          setFolders(r.folders || []);
        })
        .catch(() => {}),
    [],
  );

  // Carga inicial
  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      if (!s.providers?.[s.llmProvider]?.ready) setModal('settings');
    });
    api.comfyStatus().then(setComfy).catch(() => setComfy({ ok: false }));
    api.projects().then(async (r) => {
      setProjects(r.projects);
      setFolders(r.folders || []);
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
    // Projetos criados por um agente de fora (MCP) aparecem na lista sem recarregar.
    const lt = setInterval(refreshProjects, 10000);
    return () => {
      clearInterval(t);
      clearInterval(lt);
    };
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
      await api.send(project.id, { text, attachments, ...agentChoice() });
      setAttachments([]);
      setSelected([]);
    } catch (e) {
      setRunning(false);
      say(e.message);
    }
  }

  const openAsset = useCallback((a) => setPreview(a), []);

  // Provedor e modelo do agente que vão com a mensagem (o servidor usa os salvos se faltar).
  const agentChoice = () => {
    const id = settings?.llmProvider;
    return id ? { provider: id, model: settings.providers?.[id]?.model } : {};
  };
  const openSettings = (provider) => {
    setSettingsProvider(provider || null);
    setModal('settings');
  };

  // "Apontar correção" num modelo 3D: a foto da vista com o ponto marcado vira um card
  // ao lado do modelo e vai para o agente junto com o pedido.
  async function fix3d(asset, { blob, text }) {
    if (running) throw new Error('O agente ainda está trabalhando neste projeto. Espere terminar e peça de novo.');
    const pos = asset.position ? { x: asset.position.x + 360, y: asset.position.y } : undefined;
    const file = new File([blob], `correcao-${asset.title}.png`.replace(/[\\/:*?"<>|]+/g, '_'), { type: 'image/png' });
    const shot = await api.upload(project.id, file, pos);
    await api.updateAsset(project.id, shot.id, { title: `Correção: ${text}`.slice(0, 80) }).catch(() => {});
    setRunning(true);
    try {
      await api.send(project.id, {
        text: `Corrija o modelo 3D "${asset.title}": ${text}. O ponto está marcado com um círculo vermelho na imagem "Correção: ${text}".`.slice(0, 2000),
        attachments: [asset.id, shot.id],
        ...agentChoice(),
      });
    } catch (e) {
      setRunning(false);
      throw e;
    }
    setPreview(null);
  }
  // "Pintar região" numa imagem: a máscara (branco = onde muda) vira um card ao lado e
  // vai para o agente junto com a imagem e o pedido.
  async function paintImage(asset, { blob, text }) {
    if (running) throw new Error('O agente ainda está trabalhando neste projeto. Espere terminar e peça de novo.');
    const pos = asset.position ? { x: asset.position.x + 360, y: asset.position.y } : undefined;
    const file = new File([blob], `mascara-${asset.title}.png`.replace(/[\\/:*?"<>|]+/g, '_'), { type: 'image/png' });
    const mask = await api.upload(project.id, file, pos);
    await api.updateAsset(project.id, mask.id, { title: `Máscara: ${text}`.slice(0, 80) }).catch(() => {});
    setRunning(true);
    try {
      await api.send(project.id, {
        text: `Mude só a região pintada da imagem "${asset.title}": ${text}. A região está na máscara "Máscara: ${text}" (branco = onde muda).`.slice(0, 2000),
        attachments: [asset.id, mask.id],
        ...agentChoice(),
      });
    } catch (e) {
      setRunning(false);
      throw e;
    }
    setPreview(null);
  }
  const focusAsset = useCallback((id) => {
    setFocus({ id, at: Date.now() });
    fromChat.current = true;
    setSelected([id]);
  }, []);

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        folders={folders}
        onChanged={refreshProjects}
        onError={say}
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
        settings={settings}
        onSettingsSaved={setSettings}
        onOpenSettings={openSettings}
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
          onFix3d={fix3d}
          onPaintImage={paintImage}
          agentBusy={running}
        />
      )}
      {modal === 'workflows' && <WorkflowsModal onClose={() => setModal(null)} />}
      {modal === 'settings' && (
        <Settings
          settings={settings}
          initialProvider={settingsProvider}
          onClose={() => setModal(null)}
          onSaved={(s) => {
            setSettings(s);
            api.comfyStatus().then(setComfy).catch(() => setComfy({ ok: false }));
          }}
        />
      )}
    </div>
  );
}
