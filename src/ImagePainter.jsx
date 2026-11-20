// Pintar uma região da imagem para mudar só ali (inpainting). O traço aparece em
// vermelho por cima da imagem; o que vai para o agente é uma máscara do tamanho real
// da imagem, branca onde foi pintado e preta no resto.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

export function ImagePainter({ url, title, onPaint, busy }) {
  const imgRef = useRef(null);
  const viewRef = useRef(null); // canvas visível, no tamanho da imagem na tela
  const maskRef = useRef(null); // canvas da máscara, no tamanho real da imagem
  const drawing = useRef(false);
  const last = useRef(null);
  const [painting, setPainting] = useState(false);
  const [brush, setBrush] = useState(40); // px na tela
  const [painted, setPainted] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Ajusta os dois canvas quando entra no modo pintar ou a imagem muda de tamanho.
  useEffect(() => {
    if (!painting) return;
    const img = imgRef.current;
    const fit = () => {
      if (!img?.naturalWidth) return;
      const view = viewRef.current;
      const r = img.getBoundingClientRect();
      if (view.width !== Math.round(r.width) || view.height !== Math.round(r.height)) {
        const old = view.width ? view.toDataURL() : null;
        view.width = Math.round(r.width);
        view.height = Math.round(r.height);
        if (old) {
          const im = new Image();
          im.onload = () => view.getContext('2d').drawImage(im, 0, 0, view.width, view.height);
          im.src = old;
        }
      }
      const mask = maskRef.current;
      if (mask.width !== img.naturalWidth || mask.height !== img.naturalHeight) {
        mask.width = img.naturalWidth;
        mask.height = img.naturalHeight;
        const ctx = mask.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, mask.width, mask.height);
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(img);
    return () => ro.disconnect();
  }, [painting]);

  const stroke = (from, to) => {
    const view = viewRef.current;
    const mask = maskRef.current;
    const scale = mask.width / view.width;
    for (const [ctx, k, color] of [[view.getContext('2d'), 1, 'rgb(255, 40, 40)'], [mask.getContext('2d'), scale, '#fff']]) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = brush * k;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x * k, from.y * k);
      ctx.lineTo(to.x * k, to.y * k);
      ctx.stroke();
    }
  };
  const point = (e) => {
    const r = viewRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e) => {
    if (sending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    stroke(p, p);
    setPainted(true);
  };
  const move = (e) => {
    if (!drawing.current) return;
    const p = point(e);
    stroke(last.current, p);
    last.current = p;
  };
  const up = () => {
    drawing.current = false;
  };
  const clear = () => {
    const view = viewRef.current;
    view.getContext('2d').clearRect(0, 0, view.width, view.height);
    const mask = maskRef.current;
    const ctx = mask.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mask.width, mask.height);
    setPainted(false);
  };
  const cancel = () => {
    setPainting(false);
    setPainted(false);
    setText('');
  };

  async function send() {
    if (!painted || !text.trim()) return;
    setSending(true);
    setError('');
    try {
      const blob = await new Promise((resolve) => maskRef.current.toBlob(resolve, 'image/png'));
      await onPaint({ blob, text: text.trim() });
      cancel();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`image-painter ${painting ? 'is-painting' : ''}`}>
      <div className="image-painter-stage">
        <img ref={imgRef} src={url} alt={title} />
        {painting && (
          <canvas
            ref={viewRef}
            className="image-painter-canvas"
            style={{ '--brush': `${brush}px` }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        )}
        <canvas ref={maskRef} hidden />
      </div>
      {onPaint && (
        <div className="model-fix">
          {!painting ? (
            <>
              <button className="btn" onClick={() => setPainting(true)} disabled={busy}>
                <Icon name="pencil" size={14} /> Pintar região
              </button>
              {busy && <span className="model-fix-hint">Espere o agente terminar o que está fazendo para pedir uma mudança.</span>}
            </>
          ) : (
            <>
              <span className="model-fix-hint">
                {painted ? 'Pinte mais, ou escreva o que deve aparecer na região pintada.' : 'Pinte por cima do que quer mudar (só essa parte muda).'}
              </span>
              <label className="image-painter-brush">
                Pincel
                <input type="range" min="8" max="160" value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
              </label>
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder="O que colocar aqui? Ex.: tira o copo da mesa; troca a camisa por uma vermelha"
                disabled={sending}
              />
              <button className="primary" onClick={send} disabled={!painted || !text.trim() || sending}>
                {sending ? 'Enviando…' : 'Pedir mudança'}
              </button>
              <button className="btn" onClick={clear} disabled={!painted || sending}>
                Limpar
              </button>
              <button className="btn" onClick={cancel} disabled={sending}>
                Cancelar
              </button>
            </>
          )}
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </div>
  );
}
