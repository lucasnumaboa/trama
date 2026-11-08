import { useEffect, useRef, useState } from 'react';
import { fileUrl } from './api.js';
import { Icon, RichText, KIND_LABEL } from './ui.jsx';
import Composer, { Thumb } from './Composer.jsx';

const SUGGESTIONS = [
  { icon: 'image', text: 'Crie 3 opções de capa para um vídeo sobre café da manhã' },
  { icon: 'video', text: 'Anime a imagem selecionada num vídeo curto com movimento de câmera' },
  { icon: 'audio', text: 'Faça uma música alegre de 20 segundos, cantada em português' },
  { icon: 'flow', text: 'Monte um vídeo curto: roteiro, cenas, trilha e montagem final' },
];

function AssetChip({ asset, onClick }) {
  if (!asset) return null;
  return (
    <span className={`chip chip-${asset.kind}`} onClick={onClick} title={`${KIND_LABEL[asset.kind] || ''}: ${asset.title}`}>
      <Thumb asset={asset} size={18} />
      <span className="chip-text">{asset.title}</span>
    </span>
  );
}

/** Texto do usuário com as referências "@{asset_x}" mostradas como chips. */
function UserText({ text, assets, onFocus }) {
  const parts = String(text).split(/(@\{asset_[0-9a-f]{8}\})/g);
  return (
    <div className="bubble">
      {parts.map((p, i) => {
        const m = /^@\{(asset_[0-9a-f]{8})\}$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const a = assets.find((x) => x.id === m[1]);
        return a ? (
          <span key={i} className={`ref-chip ref-${a.kind}`} onClick={() => onFocus(a.id)}>
            {a.kind === 'image' && a.file && <img src={fileUrl(a.file)} alt="" />}
            <span>{a.title}</span>
          </span>
        ) : (
          <span key={i} className="ref-chip missing">item removido</span>
        );
      })}
    </div>
  );
}

