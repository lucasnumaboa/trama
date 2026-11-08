// Peças pequenas reaproveitadas: ícones, texto com formatação simples.
import { Fragment } from 'react';

const PATHS = {
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9.5a1.5 1.5 0 1 0 0-.01',
  video: 'M4 6h12v12H4z M16 10l4-2v8l-4-2',
  audio: 'M9 18V6l10-2v12 M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M19 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  text: 'M6 4h9l3 3v13H6z M9 10h6 M9 14h6 M9 18h4',
  file: 'M6 4h9l3 3v13H6z',
  plus: 'M12 5v14 M5 12h14',
  send: 'M5 12h13 M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M4 12h2 M18 12h2 M12 4v2 M12 18v2 M6.3 6.3l1.4 1.4 M16.3 16.3l1.4 1.4 M6.3 17.7l1.4-1.4 M16.3 7.7l1.4-1.4',
  flow: 'M5 6h4v4H5z M15 14h4v4h-4z M9 8h3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2',
  folder: 'M4 7h6l2 2h8v9H4z',
  upload: 'M12 16V5 M7 10l5-5 5 5 M5 19h14',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  map: 'M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z M9 4v14 M15 6v14',
  trash: 'M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13',
  check: 'M5 12l4 4 10-10',
  alert: 'M12 8v5 M12 16v.01 M10.3 4.5L3 18h18L13.7 4.5a2 2 0 0 0-3.4 0z',
  chat: 'M5 5h14v10H9l-4 4z',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M20 4L8.1 15.9 M14.5 14.5L20 20 M8.1 8.1L12 12',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',
  gallery: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5 M11 8v6 M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5 M8 11h6',
  pointer: 'M5 3l14 8-6 2-2 6z',
};

export function Icon({ name, size = 16, className = '', title }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={!title}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] || PATHS.file} />
    </svg>
  );
}

export const KIND_LABEL = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', text: 'Texto', file: 'Arquivo' };

// Formatação inline: **negrito**, *itálico*, `código`.
function inline(text, keyBase) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown mínimo (títulos, listas, parágrafos), sem HTML bruto. */
export function RichText({ text }) {
  const blocks = [];
  let list = null;
  String(text || '')
    .split('\n')
    .forEach((line, idx) => {
      const bullet = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        const ordered = /\d/.test(bullet[1]);
        if (!list || list.ordered !== ordered) {
          list = { ordered, items: [] };
          blocks.push(list);
        }
        list.items.push(bullet[2]);
        return;
      }
      list = null;
      if (!line.trim()) return blocks.push({ gap: true });
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) return blocks.push({ heading: h[2] });
      blocks.push({ p: line, idx });
    });
  return (
    <div className="rich">
      {blocks.map((b, i) => {
        if (b.items) {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it, `${i}-${j}`)}</li>
              ))}
            </Tag>
          );
        }
        if (b.gap) return <Fragment key={i} />;
        if (b.heading) return <h4 key={i}>{inline(b.heading, i)}</h4>;
        return <p key={i}>{inline(b.p, i)}</p>;
      })}
    </div>
  );
}
