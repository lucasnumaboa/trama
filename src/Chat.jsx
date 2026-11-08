import { useEffect, useRef, useState } from 'react';
import { fileUrl } from './api.js';
import { Icon, RichText, KIND_LABEL } from './ui.jsx';

const SUGGESTIONS = [
  'Crie 3 opções de imagem para a capa de um vídeo sobre café da manhã',
  'Transforme a foto selecionada num vídeo curto com movimento de câmera',
  'Monte um vídeo curto: roteiro, cenas e trilha',
];

function AssetChip({ asset, onClick, onRemove }) {
  if (!asset) return null;
  const thumb = asset.kind === 'image' && asset.file ? fileUrl(asset.file) : null;
  return (
    <span className={`chip chip-${asset.kind}`} onClick={onClick} title={`${KIND_LABEL[asset.kind] || ''}: ${asset.title}`}>
      {thumb ? <img src={thumb} alt="" /> : <Icon name={asset.kind} size={12} />}
      <span className="chip-text">{asset.title}</span>
      {onRemove && (
        <button
          className="chip-x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

function Step({ part, assets, onFocus }) {
  const [open, setOpen] = useState(false);
  const icon = part.status === 'running' ? <span className="mini-spin" /> : <Icon name={part.status === 'error' ? 'alert' : 'check'} size={13} />;
  const list = (part.assetIds || []).map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  return (
    <div className={`step step-${part.status}`}>
      <button className="step-head" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span>{part.label}</span>
        {part.error && <Icon name="chevron" size={12} className={open ? 'rot' : ''} />}
      </button>
      {open && part.error && <div className="step-error">{part.error}</div>}
      {part.warnings?.length > 0 && (
        <div className="step-warnings">
          {part.warnings.map((w, i) => (
            <div key={i}>
              <Icon name="alert" size={11} /> {w}
            </div>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <div className="chips">
          {list.map((a) => (
            <AssetChip key={a.id} asset={a} onClick={() => onFocus(a.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ m, assets, onFocus, onAnswer, running }) {
  if (m.role === 'user') {
    return (
      <div className="msg msg-user">
        {m.attachments?.length > 0 && (
          <div className="chips">
            {m.attachments.map((id) => (
              <AssetChip key={id} asset={assets.find((a) => a.id === id)} onClick={() => onFocus(id)} />
            ))}
          </div>
        )}
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      {m.parts.map((part, i) => {
        if (part.type === 'text') return <RichText key={i} text={part.text} />;
        if (part.type === 'step') return <Step key={part.id || i} part={part} assets={assets} onFocus={onFocus} />;
        if (part.type === 'error') return <div key={i} className="msg-error">{part.text}</div>;
        if (part.type === 'question')
          return (
            <div key={i} className="question">
              <div className="q-text">{part.question}</div>
              <div className="q-options">
                {part.options.map((o, j) => (
                  <button
                    key={o}
                    className={`q-opt ${part.answer === o ? 'chosen' : ''}`}
                    disabled={Boolean(part.answer) || running}
                    onClick={() => onAnswer(o)}
                  >
                    {part.answer === o && <Icon name="check" size={12} />}
                    {o}
                    {j === 0 && !part.answer && <small> recomendado</small>}
                  </button>
                ))}
              </div>
              {part.answer && !part.options.includes(part.answer) && <div className="q-answer">Você respondeu: {part.answer}</div>}
            </div>
          );
        return null;
      })}
      {m.thinking && (
        <div className="thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {m.status === 'stopped' && <div className="muted small">Interrompido.</div>}
    </div>
  );
}

export default function Chat({ project, running, onSend, onStop, attachments, setAttachments, models, model, setModel, onFocus, onRename }) {
  const [text, setText] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const scroller = useRef(null);
  const assets = project?.assets || [];
  const messages = project?.messages || [];

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, project?.id]);

  function submit(value = text) {
    const v = value.trim();
    if (!v || running) return;
    onSend(v);
    setText('');
  }

  return (
    <aside className="chat">
      <header className="chat-head">
        {editingTitle ? (
          <input
            autoFocus
            defaultValue={project?.title}
            onBlur={(e) => {
              setEditingTitle(false);
              if (e.target.value.trim() && e.target.value !== project?.title) onRename(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <h2 title="Clique para renomear" onClick={() => project && setEditingTitle(true)}>
            {project?.title || 'Trama'}
          </h2>
        )}
      </header>

      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <h3>O que vamos criar?</h3>
            <p>Conte a ideia. Eu planejo, escolho os workflows do seu ComfyUI, gero e vou montando tudo no canvas.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} assets={assets} onFocus={onFocus} onAnswer={(o) => submit(o)} running={running} />
        ))}
      </div>

      <div className="composer">
        {attachments.length > 0 && (
          <div className="chips composer-chips">
            {attachments.map((id) => (
              <AssetChip
                key={id}
                asset={assets.find((a) => a.id === id)}
                onClick={() => onFocus(id)}
                onRemove={() => setAttachments((list) => list.filter((x) => x !== id))}
              />
            ))}
          </div>
        )}
        <textarea
          rows={3}
          placeholder={attachments.length ? 'Diga o que fazer com os itens selecionados…' : 'Descreva o que você quer criar. Selecione cards no canvas para usá-los.'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!project}
        />
        <div className="composer-bar">
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Modelo do DeepSeek que orquestra">
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="grow" />
          {running ? (
            <button className="round-btn stop" title="Parar" onClick={onStop}>
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button className="round-btn" title="Enviar (Enter)" onClick={() => submit()} disabled={!text.trim() || !project}>
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
