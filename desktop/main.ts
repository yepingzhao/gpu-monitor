import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, safeStorage, screen } from 'electron';
import { promises as fs, watchFile, unwatchFile } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { fetchGpuInfo, SecretStore } from '../src/gpuClient';
import { parseSshConfig } from '../src/sshConfigParser';
import { ServerStatus, SshHostConfig } from '../src/types';
import { trayWindowBounds } from './trayPlacement';

interface Settings {
  refreshInterval: number;
  connectionTimeout: number;
  servers: string[];
  excludedServers: string[];
}

const defaults: Settings = { refreshInterval: 30, connectionTimeout: 8, servers: [], excludedServers: [] };
let settings = defaults;
let statuses: ServerStatus[] = [];
let hosts: SshHostConfig[] = [];
let error: string | undefined;
let mainWindow: BrowserWindow;
let trayWindow: BrowserWindow;
let tray: Tray;
let quitting = false;
let timer: ReturnType<typeof setInterval>;
let activeRefresh: Promise<void> | undefined;
let configPath: string;
let settingsPath: string;
const uiPath = path.join(__dirname, '../../ui/index.html');
const trayUiPath = path.join(__dirname, '../../ui/tray.html');
const iconPath = path.join(__dirname, '../../assets/icon.png');
app.setName('gpu-monitor-desktop');

async function readFile(file: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    throw e;
  }
}

function validateSettings(value: unknown): Settings {
  const s = value as Settings;
  if (!s || !Number.isInteger(s.refreshInterval) || s.refreshInterval < 5 || s.refreshInterval > 86400
    || !Number.isInteger(s.connectionTimeout) || s.connectionTimeout < 3 || s.connectionTimeout > 300
    || ![s.servers, s.excludedServers].every(list => Array.isArray(list)
      && list.every(host => typeof host === 'string' && host.length > 0))) {
    throw new Error('刷新间隔需为 5–86400 秒，连接超时需为 3–300 秒，服务器列表需为 SSH 别名。');
  }
  return { refreshInterval: s.refreshInterval, connectionTimeout: s.connectionTimeout,
    servers: s.servers, excludedServers: s.excludedServers };
}

function secretPath(key: string): string {
  return path.join(app.getPath('userData'), 'secrets', createHash('sha256').update(key).digest('hex'));
}

const secrets: SecretStore = {
  async get(key) {
    const encrypted = await readFile(secretPath(key));
    if (!encrypted) { return undefined; }
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    return result;
  },
  async delete(key) { await fs.rm(secretPath(key), { force: true }); },
};

function snapshot() {
  return { settings, statuses, hosts, error, configPath, refreshing: !!activeRefresh };
}

function publish() {
  if (quitting) { return; }
  for (const target of [mainWindow, trayWindow]) {
    if (!target.isDestroyed()) { target.webContents.send('monitor:state', snapshot()); }
  }
  const online = statuses.filter(s => s.kind === 'online');
  tray.setToolTip(`GPU Monitor · ${online.length}/${statuses.length} 台在线 · ${online.reduce((n, s) => n + s.gpus.length, 0)} GPU`);
}

async function refreshOne(status: ServerStatus) {
  status.kind = 'loading';
  publish();
  try {
    const result = await fetchGpuInfo(status.config, secrets, settings.connectionTimeout);
    status.gpus = result.gpus;
    status.error = result.error;
    status.kind = result.needsAuth ? 'needs-auth' : result.error ? 'error'
      : result.noGpu || result.gpus.length === 0 ? 'no-gpu' : 'online';
  } catch (e) {
    status.kind = 'error';
    status.error = String(e);
  }
  status.lastUpdated = new Date();
  publish();
}

async function refresh() {
  try {
    hosts = parseSshConfig(configPath);
    const previous = new Map(statuses.map(s => [s.config.host, s]));
    statuses = hosts.filter(c => settings.servers.length
      ? settings.servers.includes(c.host) : !settings.excludedServers.includes(c.host))
      .map(config => ({ ...previous.get(config.host), config, kind: 'loading',
        gpus: previous.get(config.host)?.gpus ?? [] }));
    error = undefined;
    await Promise.all(statuses.map(refreshOne));
  } catch (e) { error = `无法读取 SSH 配置：${String(e)}`; }
}

async function refreshServer(host: unknown) {
  while (activeRefresh) { await activeRefresh; }
  const status = statuses.find(s => s.config.host === host);
  if (!status) { throw new Error('未知服务器。'); }
  activeRefresh = Promise.resolve().then(() => refreshOne(status))
    .finally(() => { activeRefresh = undefined; publish(); });
  return activeRefresh;
}

function refreshAll(): Promise<void> {
  if (!activeRefresh) {
    activeRefresh = Promise.resolve().then(refresh).finally(() => {
      activeRefresh = undefined;
      publish();
    });
  }
  return activeRefresh;
}

function resetTimer() {
  clearInterval(timer);
  timer = setInterval(() => { void refreshAll(); }, settings.refreshInterval * 1000);
}

function showMainWindow() {
  trayWindow.hide();
  if (mainWindow.isMinimized()) { mainWindow.restore(); }
  mainWindow.show();
  mainWindow.focus();
}

