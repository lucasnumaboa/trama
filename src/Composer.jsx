// Caixa de mensagem: anexos (colar, arrastar, botão +, cards selecionados),
// referências clicáveis dentro do texto e o seletor de modelos.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, fileUrl } from './api.js';
import { Icon } from './ui.jsx';
import ModelPicker from './ModelPicker.jsx';
import { cleanUrl, linkInfo, linkPreview, splitUrls } from './links.js';

const isMediaFile = (f) => /^(image|video|audio)\//.test(f.type);

function Thumb({ asset, size = 22 }) {
  if (asset.kind === 'image' && asset.file) return <img src={fileUrl(asset.file)} alt="" style={{ width: size, height: size }} />;
  if (asset.kind === 'video' && asset.file) return <video src={`${fileUrl(asset.file)}#t=0.1`} muted preload="metadata" style={{ width: size, height: size }} />;
  return (
    <span className="thumb-icon" style={{ width: size, height: size }}>
      <Icon name={asset.kind} size={Math.round(size * 0.6)} />
    </span>
  );
}

/** Cria o elemento de referência que vai dentro do texto. */
function makeChip(asset) {
  const chip = document.createElement('span');
  chip.className = `ref-chip ref-${asset.kind}`;
  chip.contentEditable = 'false';
  chip.dataset.asset = asset.id;
  if (asset.kind === 'image' && asset.file) {
    const img = document.createElement('img');
    img.src = fileUrl(asset.file);
    chip.appendChild(img);
  }
  const label = document.createElement('span');
  label.textContent = asset.title;
  chip.appendChild(label);
  return chip;
}

/** Tag de link (YouTube e outros): ícone/miniatura e o título, que chega depois. */
function makeLinkChip(rawUrl) {
  const url = cleanUrl(rawUrl);
  const info = linkInfo(url);
  const chip = document.createElement('span');
  chip.className = `ref-chip ref-link ref-link-${info.site}`;
  chip.contentEditable = 'false';
  chip.dataset.url = url;
  chip.title = url;
  if (info.thumb) {
    const img = document.createElement('img');
    img.src = info.thumb;
    img.alt = '';
    chip.appendChild(img);
  }
  const label = document.createElement('span');
  label.textContent = info.label;
  chip.appendChild(label);
  linkPreview(url).then((p) => {
    if (p.title) label.textContent = p.title;
    if (!info.thumb && p.thumbnail) {
      const img = document.createElement('img');
      img.src = p.thumbnail;
      img.alt = '';
      chip.prepend(img);
    }
  });
  return chip;
}

/** Fragmento com o texto e os links já como tags. */
function linkify(text) {
  const frag = document.createDocumentFragment();
  for (const part of splitUrls(text)) {
    if (part.url) {
      frag.appendChild(makeLinkChip(part.url));
      frag.appendChild(document.createTextNode(' '));
    } else frag.appendChild(document.createTextNode(part.text));
  }
  return frag;
}

/** Converte o editor em texto com "@{asset_x}" no lugar das referências. */
function serialize(root) {
  let out = '';
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.dataset?.asset) out += `@{${n.dataset.asset}}`;
      else if (n.dataset?.url) out += `${out && !/\s$/.test(out) ? ' ' : ''}${n.dataset.url} `;
      else if (n.nodeName === 'BR') out += '\n';
      else {
        if (n.nodeName === 'DIV' && out && !out.endsWith('\n')) out += '\n';
        walk(n);
      }
    }
  };
  walk(root);
  return out.replace(/ /g, ' ').trim();
}

