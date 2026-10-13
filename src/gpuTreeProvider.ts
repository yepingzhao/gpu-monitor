import * as vscode from 'vscode';
import { ServerStatus, SshHostConfig, GpuInfo, ProcessInfo } from './types';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

export class ServerItem extends vscode.TreeItem {
  constructor(public status: ServerStatus) {
    super(status.config.host);
    this.id = JSON.stringify(['server', status.config.host]);
    this.update(status);
  }

  update(status: ServerStatus) {
    this.status = status;
    const noChildren = status.kind === 'error'
      || status.kind === 'no-gpu'
      || status.kind === 'needs-auth'
      || status.kind === 'idle';

    this.collapsibleState = noChildren
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Expanded;
    this.command = undefined;

    // contextValue drives right-click menu visibility
    this.contextValue = status.kind === 'needs-auth'
      ? 'server-needs-auth'
      : status.config.usePassword ? 'server-password' : 'server';
    this._applyDecoration();
  }

  private _applyDecoration() {
    const { kind, gpus, error, lastUpdated, config } = this.status;
    const timeStr = lastUpdated
      ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';

    switch (kind) {
      case 'idle':
        this.iconPath = new vscode.ThemeIcon('circle-outline');
        this.description = '';
        this.tooltip = `${config.host} — waiting`;
        break;

      case 'loading':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        this.description = 'connecting…';
        this.tooltip = config.host;
        break;

      case 'error':
        this.iconPath = new vscode.ThemeIcon('error');
        this.description = error ?? 'error';
        this.tooltip = new vscode.MarkdownString(`**${config.host}**\n\n❌ ${error ?? 'Unknown error'}`);
        break;

      case 'needs-auth':
        this.iconPath = new vscode.ThemeIcon('key');
        this.description = 'click to enter password';
        this.tooltip = new vscode.MarkdownString(
          `**${config.host}**\n\nPassword not stored.\nRight-click → *Connect (enter password)*`
        );
        this.command = {
          command: 'gpuMonitor.connectWithPassword',
          title: 'Connect (enter password)',
          arguments: [this],
        };
        break;

      case 'no-gpu':
        this.iconPath = new vscode.ThemeIcon('question');
        this.description = 'no nvidia-smi';
        this.tooltip = `${config.host} — connected but nvidia-smi not found`;
        break;

      case 'online': {
        const maxUtil = gpus.reduce((m, g) => Math.max(m, g.utilizationPct), 0);
        const totalProcs = gpus.reduce((s, g) => s + g.processes.length, 0);
        const color = maxUtil > 80 ? 'charts.red'
          : maxUtil > 15 ? 'charts.yellow'
          : 'charts.green';

        this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(color));
        this.description = `${gpus.length} GPU${gpus.length !== 1 ? 's' : ''}  ${timeStr}`;

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${config.host}**\n\n`);
        for (const g of gpus) {
          const memPct  = Math.round((g.memUsedMiB / g.memTotalMiB) * 100);
          const usedGB  = (g.memUsedMiB  / 1024).toFixed(1);
          const totalGB = (g.memTotalMiB / 1024).toFixed(1);
          md.appendMarkdown(
            `GPU ${g.index} · ${g.name}\n` +
            `- Mem:  **${usedGB} / ${totalGB} GB** (${memPct}%)\n` +
            `- Util: ${g.utilizationPct}%\n` +
            `- Temp: ${g.temperatureC}°C\n` +
            `- Procs: ${g.processes.length}\n\n`
          );
        }
        if (totalProcs === 0) {
          md.appendMarkdown('_No running GPU processes_');
        }
        this.tooltip = md;
        break;
      }
    }
  }
}

export class GpuItem extends vscode.TreeItem {
  constructor(public readonly gpu: GpuInfo, public readonly host: string) {
    super(
      `GPU ${gpu.index}  ${gpu.name}`,
      gpu.processes.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.id = JSON.stringify(['gpu', host, gpu.index]);
    this.contextValue = 'gpu';

    const memPct = gpu.memTotalMiB > 0
      ? Math.round((gpu.memUsedMiB / gpu.memTotalMiB) * 100)
      : 0;

    // MiB → GB, 1 decimal place
    const usedGB  = (gpu.memUsedMiB  / 1024).toFixed(1);
    const totalGB = (gpu.memTotalMiB / 1024).toFixed(1);

    // 8-char visual bar driven by memory usage
    const filled = Math.round(memPct / 100 * 8);
    const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);

    // Memory first and dominant; util + temp as secondary context
    this.description = `${usedGB}/${totalGB} GB [${bar}]  util ${gpu.utilizationPct}%  ${gpu.temperatureC}°C`;

    // Color driven primarily by memory
    const color =
      memPct > 80 ? 'charts.red'
      : memPct > 40 ? 'charts.yellow'
      : 'charts.green';

    this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor(color));

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**GPU ${gpu.index} · ${gpu.name}**\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| **Memory** | **${usedGB} / ${totalGB} GB** (${memPct}%) |\n`);
    md.appendMarkdown(`| Utilization | ${gpu.utilizationPct}% |\n`);
    md.appendMarkdown(`| Temperature | ${gpu.temperatureC}°C |\n`);
    md.appendMarkdown(`| Processes | ${gpu.processes.length} |\n`);
    this.tooltip = md;
  }
}

