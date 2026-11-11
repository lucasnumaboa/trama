// Volume dos vídeos, igual para todos os cards e lembrado entre sessões.
const KEY = 'trama.volume';

export function getVolume() {
  try {
    const v = parseFloat(localStorage.getItem(KEY));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  } catch {
    return 0.7;
  }
}

export function saveVolume(v) {
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}
