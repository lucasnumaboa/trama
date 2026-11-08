import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, MiniMap, Handle, Position, useReactFlow, applyNodeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, fileUrl } from './api.js';
import { Icon, KIND_LABEL } from './ui.jsx';

function VersionSwitch({ asset, onVersion }) {
  const n = asset.versions?.length || 0;
  if (n < 2) return null;
  const cur = asset.current ?? n - 1;
  const go = (e, i) => {
    e.stopPropagation();
    if (i >= 0 && i < n && asset.status !== 'generating') onVersion(asset.id, i);
  };
  return (
    <span className="versions nodrag" title={asset.versions[cur]?.note || ''}>
      <button onClick={(e) => go(e, cur - 1)} disabled={cur === 0}>
        ‹
      </button>
      v{cur + 1}/{n}
      <button onClick={(e) => go(e, cur + 1)} disabled={cur === n - 1}>
        ›
      </button>
    </span>
  );
}

const AssetCard = memo(function AssetCard({ data, selected }) {
  const { asset, onOpen, onVersion } = data;
  const url = fileUrl(asset.file);
  let body;
  if (asset.status === 'generating' && asset.file) {
    // Refazendo ou editando: mostra a versão atual por baixo do aviso.
    const pct = Math.round((asset.progress || 0) * 100);
    body = (
      <div className="card-busy">
        {asset.kind === 'image' ? <img src={url} alt="" draggable={false} /> : asset.kind === 'video' ? <video src={`${url}#t=0.1`} muted preload="metadata" /> : <div className="card-audio"><Icon name={asset.kind} size={28} /></div>}
        <div className="busy-overlay">
          <div className="spinner" />
          <div className="gen-label">{asset.detail || 'Criando nova versão'}</div>
          {pct > 0 && pct < 100 && (
            <div className="gen-bar">
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  } else if (asset.status === 'generating') {
    const pct = Math.round((asset.progress || 0) * 100);
    body = (
      <div className="card-generating">
        <div className="spinner" />
        <div className="gen-label">{asset.detail || 'Gerando'}</div>
        {pct > 0 && (
          <div className="gen-bar">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  } else if (asset.status === 'error') {
    body = (
      <div className="card-error">
        <Icon name="alert" size={18} />
        <span>{asset.error || 'Falhou'}</span>
      </div>
    );
  } else if (asset.kind === 'image') body = <img src={url} alt={asset.title} draggable={false} />;
  // "#t=0.1" faz o navegador desenhar um quadro de verdade como miniatura.
  else if (asset.kind === 'video') body = <video src={`${url}#t=0.1`} controls muted loop preload="metadata" className="nodrag" />;
  else if (asset.kind === 'audio')
    body = (
      <div className="card-audio">
        <Icon name="audio" size={28} />
        <audio src={url} controls preload="none" className="nodrag" />
      </div>
    );
  else if (asset.kind === 'text') body = <div className="card-text nowheel">{asset.text}</div>;
  else body = <div className="card-file">{asset.file?.filename}</div>;

  return (
    <div className={`card card-${asset.kind} ${selected ? 'is-selected' : ''}`} onDoubleClick={() => onOpen(asset)}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="card-handle" />
      <div className="card-title" title={asset.title}>
        <Icon name={asset.kind} size={13} />
        <span>{asset.title}</span>
        <VersionSwitch asset={asset} onVersion={onVersion} />
      </div>
      <div className="card-body">{body}</div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="card-handle" />
    </div>
  );
});

const nodeTypes = { asset: AssetCard };

export default function Canvas({ project, onOpen, selectedIds, onSelect, focusId }) {
  const { screenToFlowPosition, fitView, setCenter, getNode } = useReactFlow();
  const [nodes, setNodes] = useState([]);
  const [showMap, setShowMap] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef(null);
  const lastProject = useRef(null);
  const onVersion = useCallback(
    (assetId, index) => api.updateAsset(project.id, assetId, { current: index }).catch((e) => alert(e.message)),
    [project?.id],
  );

  // Sincroniza cards a partir dos assets, preservando o que o usuário está arrastando.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return (project?.assets || []).map((a) => {
        const old = prevById.get(a.id);
        return {
          id: a.id,
          type: 'asset',
          position: old?.dragging ? old.position : a.position,
          dragging: old?.dragging,
          selected: selectedIds.includes(a.id),
          data: { asset: a, onOpen, onVersion },
        };
      });
    });
  }, [project?.assets, selectedIds, onOpen, onVersion]);

  // Encaixa a visão ao abrir outro projeto.
  useEffect(() => {
    if (project?.id && lastProject.current !== project.id) {
      lastProject.current = project.id;
      setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 0 }), 50);
    }
  }, [project?.id, fitView]);

  // Centraliza um card pedido pelo chat.
  useEffect(() => {
    if (!focusId) return;
    const n = getNode(focusId.id);
    if (n) setCenter(n.position.x + 130, n.position.y + 170, { zoom: 0.9, duration: 400 });
  }, [focusId, getNode, setCenter]);

  const edges = useMemo(
    () =>
      (project?.edges || []).map((e) => {
        const target = project.assets.find((a) => a.id === e.target);
        return { ...e, animated: target?.status === 'generating', className: 'asset-edge' };
      }),
    [project?.edges, project?.assets],
  );

  const onNodesChange = useCallback(
    (changes) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      const sel = changes.filter((c) => c.type === 'select');
      if (sel.length) {
        onSelect((ids) => {
          const set = new Set(ids);
          sel.forEach((c) => (c.selected ? set.add(c.id) : set.delete(c.id)));
          return [...set];
        });
      }
    },
    [onSelect],
  );

  const onNodeDragStop = useCallback(
    (_, node, dragged) => {
      for (const n of dragged?.length ? dragged : [node]) {
        api.updateAsset(project.id, n.id, { position: n.position }).catch(() => {});
      }
    },
    [project?.id],
  );

  async function uploadFiles(files, point) {
    let i = 0;
    for (const f of files) {
      const pos = point ? screenToFlowPosition({ x: point.x + i * 40, y: point.y + i * 40 }) : undefined;
      i += 1;
      await api.upload(project.id, f, pos).catch((e) => alert(`Não consegui enviar ${f.name}: ${e.message}`));
    }
  }

  async function deleteSelected() {
    if (!selectedIds.length) return;
    if (!confirm(`Remover ${selectedIds.length} card(s) do canvas? Os arquivos continuam na pasta do ComfyUI.`)) return;
    for (const id of selectedIds) await api.deleteAsset(project.id, id).catch(() => {});
    onSelect([]);
  }

  return (
    <div
      className={`canvas ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!e.dataTransfer.files?.length || !project) return;
        e.preventDefault();
        uploadFiles([...e.dataTransfer.files], { x: e.clientX, y: e.clientY });
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => onSelect([])}
        nodesConnectable={false}
        deleteKeyCode={null}
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        selectionOnDrag
        panOnDrag={[1, 2]}
        panOnScroll
        zoomActivationKeyCode="Control"
      >
        <Background gap={22} size={1.2} color="#2a2d33" />
        {showMap && <MiniMap pannable zoomable nodeColor="#3a3f48" maskColor="rgba(0,0,0,0.5)" />}
      </ReactFlow>

      {project && project.assets.length === 0 && (
        <div className="canvas-empty">
          <Icon name="flow" size={40} />
          <h2>O canvas deste projeto está vazio</h2>
          <p>Descreva no chat o que você quer criar. Cada imagem, vídeo, áudio ou texto que surgir vira um card aqui, ligado ao que serviu de base para ele.</p>
          <p className="muted">Você também pode arrastar arquivos para cá.</p>
        </div>
      )}

      <div className="dock">
        <button className="dock-btn" title="Enviar arquivos para o projeto" onClick={() => fileInput.current?.click()} disabled={!project}>
          <Icon name="upload" />
        </button>
        <button className="dock-btn" title="Ver tudo" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
          <Icon name="fit" />
        </button>
        <button className={`dock-btn ${showMap ? 'on' : ''}`} title="Minimapa" onClick={() => setShowMap((v) => !v)}>
          <Icon name="map" />
        </button>
        <span className="dock-sep" />
        <button className="dock-btn" title="Remover selecionados" onClick={deleteSelected} disabled={!selectedIds.length}>
          <Icon name="trash" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          onChange={(e) => {
            uploadFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      <div className="canvas-hint">Arraste com o botão esquerdo para selecionar · role para mover · Ctrl + rolar para zoom · duplo clique abre</div>
    </div>
  );
}