const Composer = forwardRef(function Composer(
  { project, running, attachments, setAttachments, onSend, onStop, settings, onSettingsSaved, onOpenSettings, onFocus, onUploaded },
  ref,
) {
  const editor = useRef(null);
  const fileInput = useRef(null);
  const savedRange = useRef(null);
  const [empty, setEmpty] = useState(true);
  const [uploading, setUploading] = useState(0);
  const [picker, setPicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Ctrl+A no chat marca também os anexos; Delete/Backspace então tira todos de uma vez.
  const [allMarked, setAllMarkedState] = useState(false);
  const allMarkedRef = useRef(false); // a tecla seguinte pode chegar antes de a tela redesenhar
  const setAllMarked = (v) => {
    allMarkedRef.current = v;
    setAllMarkedState(v);
  };
  const assets = project?.assets || [];
  const attached = attachments.map((id) => assets.find((a) => a.id === id)).filter(Boolean);

  useImperativeHandle(ref, () => ({ setText: (t) => setPlain(t), focus: () => editor.current?.focus() }));

  function setPlain(text) {
    if (!editor.current) return;
    editor.current.textContent = text;
    setEmpty(!text);
  }

  // Lembra onde está o cursor para inserir a referência no lugar certo.
  function rememberCaret() {
    const sel = window.getSelection();
    if (sel?.rangeCount && editor.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  }

  function insertReference(asset) {
    const el = editor.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range = savedRange.current && el.contains(savedRange.current.startContainer) ? savedRange.current : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const chip = makeChip(asset);
    const space = document.createTextNode(' ');
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(chip);
    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange.current = range.cloneRange();
    setEmpty(false);
  }

  /** Insere nós no cursor (ou no fim) e deixa o cursor depois deles. */
  function insertAtCaret(frag) {
    const el = editor.current;
    if (!el) return;
    const sel = window.getSelection();
    let range = sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const last = frag.lastChild;
    range.deleteContents();
    range.insertNode(frag);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    savedRange.current = range.cloneRange();
    setEmpty(!serialize(el));
  }

  // Link digitado: vira tag quando já está completo (com espaço ou quebra de linha
  // depois). O cursor volta para o mesmo ponto do texto.
  function linkifyTyped() {
    const el = editor.current;
    if (!el) return;
    const sel = window.getSelection();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/https?:\/\/\S+\s/.test(n.textContent)) nodes.push(n);
    if (!nodes.length) return;
    let caretAfter = null;
    for (const node of nodes) {
      const hadCaret = sel?.anchorNode === node;
      const text = node.textContent;
      const frag = document.createDocumentFragment();
      let last = 0;
      let lastChip = null;
      for (const m of text.matchAll(/(https?:\/\/\S+)(?=\s)/g)) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        lastChip = makeLinkChip(m[1]);
        frag.appendChild(lastChip);
        last = m.index + m[1].length;
      }
      const tail = document.createTextNode(text.slice(last));
      frag.appendChild(tail);
      node.replaceWith(frag);
      if (hadCaret) caretAfter = tail;
    }
    if (caretAfter && sel) {
      const r = document.createRange();
      r.setStart(caretAfter, caretAfter.textContent.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  async function uploadFiles(files) {
    const media = [...files].filter(isMediaFile);
    if (!media.length || !project) return;
    setUploading((n) => n + media.length);
    for (const f of media) {
      try {
        // Imagens da área de transferência vêm todas como "image.png": nome único para não sobrescrever.
        const stamp = `${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
        const name = f.name && f.name !== 'image.png' ? f.name : `colado-${stamp}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
        const asset = await api.upload(project.id, new File([f], name, { type: f.type }));
        onUploaded?.(asset);
        setAttachments((list) => [...new Set([...list, asset.id])]);
      } catch (e) {
        alert(`Não consegui enviar ${f.name || 'o arquivo'}: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function submit() {
    if (running || uploading) return;
    const text = serialize(editor.current);
    if (!text) return;
    onSend(text);
    editor.current.innerHTML = '';
    setEmpty(true);
  }

  // Remover um anexo também tira as referências dele do texto.
  function removeAttachment(id) {
    setAttachments((list) => list.filter((x) => x !== id));
    editor.current?.querySelectorAll(`[data-asset="${id}"]`).forEach((n) => n.remove());
    setEmpty(!serialize(editor.current));
  }

  function removeAllAttachments() {
    setAttachments([]);
    editor.current?.querySelectorAll('[data-asset]').forEach((n) => n.remove());
    setAllMarked(false);
    setEmpty(!serialize(editor.current));
  }

  function onComposerKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      if (!attached.length) return;
      // Marca o texto da caixa (não a página inteira) e os anexos.
      e.preventDefault();
      const el = editor.current;
      if (el && serialize(el)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setAllMarked(true);
      return;
    }
    if (!allMarkedRef.current) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // O texto marcado junto é apagado pelo próprio navegador.
      const sel = window.getSelection();
      const textMarked = sel && !sel.isCollapsed && editor.current?.contains(sel.anchorNode);
      if (!textMarked) e.preventDefault();
      removeAllAttachments();
    } else if (!['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) {
      setAllMarked(false);
    }
  }

  useEffect(() => {
    if (!attached.length) setAllMarked(false);
  }, [attached.length]);

  useEffect(() => {
    // Ao trocar de projeto, limpa o texto.
    if (editor.current) editor.current.innerHTML = '';
    setEmpty(true);
    setAllMarked(false);
  }, [project?.id]);

  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onKeyDown={onComposerKeyDown}
      onMouseDown={() => allMarked && setAllMarked(false)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      {(attached.length > 0 || uploading > 0) && (
        <div className={`attach-row ${allMarked ? 'all-marked' : ''}`}>
          {attached.map((a) => (
            <div key={a.id} className="attach" title={`Clique para citar "${a.title}" no texto`}>
              <button className="attach-thumb" onMouseDown={(e) => e.preventDefault()} onClick={() => insertReference(a)}>
                <Thumb asset={a} size={56} />
                <span className="attach-plus">
                  <Icon name="plus" size={12} />
                </span>
              </button>
              <button className="attach-x" title="Remover anexo" onClick={() => removeAttachment(a.id)}>
                <Icon name="close" size={10} />
              </button>
              <button className="attach-locate" title="Mostrar no canvas" onClick={() => onFocus(a.id)}>
                <Icon name="fit" size={10} />
              </button>
            </div>
          ))}
          {uploading > 0 && (
            <div className="attach attach-loading">
              <span className="mini-spin" />
            </div>
          )}
        </div>
      )}
      {allMarked && attached.length > 0 && (
        <div className="attach-marked-hint">
          {attached.length === 1 ? '1 anexo marcado' : `${attached.length} anexos marcados`}: Delete ou Backspace remove {attached.length === 1 ? 'o anexo' : 'todos'}
        </div>
      )}

      <div className="editor-wrap">
        {empty && (
          <div className="editor-placeholder">
            {attached.length
              ? 'Descreva o que fazer. Clique numa miniatura para citá-la no texto…'
              : 'Descreva o que você quer criar. Cole ou arraste imagens aqui, ou selecione cards no canvas.'}
          </div>
        )}
        <div
          ref={editor}
          className="editor"
          contentEditable={Boolean(project)}
          suppressContentEditableWarning
          onInput={(e) => {
            if (allMarkedRef.current) setAllMarked(false); // digitou por cima: os anexos ficam
            if (/\s/.test(e.nativeEvent?.data || '') || e.nativeEvent?.inputType === 'insertParagraph') linkifyTyped();
            setEmpty(!serialize(editor.current));
          }}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
          onBlur={rememberCaret}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files || [])].filter(isMediaFile);
            e.preventDefault();
            if (files.length) {
              uploadFiles(files);
              return;
            }
            // Cola só texto puro (sem formatação de outras páginas); links viram tags.
            const text = e.clipboardData.getData('text/plain');
            if (/https?:\/\//.test(text)) insertAtCaret(linkify(text));
            else document.execCommand('insertText', false, text);
          }}
        />
      </div>

      <div className="composer-bar">
        <button className="bar-btn round" title="Anexar imagem, vídeo ou áudio" onClick={() => fileInput.current?.click()} disabled={!project}>
          <Icon name="plus" size={15} />
        </button>
        <div className="picker-anchor">
          <button className={`bar-btn ${picker ? 'on' : ''}`} onClick={() => setPicker((v) => !v)} disabled={!project}>
            <Icon name="cube" size={14} /> Modelos
          </button>
          {picker && (
            <ModelPicker project={project} settings={settings} onSettingsSaved={onSettingsSaved} onOpenSettings={onOpenSettings} onClose={() => setPicker(false)} />
          )}
        </div>
        <span className="grow" />
        {uploading > 0 && <span className="muted small">Enviando…</span>}
        {running ? (
          <button className="send-btn stop" title="Parar" onClick={onStop}>
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button className="send-btn" title="Enviar (Enter)" onClick={submit} disabled={empty || !project || uploading > 0}>
            <Icon name="arrowUp" size={16} />
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          onChange={(e) => {
            uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
});

export default Composer;
export { Thumb };
