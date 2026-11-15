// Modelos 3D (GLB): miniatura girando no canvas e visualizador com "apontar correção"
// e exportação. Usa o <model-viewer> do Google (three.js por baixo, um renderizador
// compartilhado por todos os cards).
import { useEffect, useRef, useState } from 'react';
import '@google/model-viewer';
import { Icon } from './ui.jsx';

/** Miniatura no card: gira sozinha; sem controles para o arrasto mover o card. */
export function ModelThumb({ url }) {
  return (
    <model-viewer
      class="model-thumb"
      src={url}
      auto-rotate=""
      rotation-per-second="20deg"
      interaction-prompt="none"
      shadow-intensity="0.6"
      environment-image="neutral"
      exposure="1.05"
      loading="lazy"
    />
  );
}

/**
 * Captura a vista atual com o ponto marcado (círculo vermelho e seta), em PNG.
 * O <model-viewer> não desenha os hotspots no toBlob, então o marcador é pintado aqui.
 */
async function snapshotWithMark(mv, mark) {
  // Com a GPU ocupada (ComfyUI gerando) o model-viewer baixa a resolução, e o toBlob
  // nessa escala devolve só um canto da vista. Na captura, fixa 100% e espera o
  // quadro sair inteiro (proporção e tamanho batendo com o elemento).
  const MV = customElements.get('model-viewer');
  const previous = MV.minimumRenderScale;
  MV.minimumRenderScale = 1;
  let blob;
  try {
    const want = mv.clientWidth * window.devicePixelRatio;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 150));
      blob = await mv.toBlob({ mimeType: 'image/png', idealAspect: false });
      const probe = await createImageBitmap(blob);
      if (probe.width >= want * 0.95) break;
    }
  } finally {
    MV.minimumRenderScale = previous ?? 0.5;
  }
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0);
  const hs = mark && mv.queryHotspot('hotspot-fix');
  if (hs?.canvasPosition) {
    const k = img.width / mv.clientWidth;
    const x = hs.canvasPosition.x * k;
    const y = hs.canvasPosition.y * k;
    const r = Math.max(18, img.width * 0.035);
    g.lineWidth = Math.max(4, r / 4);
    g.strokeStyle = '#ff1f1f';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    // seta vindo de cima à esquerda, para o ponto não sumir em modelos vermelhos
    g.beginPath();
    g.moveTo(x - r * 3, y - r * 3);
    g.lineTo(x - r * 0.85, y - r * 0.85);
    g.stroke();
    g.beginPath();
    g.moveTo(x - r * 0.85, y - r * 0.85);
    g.lineTo(x - r * 1.9, y - r * 1.15);
    g.lineTo(x - r * 1.15, y - r * 1.9);
    g.closePath();
    g.fillStyle = '#ff1f1f';
    g.fill();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Visualizador completo: girar, aproximar, apontar um ponto e pedir correção.
 * onFix({ blob, text }) recebe a foto da vista com o ponto e o pedido escrito.
 */
export function ModelViewer({ url, title, onFix, busy }) {
  const ref = useRef(null);
  const [pointing, setPointing] = useState(false);
  const [mark, setMark] = useState(null); // { position, normal } em texto "x y z"
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const mv = ref.current;
    if (!mv) return;
    const onClick = (e) => {
      if (!pointing) return;
      const hit = mv.positionAndNormalFromPoint(e.clientX, e.clientY);
      if (!hit) return;
      setMark({ position: hit.position.toString(), normal: hit.normal.toString() });
    };
    mv.addEventListener('click', onClick);
    return () => mv.removeEventListener('click', onClick);
  }, [pointing]);

  async function send() {
    if (!text.trim() || !mark) return;
    setSending(true);
    setError('');
    try {
      const blob = await snapshotWithMark(ref.current, mark);
      await onFix({ blob, text: text.trim() });
      setPointing(false);
      setMark(null);
      setText('');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`model-viewer-wrap ${pointing ? 'is-pointing' : ''}`}>
      <model-viewer
        ref={ref}
        class="model-full"
        src={url}
        alt={title}
        camera-controls=""
        disable-tap=""
        touch-action="pan-y"
        shadow-intensity="0.8"
        environment-image="neutral"
        exposure="1.05"
        interaction-prompt="none"
      >
        {mark && <button slot="hotspot-fix" className="model-hotspot" data-position={mark.position} data-normal={mark.normal} aria-label="Ponto a corrigir" />}
      </model-viewer>
      {onFix && (
        <div className="model-fix">
          {!pointing ? (
            <>
              <button className="btn" onClick={() => setPointing(true)} disabled={busy}>
                <Icon name="target" size={14} /> Apontar correção
              </button>
              {busy && <span className="model-fix-hint">Espere o agente terminar o que está fazendo para pedir uma correção.</span>}
            </>
          ) : (
            <>
              <span className="model-fix-hint">{mark ? 'Ponto marcado. Clique em outro lugar para mudar.' : 'Clique no ponto do modelo que precisa de correção.'}</span>
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder="O que corrigir aqui? Ex.: arruma o chapéu, ele está torto"
                disabled={!mark || sending}
              />
              <button className="primary" onClick={send} disabled={!mark || !text.trim() || sending}>
                {sending ? 'Enviando…' : 'Pedir correção'}
              </button>
              <button className="btn" onClick={() => { setPointing(false); setMark(null); }} disabled={sending}>
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

/** Menu de exportação: GLB (com textura), STL na altura escolhida (impressão) e OBJ. */
export function ExportMenu({ file, title, rigged }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() => Number(localStorage.getItem('trama.stlHeight')) || 100);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !e.target.closest?.('.export-menu') && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const go = (format) => {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output', format, name: title || '' });
    if (format === 'stl') {
      q.set('height', String(height));
      try {
        localStorage.setItem('trama.stlHeight', String(height));
      } catch {}
    }
    const a = document.createElement('a');
    a.href = `/api/model3d/export?${q}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };
  return (
    <div className="export-menu">
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        <Icon name="download" size={14} /> Exportar
      </button>
      {open && (
        <div className="export-pop">
          <button onClick={() => go('glb')}>
            <b>GLB</b> <span>com textura: Blender, jogos, web</span>
          </button>
          <div className="export-stl">
            <button onClick={() => go('stl')}>
              <b>STL</b> <span>impressão 3D</span>
            </button>
            <label>
              altura
              <input type="number" min="5" max="2000" value={height} onChange={(e) => setHeight(Math.max(5, Math.min(2000, Number(e.target.value) || 100)))} />
              mm
            </label>
          </div>
          <button onClick={() => go('obj')}>
            <b>OBJ</b> <span>só a malha, sem textura</span>
          </button>
          {rigged && (
            <button onClick={() => go('fbx')}>
              <b>FBX</b> <span>com esqueleto: Mixamo, Unity, Unreal</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