function Step({ part, assets, onFocus }) {
  const [open, setOpen] = useState(false);
  const icon = part.status === 'running' ? <span className="mini-spin" /> : <Icon name={part.status === 'error' ? 'alert' : stepIcon(part)} size={14} />;
  const list = (part.assetIds || []).map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  return (
    <div className={`step step-${part.status}`}>
      <button className="step-head" onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="step-label">{part.label}</span>
        {(part.error || list.length > 0) && <Icon name="chevron" size={12} className={`step-chevron ${open ? 'rot' : ''}`} />}
      </button>
      {part.warnings?.length > 0 && (
        <div className="step-warnings">
          {part.warnings.map((w, i) => (
            <div key={i}>
              <Icon name="alert" size={11} /> {w}
            </div>
          ))}
        </div>
      )}
      {open && part.error && <div className="step-error">{part.error}</div>}
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

function stepIcon(part) {
  const t = part.tool || '';
  if (t === 'run_workflow' || t === 'revise_asset') return 'sparkle';
  if (t === 'edit_media') return 'scissors';
  if (t === 'create_text' || t === 'update_text' || t === 'read_text') return 'text';
  if (t.includes('workflow')) return 'flow';
  if (t === 'media_info') return 'search';
  return 'check';
}

/** Briefing do agente: várias perguntas, cada uma com opções (uma ou várias) e resposta livre. */
function Briefing({ part, onAnswer, running }) {
  // Formato antigo: uma pergunta só, respondida com um clique.
  const questions = part.questions || [{ question: part.question, options: part.options || [] }];
  const single = !part.questions && questions.length === 1;
  const [picked, setPicked] = useState(() => questions.map(() => []));
  const [free, setFree] = useState(() => questions.map(() => ''));
  const done = Boolean(part.answer);

  const toggle = (qi, opt, multiple) =>
    setPicked((all) => all.map((list, i) => (i !== qi ? list : multiple ? (list.includes(opt) ? list.filter((o) => o !== opt) : [...list, opt]) : list[0] === opt ? [] : [opt])));
  const answerOf = (qi) => [...picked[qi], free[qi].trim()].filter(Boolean).join('; ');
  const ready = questions.every((_, qi) => answerOf(qi));
  const submit = () => {
    const text = questions.map((q, qi) => `${q.question}\n→ ${answerOf(qi) || 'decida você'}`).join('\n\n');
    onAnswer(text);
  };

  return (
    <div className="question">
      <div className="q-head">
        <Icon name="chat" size={14} /> {questions.length > 1 ? 'Briefing' : 'Confirmação'}
      </div>
      {part.intro && <div className="q-intro">{part.intro}</div>}
      {questions.map((q, qi) => (
        <div key={qi} className="q-block">
          <div className="q-text">
            {questions.length > 1 && <span className="q-num">{qi + 1}</span>}
            {q.question}
            {q.multiple && <small className="q-hint">pode marcar várias</small>}
          </div>
          <div className="q-options">
            {q.options.map((o, j) => {
              const on = done ? String(part.answer).includes(o) : picked[qi].includes(o);
              return (
                <button
                  key={o}
                  className={`q-opt ${on ? 'chosen' : ''}`}
                  disabled={done || running}
                  onClick={() => (single ? onAnswer(o) : toggle(qi, o, q.multiple))}
                >
                  {on ? <Icon name="check" size={13} /> : <span className={`q-dot ${q.multiple ? 'q-box' : ''}`} />}
                  <span>{o}</span>
                  {j === 0 && !done && <small>recomendado</small>}
                </button>
              );
            })}
          </div>
          {!done && !single && (
            <input
              className="q-free"
              placeholder="Ou escreva do seu jeito…"
              value={free[qi]}
              disabled={running}
              onChange={(e) => setFree((all) => all.map((v, i) => (i === qi ? e.target.value : v)))}
              onKeyDown={(e) => e.key === 'Enter' && ready && submit()}
            />
          )}
        </div>
      ))}
      {!done && !single && (
        <div className="q-actions">
          <button className="q-skip" disabled={running} onClick={() => onAnswer('Decida você as perguntas do briefing, com as suas recomendações.')}>
            Decida você
          </button>
          <button className="q-send primary" disabled={!ready || running} onClick={submit}>
            Enviar respostas
          </button>
        </div>
      )}
      {done && (single ? !q0Has(questions, part.answer) : true) && <div className="q-answer">Você respondeu: {part.answer}</div>}
    </div>
  );
}
const q0Has = (questions, answer) => questions[0]?.options?.includes(answer);

function Message({ m, assets, onFocus, onAnswer, running }) {
  if (m.role === 'user') {
    const inline = new Set([...String(m.text).matchAll(/@\{(asset_[0-9a-f]{8})\}/g)].map((x) => x[1]));
    const loose = (m.attachments || []).filter((id) => !inline.has(id));
    return (
      <div className="msg msg-user">
        {loose.length > 0 && (
          <div className="user-attachments">
            {loose.map((id) => {
              const a = assets.find((x) => x.id === id);
              return a ? (
                <button key={id} className="user-thumb" onClick={() => onFocus(id)} title={a.title}>
                  <Thumb asset={a} size={64} />
                </button>
              ) : null;
            })}
          </div>
        )}
        <UserText text={m.text} assets={assets} onFocus={onFocus} />
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      {m.parts.map((part, i) => {
        if (part.type === 'text') return <RichText key={i} text={part.text} />;
        if (part.type === 'step') return <Step key={part.id || i} part={part} assets={assets} onFocus={onFocus} />;
        if (part.type === 'error') return <div key={i} className="msg-error">{part.text}</div>;
        if (part.type === 'question') return <Briefing key={i} part={part} onAnswer={onAnswer} running={running} />;
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

export default function Chat({ project, running, onSend, onStop, attachments, setAttachments, models, model, setModel, onFocus, onRename, onUploaded }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const scroller = useRef(null);
  const composer = useRef(null);
  const assets = project?.assets || [];
  const messages = project?.messages || [];

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, project?.id]);

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
            <div className="welcome-mark">
              <img src="/logo.png" alt="" />
            </div>
            <h3>O que vamos criar hoje?</h3>
            <p>Conte a ideia. Eu planejo, escolho os modelos do seu ComfyUI, gero e vou montando tudo no canvas.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.text} onClick={() => composer.current?.setText(s.text)}>
                  <Icon name={s.icon} size={15} />
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} assets={assets} onFocus={onFocus} onAnswer={(o) => onSend(o)} running={running} />
        ))}
      </div>

      <div className="composer-wrap">
        <Composer
          ref={composer}
          project={project}
          running={running}
          attachments={attachments}
          setAttachments={setAttachments}
          onSend={onSend}
          onStop={onStop}
          models={models}
          model={model}
          setModel={setModel}
          onFocus={onFocus}
          onUploaded={onUploaded}
        />
        <div className="composer-note">O agente usa os workflows do seu ComfyUI · Enter envia, Shift+Enter quebra a linha</div>
      </div>
    </aside>
  );
}
