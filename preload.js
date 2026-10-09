'use strict';
// Exposes a small, fixed set of desktop features to the page (window.presenterDesktop).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenterDesktop', {
  getTailscaleStatus: () => ipcRenderer.invoke('presenter:tailscaleStatus'),
  getVersion: () => ipcRenderer.invoke('presenter:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('presenter:checkForUpdates'),
  onUpdateStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('presenter:updateStatus', h); return () => ipcRenderer.removeListener('presenter:updateStatus', h); },
  setBgMode: (mode) => ipcRenderer.invoke('presenter:setBgMode', mode),
  ai: {
    keyStatus: () => ipcRenderer.invoke('presenter:ai:keyStatus'),
    setKey: (key) => ipcRenderer.invoke('presenter:ai:setKey', key),
    setConfig: (patch) => ipcRenderer.invoke('presenter:ai:setConfig', patch),
    identify: (audio, ctx) => ipcRenderer.invoke('presenter:ai:identify', audio, ctx),
    lyrics: (query, ctx) => ipcRenderer.invoke('presenter:ai:lyrics', query, ctx),
    detect: (wavBase64, ctx) => ipcRenderer.invoke('presenter:ai:detect', wavBase64, ctx)
  }
});
