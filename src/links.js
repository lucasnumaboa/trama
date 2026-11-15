// Links colados no chat: viram uma tag (como as imagens citadas) com o ícone do site,
// a miniatura e o título do vídeo. No texto enviado ao agente vai o link limpo.
import { api } from './api.js';

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

/** Links que aparecem num texto, na ordem. */
export const findUrls = (text) => String(text || '').match(URL_RE) || [];

/** Divide o texto em pedaços: { text } ou { url }. */
export function splitUrls(text) {
  const out = [];
  let last = 0;
  for (const m of String(text || '').matchAll(URL_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < String(text || '').length) out.push({ text: text.slice(last) });
  return out;
}

/** Id do vídeo do YouTube (watch, youtu.be, shorts, embed, live), ou null. */
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      return m ? m[2] : null;
    }
  } catch {}
  return null;
}

/**
 * Link limpo: no YouTube fica só o vídeo (tira lista automática "RD…", rádio, rastreio)
 * e mantém o tempo (t=) se houver. Nos outros sites, tira parâmetros de rastreio.
 */
export function cleanUrl(url) {
  const id = youtubeId(url);
  if (id) {
    let t = '';
    try {
      const raw = new URL(url).searchParams.get('t');
      if (raw) t = `&t=${encodeURIComponent(raw)}`;
    } catch {}
    return `https://www.youtube.com/watch?v=${id}${t}`;
  }
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igsh|si$)/.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Site, rótulo curto e miniatura imediata (sem esperar a rede). */
export function linkInfo(url) {
  const id = youtubeId(url);
  if (id) return { site: 'youtube', label: 'Vídeo do YouTube', thumb: `https://i.ytimg.com/vi/${id}/default.jpg` };
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  const site = /instagram/.test(host) ? 'instagram' : /tiktok/.test(host) ? 'tiktok' : /vimeo/.test(host) ? 'vimeo' : 'link';
  return { site, label: host, thumb: null };
}

const previews = new Map();
/** Título do link (oEmbed pelo servidor), com cache. Nunca rejeita. */
export function linkPreview(url) {
  if (!previews.has(url)) previews.set(url, api.linkPreview(url).catch(() => ({})));
  return previews.get(url);
}
