// Atualização automática pelas releases do GitHub (lucasnumaboa/trama).
// Ao abrir e a cada 4 horas o app procura uma versão nova; se houver, pergunta se
// pode baixar. Depois de baixada, pergunta se reinicia agora ou instala ao sair.
import { app, dialog, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
const EVERY = 4 * 60 * 60 * 1000;

export function setupUpdater({ getWindow, onState = () => {} }) {
  const logFile = () => path.join(app.getPath('userData'), 'trama.log');
  const log = (level) => (...args) => {
    try {
      fs.appendFileSync(logFile(), `[${new Date().toISOString()}] updater ${level}: ${args.join(' ')}\n`);
    } catch {}
  };
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} };
  autoUpdater.autoDownload = false; // só baixa depois que o usuário aceitar
  autoUpdater.autoInstallOnAppQuit = true; // baixada e adiada: instala quando o app fechar

  let manual = false; // a busca atual foi pedida pelo usuário (mostra "já está atualizado" e erros)
  let busy = false; // baixando ou esperando resposta
  let skipped = null; // versão que o usuário adiou nesta sessão
  let ready = null; // versão já baixada

  const parent = () => {
    const w = getWindow();
    return w && w.isVisible() ? w : undefined;
  };
  const ask = (options) => {
    const w = parent();
    return w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options);
  };
  const notes = (info) => {
    const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note).join('\n') : info.releaseNotes || '';
    const text = String(raw).replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > 900 ? `${text.slice(0, 900)}…` : text;
  };

  autoUpdater.on('update-available', async (info) => {
    const wasManual = manual;
    manual = false;
    if (busy || ready === info.version || (!wasManual && skipped === info.version)) return;
    busy = true;
    onState({ available: info.version });
    // Com a janela na bandeja, avisa também pela notificação do Windows.
    if (!parent() && Notification.isSupported()) {
      new Notification({ title: 'Atualização do Trama', body: `A versão ${info.version} está disponível.` }).show();
    }
    const { response } = await ask({
      type: 'info',
      title: 'Atualização do Trama',
      message: `A versão ${info.version} do Trama está disponível.`,
      detail: `Você está usando a ${app.getVersion()}.${notes(info) ? `\n\nNovidades:\n${notes(info)}` : ''}`,
      buttons: ['Baixar e atualizar', 'Agora não'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) {
      skipped = info.version;
      busy = false;
      onState({});
      return;
    }
    onState({ downloading: info.version, percent: 0 });
    autoUpdater.downloadUpdate().catch(() => {}); // o erro chega pelo evento 'error'
  });

  autoUpdater.on('update-not-available', () => {
    if (!manual) return;
    manual = false;
    ask({ type: 'info', title: 'Trama', message: 'O Trama está atualizado.', detail: `Versão ${app.getVersion()}.`, buttons: ['OK'], noLink: true });
  });

  autoUpdater.on('download-progress', (p) => {
    const w = getWindow();
    w?.setProgressBar(Math.max(0.01, (p.percent || 0) / 100));
    onState({ downloading: true, percent: Math.round(p.percent || 0) });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    getWindow()?.setProgressBar(-1);
    ready = info.version;
    busy = false;
    onState({ ready: info.version });
    const { response } = await ask({
      type: 'info',
      title: 'Atualização do Trama',
      message: `A versão ${info.version} foi baixada.`,
      detail: 'Reiniciar agora instala a atualização e abre o Trama de novo. Gerações em andamento no ComfyUI continuam lá, mas o Trama perde o acompanhamento delas.\n\nSe preferir, ela é instalada quando você fechar o Trama (Sair, na bandeja).',
      buttons: ['Reiniciar agora', 'Ao sair'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    // isSilent: instala sem abrir o assistente; isForceRunAfter: abre o Trama no fim.
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  autoUpdater.on('error', (error) => {
    getWindow()?.setProgressBar(-1);
    const wasManual = manual || busy;
    manual = false;
    busy = false;
    onState({});
    if (!wasManual) return; // busca automática sem internet etc.: só vai para o log
    ask({
      type: 'warning',
      title: 'Atualização do Trama',
      message: 'Não consegui atualizar o Trama.',
      detail: String(error?.message || error).slice(0, 600),
      buttons: ['OK'],
      noLink: true,
    });
  });

  const check = (byUser = false) => {
    if (!app.isPackaged) {
      if (byUser) ask({ type: 'info', title: 'Trama', message: 'A atualização automática só funciona no app instalado.', buttons: ['OK'] });
      return;
    }
    if (ready) {
      // Já baixada: oferece reiniciar de novo.
      if (byUser) autoUpdater.emit('update-downloaded', { version: ready });
      return;
    }
    if (busy) return;
    manual = byUser;
    autoUpdater.checkForUpdates().catch(() => {});
  };

  setTimeout(() => check(false), 15000);
  setInterval(() => check(false), EVERY).unref?.();
  return { check };
}