export class ProcessItem extends vscode.TreeItem {
  constructor(public readonly proc: ProcessInfo, host: string, gpuIndex: number) {
    super(proc.processName, vscode.TreeItemCollapsibleState.None);
    this.id = JSON.stringify(['process', host, gpuIndex, proc.pid]);
    const memGB = (proc.memUsedMiB / 1024).toFixed(1);
    this.contextValue = 'gpu-process';
    this.description = `${memGB} GB  PID ${proc.pid}`;
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.tooltip = new vscode.MarkdownString(
      `**${proc.processName}**\n\n- PID: ${proc.pid}\n- GPU Mem: ${memGB} GB (${proc.memUsedMiB} MiB)`
    );
  }
}

export class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

type AnyItem = ServerItem | GpuItem | ProcessItem | MessageItem;

export class GpuMonitorTreeProvider implements vscode.TreeDataProvider<AnyItem> {
  private readonly _onChange = new vscode.EventEmitter<AnyItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onChange.event;

  // Ordered list of server hosts, so display order is stable
  private _order: string[] = [];
  private _map = new Map<string, ServerItem>();

  // ----- Mutation -----

  setServers(statuses: ServerStatus[]) {
    this._order = statuses.map(s => s.config.host);
    this._map.clear();
    for (const s of statuses) {
      this._map.set(s.config.host, new ServerItem(s));
    }
    this._onChange.fire();
  }

  startRefresh(config: SshHostConfig) {
    // Keep the last successful snapshot visible during background polling.
    if (this._map.get(config.host)?.status.kind === 'online') { return; }
    this.updateServer({ config, kind: 'loading', gpus: [] });
  }

  updateServer(status: ServerStatus) {
    const item = this._map.get(status.config.host);
    if (!item) {
      this._order.push(status.config.host);
      this._map.set(status.config.host, new ServerItem(status));
      this._onChange.fire();
      return;
    }
    item.update(status);
    this._onChange.fire(item);
  }

  // ----- TreeDataProvider -----

  getTreeItem(el: AnyItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: AnyItem): AnyItem[] {
    // Root
    if (!el) {
      if (this._order.length === 0) {
        return [new MessageItem('No SSH hosts found in ~/.ssh/config', 'warning')];
      }
      return this._order
        .map(h => this._map.get(h))
        .filter((s): s is ServerItem => s !== undefined);
    }

    // Server children
    if (el instanceof ServerItem) {
      const { kind, gpus, error } = el.status;
      if (kind === 'loading')    { return [new MessageItem('Connecting…', 'loading~spin')]; }
      if (kind === 'error')      { return [new MessageItem(error ?? 'Connection failed', 'error')]; }
      if (kind === 'no-gpu')     { return [new MessageItem('nvidia-smi not available on this host')]; }
      if (kind === 'needs-auth') { return []; }
      if (kind === 'idle')       { return []; }
      if (gpus.length === 0) { return [new MessageItem('No GPUs reported by nvidia-smi')]; }
      return gpus.map(g => new GpuItem(g, el.status.config.host));
    }

    // GPU children
    if (el instanceof GpuItem) {
      if (el.gpu.processes.length === 0) { return []; }
      return el.gpu.processes.map(p => new ProcessItem(p, el.host, el.gpu.index));
    }

    return [];
  }
}
