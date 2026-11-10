// App de desktop do Trama: sobe o servidor dentro do próprio processo e abre a interface numa janela.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let win = null;
let tray = null;
let quitting = false; // true só quando o usuário escolhe Sair (no ícone da bandeja)
let trayHintShown = false;

// Um erro solto do servidor (ex.: stream de arquivo interrompido) não deve abrir uma
// janela de erro nem parar o app: vai para %APPDATA%\Trama\trama.log.
const logError = (kind) => (error) => {
  const line = `[${new Date().toISOString()}] ${kind}: ${error?.stack || error}\n`;
  console.error(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'trama.log'), line);
  } catch {}
};
process.on('uncaughtException', logError('uncaughtException'));
process.on('unhandledRejection', logError('unhandledRejection'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Abrir o Trama de novo (atalho, menu Iniciar) mostra a janela que está na bandeja.
  app.on('second-instance', showWindow);
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Fechar a janela só esconde: o Trama continua na bandeja (gerações em andamento
// continuam). Para fechar de verdade: botão direito no ícone → Sair.
function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'public', 'favicon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(path.join(ROOT, 'public', 'favicon.png')).resize({ width: 16, height: 16 }) : icon);
  tray.setToolTip('Trama');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Trama', click: showWindow },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// Usa a 5190 como no modo de desenvolvimento; se estiver ocupada, a próxima livre.
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let port = 5190; port < 5200; port++) if (await portIsFree(port)) return port;
  return 0;
}

async function start() {
  // Configurações, chave do DeepSeek e projetos ficam em %APPDATA%\Trama, fora da pasta de instalação.
  process.env.TRAMA_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.PORT = String(await pickPort());

  let port;
  try {
    const server = await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
    port = await server.ready;
  } catch (error) {
    dialog.showErrorBox('Trama', `Não foi possível iniciar o servidor do Trama.\n\n${error.message}`);
    app.quit();
    return;
  }

  const origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Trama',
    icon: path.join(ROOT, 'public', 'favicon.png'),
    backgroundColor: '#0e0e11',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // Links externos (GitHub, docs do ComfyUI...) abrem no navegador padrão.
  const isExternal = (url) => /^https?:/i.test(url) && !url.startsWith(origin);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: 'O Trama continua aberto',
        content: 'Ele ficou aqui na bandeja. Para fechar, clique com o botão direito no ícone e escolha Sair.',
      });
    }
  });
  win.on('closed', () => (win = null));
  createTray();

  await win.loadURL(origin);
}
