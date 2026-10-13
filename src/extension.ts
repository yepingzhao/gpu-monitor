import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { parseSshConfig } from './sshConfigParser';
import { fetchGpuInfo, promptPassword } from './gpuMonitor';
import { GpuMonitorTreeProvider, ServerItem } from './gpuTreeProvider';
import { SettingsPanel } from './settingsPanel';
import { SshHostConfig, ServerStatus } from './types';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const provider = new GpuMonitorTreeProvider();

  const treeView = vscode.window.createTreeView('gpuMonitor', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // ---- State ----
  let servers: SshHostConfig[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeRefresh: Promise<void> | undefined;

  // ---- Helpers ----

  function loadServers(): SshHostConfig[] {
    const cfg = vscode.workspace.getConfiguration('gpuMonitor');
    const included: string[] = cfg.get('servers') ?? [];
    const excluded: string[] = cfg.get('excludedServers') ?? [];

    let all = parseSshConfig();

    if (included.length > 0) {
      all = all.filter(s => included.includes(s.host));
    } else {
      all = all.filter(s => !excluded.includes(s.host));
    }

    return all;
  }

  async function refreshOne(config: SshHostConfig): Promise<void> {
    provider.startRefresh(config);

    let result;
    try {
      result = await fetchGpuInfo(config, context.secrets);
    } catch (e) {
      result = { gpus: [], error: String(e) };
    }

    let kind: ServerStatus['kind'];
    if (result.needsAuth)  { kind = 'needs-auth'; }
    else if (result.error) { kind = 'error'; }
    else if (result.noGpu) { kind = 'no-gpu'; }
    else                   { kind = 'online'; }

    provider.updateServer({
      config,
      kind,
      gpus: result.gpus,
      error: result.error,
      lastUpdated: new Date(),
    });
  }

  async function refreshAll(): Promise<void> {
    if (activeRefresh) { return; }
    activeRefresh = Promise.all(servers.map(s => refreshOne(s))).then(() => {
      activeRefresh = undefined;
    });
    return activeRefresh;
  }

  function resetAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); }
    const intervalMs =
      (vscode.workspace.getConfiguration('gpuMonitor').get<number>('refreshInterval') ?? 30) * 1000;
    refreshTimer = setInterval(() => { refreshAll(); }, intervalMs);
  }

  function reinitialize() {
    servers = loadServers();
    provider.setServers(servers.map(config => ({ config, kind: 'idle', gpus: [] })));
    refreshAll();
    resetAutoRefresh();
  }

  // ---- Watch ~/.ssh/config for changes ----
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  let debounce: ReturnType<typeof setTimeout> | undefined;

  let fsWatcher: fs.FSWatcher | undefined;
  try {
    fsWatcher = fs.watch(sshConfigPath, () => {
      if (debounce) { clearTimeout(debounce); }
      debounce = setTimeout(() => reinitialize(), 600);
    });
  } catch {
    // SSH config doesn't exist yet — no-op
  }

  // ---- Boot ----
  reinitialize();

  // ---- Commands ----
  context.subscriptions.push(
    treeView,

    vscode.commands.registerCommand('gpuMonitor.refresh', () => {
      return refreshAll();
    }),

    vscode.commands.registerCommand('gpuMonitor.refreshServer', (item: ServerItem) => {
      if (item?.status?.config) {
        return refreshOne(item.status.config);
      }
    }),

    // Called when user clicks a needs-auth server row OR via right-click menu
    vscode.commands.registerCommand('gpuMonitor.connectWithPassword', async (item: ServerItem) => {
      if (!item?.status?.config) { return; }
      const ok = await promptPassword(item.status.config, context.secrets);
      if (ok) {
        return refreshOne(item.status.config);
      }
    }),

    vscode.commands.registerCommand('gpuMonitor.clearPassword', async (item: ServerItem) => {
      if (!item?.status?.config) { return; }
      const host = item.status.config.host;
      await context.secrets.delete(`gpu-monitor.pwd.${host}`);
      // Reset server to needs-auth state
      provider.updateServer({ config: item.status.config, kind: 'needs-auth', gpus: [] });
      vscode.window.showInformationMessage(`GPU Monitor: Cleared saved password for "${host}".`);
    }),

    vscode.commands.registerCommand('gpuMonitor.openSettings', () => {
      SettingsPanel.createOrShow();
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gpuMonitor.servers') || e.affectsConfiguration('gpuMonitor.excludedServers')) {
        reinitialize();
      } else if (e.affectsConfiguration('gpuMonitor.refreshInterval')) {
        resetAutoRefresh();
      }
    }),

    {
      dispose: () => {
        if (refreshTimer) { clearInterval(refreshTimer); }
        if (fsWatcher)    { fsWatcher.close(); }
        if (debounce)     { clearTimeout(debounce); }
      }
    }
  );
}

export function deactivate() { /* nothing */ }
