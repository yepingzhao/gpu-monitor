const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');

class EventEmitter {
  listeners = [];
  event = listener => {
    this.listeners.push(listener);
    return { dispose() {} };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class MarkdownString {
  constructor(value = '') { this.value = value; }
  appendMarkdown(value) { this.value += value; }
}

const commands = new Map();
let activeProvider;
const config = { host: 'gpu-a', hostname: 'example.invalid', user: 'tester', port: 22, usePassword: false };
const pending = [];
const disposable = { dispose() {} };
const vscode = {
  EventEmitter, TreeItem, MarkdownString,
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: {
    createTreeView: (_id, options) => { activeProvider = options.treeDataProvider; return disposable; },
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => disposable,
  },
  commands: {
    registerCommand: (id, callback) => { commands.set(id, callback); return disposable; },
  },
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'vscode') return vscode;
  if (name === './sshConfigParser') return { parseSshConfig: () => [config] };
  if (name === './gpuMonitor') return { fetchGpuInfo: () => new Promise(resolve => pending.push(resolve)) };
  return originalLoad.call(this, name, parent, isMain);
};
const { GpuMonitorTreeProvider } = require('../out/gpuTreeProvider.js');
const { activate } = require('../out/extension.js');
Module._load = originalLoad;

function gpu(utilizationPct = 20) {
  return { index: 0, name: 'Test GPU', utilizationPct, memUsedMiB: 1024,
    memTotalMiB: 8192, temperatureC: 40,
    processes: [{ pid: 42, processName: 'python', memUsedMiB: 1024 }] };
}
function status(host = 'gpu-a', utilizationPct = 20) {
  return { config: { ...config, host }, kind: 'online', gpus: [gpu(utilizationPct)], lastUpdated: new Date() };
}

test('updating one server retains root identity and refreshes only that subtree', () => {
  const provider = new GpuMonitorTreeProvider();
  provider.setServers([status(), status('gpu-b')]);
  const [server, other] = provider.getChildren();
  const events = [];
  provider.onDidChangeTreeData(value => events.push(value));
  provider.updateServer(status('gpu-a', 90));
  assert.strictEqual(provider.getChildren()[0], server);
  assert.strictEqual(provider.getChildren()[1], other);
  assert.deepEqual(events, [server]);
  assert.equal(provider.getChildren(server)[0].gpu.utilizationPct, 90);
  assert.equal(server.iconPath.color.id, 'charts.red');
});

test('server, GPU and process IDs stay stable and remain unique across hosts', () => {
  const provider = new GpuMonitorTreeProvider();
  provider.setServers([status(), status('gpu-b')]);
  const [server, other] = provider.getChildren();
  const card = provider.getChildren(server)[0];
  const proc = provider.getChildren(card)[0];
  const ids = [server.id, card.id, proc.id];
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(ids).size, 3);
  const otherCard = provider.getChildren(other)[0];
  assert.notEqual(card.id, otherCard.id);
  assert.notEqual(proc.id, provider.getChildren(otherCard)[0].id);
  provider.updateServer(status('gpu-a', 70));
  const nextCard = provider.getChildren(server)[0];
  assert.deepEqual([server.id, nextCard.id, provider.getChildren(nextCard)[0].id], ids);
});

test('a server added to the list triggers a root refresh', () => {
  const provider = new GpuMonitorTreeProvider();
  provider.setServers([status()]);
  const events = [];
  provider.onDidChangeTreeData(value => events.push(value));
  provider.updateServer(status('gpu-b'));
  assert.deepEqual(events, [undefined]);
  assert.equal(provider.getChildren().length, 2);
});

test('refresh keeps existing GPUs visible until the pending query completes', async () => {
  const originalWatch = fs.watch;
  fs.watch = () => ({ close() {} });
  const context = { subscriptions: [], secrets: {} };
  try {
    activate(context);
    assert.equal(pending.length, 1);
    pending.shift()({ gpus: [gpu()] });
    await new Promise(resolve => setImmediate(resolve));
    const server = activeProvider.getChildren()[0];
    const events = [];
    activeProvider.onDidChangeTreeData(value => events.push(value));
    const refresh = commands.get('gpuMonitor.refresh')();
    assert.equal(pending.length, 1);
    assert.equal(activeProvider.getChildren()[0].status.kind, 'online');
    assert.equal(activeProvider.getChildren(server)[0].gpu.utilizationPct, 20);
    assert.deepEqual(events, []);
    pending.shift()({ gpus: [gpu(75)] });
    await refresh;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(activeProvider.getChildren()[0], server);
    assert.equal(activeProvider.getChildren(server)[0].gpu.utilizationPct, 75);
    assert.deepEqual(events, [server]);
  } finally {
    fs.watch = originalWatch;
    for (const item of context.subscriptions) item.dispose();
  }
});
