const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isla', {
  init: () => ipcRenderer.invoke('app:init'),
  command: (cmd) => ipcRenderer.send('media:command', cmd),
  setInteractive: (on) => ipcRenderer.send('window:interactive', !!on),
  onState: (fn) => ipcRenderer.on('media:state', (_e, s) => fn(s)),
  onArt: (fn) => ipcRenderer.on('media:art', (_e, a) => fn(a)),
  onMode: (fn) => ipcRenderer.on('app:mode', (_e, m) => fn(m)),
  onSkin: (fn) => ipcRenderer.on('app:skin', (_e, s) => fn(s)),
  onScale: (fn) => ipcRenderer.on('app:scale', (_e, k) => fn(k))
});
