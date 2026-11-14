const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const Store = require('electron-store');
const fs = require('fs');

// Registro para diagnosticar problemas: %APPDATA%\\Isla\\isla.log
let logPath = null;
function log(...parts) {
  try {
    if (!logPath) logPath = path.join(app.getPath('userData'), 'isla.log');
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
    fs.appendFileSync(logPath, line);
  } catch (e) { /* noop */ }
}

process.on('uncaughtException', (err) => {
  try { dialog.showErrorBox('Isla - Error inesperado', String((err && err.stack) || err)); } catch (e) { /* noop */ }
  app.exit(1);
});

if (!app.requestSingleInstanceLock()) { app.quit(); }

const store = new Store({ defaults: { mode: 'island', skin: 'obsidiana' } });
const DONATE_URL = 'https://ko-fi.com/'; // [PON AQUÍ TU ENLACE DE DONACIONES]

// La ventana NUNCA cambia de tamaño ni se mueve: es un lienzo transparente
// fijo y toda la animación ocurre dentro, en CSS (a 60 fps reales). Las zonas
// transparentes dejan pasar el ratón a lo que haya debajo.
const LAYOUT = {
  island: { width: 460, height: 250 },
  bubble: { width: 470, height: 120 }
};

let win = null;
let tray = null;
let media = null;
let lastState = { active: false };
let lastArt = null;

function windowBounds(mode) {
  const d = screen.getPrimaryDisplay();
  const { width, height } = LAYOUT[mode];
  if (mode === 'bubble') {
    const wa = d.workArea;
    return { x: wa.x + wa.width - width - 12, y: wa.y + wa.height - height - 12, width, height };
  }
  // Isla: pegada al borde superior de la pantalla, centrada.
  return { x: Math.round(d.bounds.x + (d.bounds.width - width) / 2), y: d.bounds.y, width, height };
}

function createWindow() {
  const mode = store.get('mode');
  win = new BrowserWindow({
    ...windowBounds(mode),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('console-message', (_e, level, message, line) => { if (level >= 2) log('Ventana:', message, 'línea', line); });
  win.webContents.on('render-process-gone', (_e, d) => log('Ventana caída:', d.reason));
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());

  // Algunos juegos a pantalla completa le quitan el "siempre encima".
  const keepOnTop = setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 2000);
  win.on('closed', () => { clearInterval(keepOnTop); win = null; });

  screen.on('display-metrics-changed', placeWindow);
}

function placeWindow() {
  if (win && !win.isDestroyed()) win.setBounds(windowBounds(store.get('mode')));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- Puente con los controles multimedia de Windows ----
function startMedia() {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'media.ps1')
    : path.join(__dirname, 'media.ps1');
  media = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true
  });
  log('Arrancando helper:', script, 'existe:', fs.existsSync(script));
  media.on('error', (e) => log('No se pudo lanzar PowerShell:', e.message));
  readline.createInterface({ input: media.stderr }).on('line', (l) => log('PS', l));
  let firstLine = true;
  const rl = readline.createInterface({ input: media.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('Línea no JSON:', line.slice(0, 200)); return; }
    if (firstLine || msg.type !== 'art' && msg.title !== lastState.title) {
      firstLine = false;
      log('Estado:', msg.type === 'art' ? 'portada' : JSON.stringify({ ...msg, art: undefined }));
    }
    if (msg.type === 'art') {
      lastArt = msg;
      send('media:art', msg);
    } else {
      lastState = msg;
      send('media:state', msg);
    }
  });
  media.on('exit', (code) => {
    log('Helper terminado, código', code);
    media = null;
    if (!app.isQuitting) setTimeout(startMedia, 2000); // se reinicia solo si se cae
  });
}

function mediaCommand(cmd) {
  if (media && media.stdin.writable) media.stdin.write(cmd + '\n');
}

ipcMain.on('media:command', (_e, cmd) => {
  if (typeof cmd === 'string' && /^(toggle|next|prev|seek \d+)$/.test(cmd)) mediaCommand(cmd);
});
ipcMain.handle('app:init', () => ({ mode: store.get('mode'), skin: store.get('skin'), state: lastState, art: lastArt }));
ipcMain.on('window:interactive', (_e, on) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
});

// Visualizador con audio real del sistema (loopback de Windows).
function setupSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}));
  });
}

// ---- Bandeja del sistema: todos los ajustes viven aquí ----
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

function setMode(mode) {
  store.set('mode', mode);
  placeWindow();
  send('app:mode', mode);
  buildTray();
}

function setSkin(skin) {
  store.set('skin', skin);
  send('app:skin', skin);
  buildTray();
}

function buildTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Isla');
  }
  const mode = store.get('mode');
  const skin = store.get('skin');
  const autoStart = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Isla', enabled: false },
    { type: 'separator' },
    { label: 'Isla (arriba)', type: 'radio', checked: mode === 'island', click: () => setMode('island') },
    { label: 'Burbuja (esquina)', type: 'radio', checked: mode === 'bubble', click: () => setMode('bubble') },
    { type: 'separator' },
    { label: 'Skin', submenu: [
      { label: 'Obsidiana', type: 'radio', checked: skin === 'obsidiana', click: () => setSkin('obsidiana') },
      { label: 'Aero', type: 'radio', checked: skin === 'aero', click: () => setSkin('aero') }
    ] },
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: autoStart, enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: '♥ Apoyar el proyecto', click: () => shell.openExternal(DONATE_URL) },
    { label: 'Ver registro (diagnóstico)', click: () => { log('Registro abierto'); shell.openPath(logPath || path.join(app.getPath('userData'), 'isla.log')); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(() => {
  log('Isla', app.getVersion(), 'arrancando. Empaquetada:', app.isPackaged);
  if (app.isPackaged && store.get('firstRun') !== false) {
    app.setLoginItemSettings({ openAtLogin: true });
    store.set('firstRun', false);
  }
  setupSystemAudioCapture();
  createWindow();
  buildTray();
  startMedia();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (media) { try { media.kill(); } catch (e) { /* noop */ } }
});
app.on('window-all-closed', () => app.quit());