function showTrayWindow() {
  let anchor = tray.getBounds();
  if (!anchor.width || !anchor.height) {
    anchor = { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
  }
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
  trayWindow.setBounds(trayWindowBounds(anchor, area));
  trayWindow.show();
  trayWindow.focus();
}

function registerIpc() {
  const handle = (name: string, callback: (...args: any[]) => unknown, allowTray = false) => {
    ipcMain.handle(`monitor:${name}`, (event, ...args) => {
      const owner = event.sender === mainWindow.webContents ? mainWindow
        : allowTray && event.sender === trayWindow.webContents ? trayWindow : undefined;
      const expectedPath = owner === trayWindow ? trayUiPath : uiPath;
      if (!owner || event.senderFrame !== owner.webContents.mainFrame
        || event.senderFrame.url !== pathToFileURL(expectedPath).href) {
        throw new Error('Untrusted IPC sender');
      }
      return callback(...args);
    });
  };
  handle('state', snapshot, true);
  handle('refresh', refreshAll, true);
  handle('hide-tray', () => trayWindow.hide(), true);
  handle('show-main', (section: unknown) => {
    if (section !== undefined && section !== 'settings') { throw new Error('未知主窗口入口。'); }
    showMainWindow();
    if (section === 'settings') { mainWindow.webContents.send('monitor:open-settings'); }
  }, true);
  handle('refresh-server', refreshServer);
  handle('server-menu', (host: unknown) => {
    const status = statuses.find(s => s.config.host === host);
    if (!status) { throw new Error('未知服务器。'); }
    return new Promise<string | undefined>(resolve => {
      const items: Electron.MenuItemConstructorOptions[] = [
        { label: '刷新此服务器', click: () => resolve('refresh') },
      ];
      if (status.config.usePassword) {
        items.push({ label: '连接 / 设置密码', click: () => resolve('password') },
          { label: '清除已保存密码', click: () => resolve('clear-password') });
      }
      Menu.buildFromTemplate(items).popup({ window: mainWindow, callback: () => resolve(undefined) });
    });
  });
  handle('hide', () => mainWindow.hide());
  handle('open-config', async () => {
    const result = await shell.openPath(configPath);
    if (result) { throw new Error(result); }
  });
  handle('settings', async (value: unknown) => {
    const next = validateSettings(value);
    await fs.writeFile(settingsPath, JSON.stringify(next, null, 2));
    await activeRefresh;
    settings = next;
    resetTimer();
    await refreshAll();
  });
  handle('password', async (host: unknown, password: unknown) => {
    const status = statuses.find(s => s.config.host === host && s.config.usePassword);
    if (!status || typeof password !== 'string' || password.length === 0) {
      throw new Error('请选择密码认证服务器并输入密码。');
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Windows 密码加密不可用，无法保存密码。');
    }
    await activeRefresh;
    const file = secretPath(`gpu-monitor.pwd.${host}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await safeStorage.encryptStringAsync(password));
    await refreshServer(host);
  });
  handle('clear-password', async (host: unknown) => {
    if (typeof host !== 'string' || !statuses.some(s => s.config.host === host)) {
      throw new Error('未知服务器。');
    }
    await activeRefresh;
    await secrets.delete(`gpu-monitor.pwd.${host}`);
    await refreshServer(host);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { showMainWindow(); } });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(timer);
    if (configPath) { unwatchFile(configPath); }
  });
  // Windows shutdown must close normally instead of returning to the tray.
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.yepingzhao.gpu-monitor');
    configPath = path.join(app.getPath('home'), '.ssh', 'config');
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const stored = await readFile(settingsPath);
    if (stored) { settings = validateSettings(JSON.parse(stored.toString('utf8'))); }
    mainWindow = new BrowserWindow({
      width: 1080, height: 760, minWidth: 580, minHeight: 420, show: false,
      title: 'GPU Monitor', backgroundColor: '#11161b', icon: iconPath,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    trayWindow = new BrowserWindow({
      width: 440, height: 520, show: false, frame: false,
      resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true, title: 'GPU Monitor — 快速查看',
      backgroundColor: '#181818', icon: iconPath,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    for (const target of [mainWindow, trayWindow]) {
      target.removeMenu();
      target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      target.webContents.on('will-navigate', event => event.preventDefault());
      target.on('query-session-end', () => { quitting = true; });
    }
    trayWindow.on('blur', () => trayWindow.hide());
    trayWindow.on('close', event => {
      if (!quitting) { event.preventDefault(); trayWindow.hide(); }
    });
    mainWindow.on('minimize', () => mainWindow.hide());
    mainWindow.on('close', event => {
      if (!quitting) { event.preventDefault(); mainWindow.hide(); }
    });
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) { throw new Error('Tray icon could not be loaded'); }
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主窗口', click: showMainWindow },
      { label: '立即刷新', click: () => { void refreshAll(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('click', showTrayWindow);
    tray.on('double-click', showMainWindow);
    registerIpc();
    await Promise.all([mainWindow.loadFile(uiPath), trayWindow.loadFile(trayUiPath)]);
    if (!process.argv.includes('--hidden')) { showMainWindow(); }
    watchFile(configPath, { interval: 2000 }, () => { void refreshAll(); });
    resetTimer();
    await refreshAll();
  }).catch(e => {
    dialog.showErrorBox('GPU Monitor 启动失败', String(e));
    app.quit();
  });
}
