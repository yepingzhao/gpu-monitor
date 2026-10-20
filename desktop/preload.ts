import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('monitor', {
  getState: () => ipcRenderer.invoke('monitor:state'),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  refreshServer: (host: string) => ipcRenderer.invoke('monitor:refresh-server', host),
  serverMenu: (host: string) => ipcRenderer.invoke('monitor:server-menu', host),
  hide: () => ipcRenderer.invoke('monitor:hide'),
  hideTray: () => ipcRenderer.invoke('monitor:hide-tray'),
  showMain: (section?: 'settings') => ipcRenderer.invoke('monitor:show-main', section),
  openConfig: () => ipcRenderer.invoke('monitor:open-config'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('monitor:settings', settings),
  savePassword: (host: string, password: string) => ipcRenderer.invoke('monitor:password', host, password),
  clearPassword: (host: string) => ipcRenderer.invoke('monitor:clear-password', host),
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('monitor:open-settings', listener);
    return () => ipcRenderer.removeListener('monitor:open-settings', listener);
  },
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('monitor:state', listener);
    return () => ipcRenderer.removeListener('monitor:state', listener);
  },
});
