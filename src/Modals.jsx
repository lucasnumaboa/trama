import { useEffect, useState } from 'react';
import { api, fileUrl, downloadFile } from './api.js';
import { Icon, KIND_LABEL } from './ui.jsx';

export function WorkflowsModal({ onClose }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = (refresh) => {
    setList(null);
    api
      .workflows(refresh)
      .then((r) => setList(r.workflows))
      .catch((e) => setError(e.message));
  };
  useEffect(() => load(false), []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Workflows do ComfyUI</h2>
          <div className="row">
            <button onClick={() => load(true)}>Recarregar</button>
            <button className="icon-btn" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        <p className="muted">
          São as capacidades que o agente usa para gerar. Para adicionar uma, monte e salve o workflow no ComfyUI: use nós Load Image/Video/Audio para as
          entradas, Save Image/Video/Audio para as saídas, e escreva numa nota (Markdown Note) o que ele faz. O agente lê essa nota.
        </p>
        {error && <div className="msg-error">{error}</div>}
        {!list && !error && <div className="muted">Lendo os workflows…</div>}
        <div className="wf-list">
          {list?.map((w) => (
            <div key={w.name} className="wf-item">
              <button className="wf-head" onClick={() => setOpen(open === w.name ? null : w.name)}>
                <span className="wf-title">{w.title}</span>
                <span className="wf-io">
                  {w.inputs.map((i, k) => (
                    <Icon key={k} name={i.kind} size={13} title={`Entrada: ${i.title}`} />
                  ))}
                  <span className="arrow">→</span>
                  {w.outputs.map((k) => (
                    <Icon key={k} name={k} size={13} title={`Saída: ${KIND_LABEL[k] || k}`} />
                  ))}
                </span>
              </button>
              {w.error && <div className="msg-error">{w.error}</div>}
              {open === w.name && <pre className="wf-notes">{w.notes || 'Sem notas.'}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PreviewModal({ asset, onClose, onSaveText, onVersion }) {
  const [text, setText] = useState(asset.text || '');
  const [revealError, setRevealError] = useState('');
  const url = fileUrl(asset.file);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal preview" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <Icon name={asset.kind} /> {asset.title}
          </h2>
          <div className="row">
            {url && asset.status !== 'generating' && (
              <>
                <button className="btn" onClick={() => downloadFile(asset.file)}>
                  <Icon name="download" size={14} /> Baixar
                </button>
                <button
                  className="btn"
                  onClick={() => api.revealFile(asset.file).then(() => setRevealError(''), (e) => setRevealError(e.message))}
                >
                  <Icon name="folder" size={14} /> Mostrar na pasta
                </button>
              </>
            )}
            <button className="icon-btn" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        {revealError && <div className="msg-error">{revealError}</div>}
        <div className="preview-body">
          {asset.kind === 'image' && <img src={url} alt={asset.title} />}
          {asset.kind === 'video' && <video src={url} controls autoPlay />}
          {asset.kind === 'audio' && <audio src={url} controls autoPlay />}
          {asset.kind === 'text' && (
            <>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} />
              <div className="row end">
                <button className="primary" onClick={() => onSaveText(text)} disabled={text === asset.text}>
                  Salvar texto
                </button>
              </div>
            </>
          )}
          {asset.status === 'error' && <div className="msg-error">{asset.error}</div>}
        </div>
        {asset.versions?.length > 1 && (
          <div className="version-list">
            {asset.versions.map((v, i) => (
              <button
                key={v.id}
                className={i === (asset.current ?? asset.versions.length - 1) ? 'on' : ''}
                onClick={() => onVersion(asset.id, i)}
                disabled={asset.status === 'generating'}
              >
                <b>v{i + 1}</b> {v.note || ''}
              </button>
            ))}
          </div>
        )}
        {(asset.prompt || asset.workflow) && (
          <div className="preview-meta">
            {asset.workflow && (
              <div>
                <b>Workflow:</b> {asset.workflow}
              </div>
            )}
            {asset.prompt && (
              <div>
                <b>Prompt:</b> {asset.prompt}
              </div>
            )}
            {asset.seeds && Object.keys(asset.seeds).length > 0 && (
              <div>
                <b>Seed:</b> {Object.values(asset.seeds).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
