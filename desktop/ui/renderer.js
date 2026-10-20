'use strict';
const $ = id => document.getElementById(id);
const api = window.monitor;
const collapsedServers = new Set();
const expandedGpus = new Set();
const labels = { idle: '等待刷新', loading: '刷新中…', online: '在线', 'no-gpu': '无 nvidia-smi', 'needs-auth': '点击输入密码', error: '连接失败' };
const paths = {
  refresh: 'M13 4A6 6 0 1 0 14 10M13 1v4H9',
  settings: 'M6 1h4l.5 2 2 .8L14 3l2 3-1.5 1.5v2L16 11l-2 3-1.5-.8-2 .8L10 16H6l-.5-2-2-.8L2 14l-2-3 1.5-1.5v-2L0 6l2-3 1.5.8 2-.8L6 1M11 8.5a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  collapse: 'M2 5h9v9H2zM5 2h9v9M4 9h5',
  tray: 'M2 10v4h12v-4M8 1v9M4 6l4 4 4-4',
  database: 'M13 4c0 1.7-10 1.7-10 0s10-1.7 10 0v9c0 1.7-10 1.7-10 0V4M3 8c0 1.7 10 1.7 10 0',
  key: 'M10 9a4 4 0 1 0-3-3M7 6l-6 7v2h3v-2h2v-2h2l2-2',
  terminal: 'M2 3h12v11H2zM4 6l2 2-2 2M8 11h3',
  more: 'M3 8h.1M8 8h.1M13 8h.1',
};
let state;
let passwordHost;
let settingsHosts = [];

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) { element.textContent = text; }
  if (className) { element.className = className; }
  return element;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-1 -1 18 18'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name]); svg.append(path); return svg;
}
async function action(callback, errorId = 'error') {
  const target = $(errorId); target.textContent = ''; target.hidden = true;
  try { await callback(); }
  catch (e) { target.textContent = e.message || String(e); target.hidden = false; }
}
function iconButton(name, label, key, callback) {
  const button = node('button', undefined, 'icon-button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.dataset.key = key; button.append(icon(name));
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); action(callback); };
  return button;
}
function memoryColor(pct) { return pct > 80 ? 'high' : pct > 40 ? 'medium' : 'low'; }
function toggleState(details, set, key, invert = false) {
  details.addEventListener('click', event => {
    const summary = event.target.closest('summary');
    if (event.defaultPrevented || summary?.parentElement !== details || event.target.closest('button')) { return; }
    event.preventDefault();
    details.open = !details.open;
    if (invert ? !details.open : details.open) { set.add(key); } else { set.delete(key); }
  });
}
function openPassword(host) {
  passwordHost = host;
  $('password-host').textContent = host;
  $('password-form').reset(); $('password-error').textContent = '';
  if (!$('password-dialog').open) { $('password-dialog').showModal(); }
  $('password').focus();
}
async function serverMenu(host) {
  const command = await api.serverMenu(host);
  if (command === 'refresh') { await api.refreshServer(host); }
  if (command === 'password') { openPassword(host); }
  if (command === 'clear-password') { await api.clearPassword(host); }
}

function gpuRow(host, gpu) {
  const hasProcesses = gpu.processes.length > 0;
  const group = node(hasProcesses ? 'details' : 'div', undefined, 'gpu');
  const key = JSON.stringify([host, gpu.index]);
  if (hasProcesses) { group.open = expandedGpus.has(key); toggleState(group, expandedGpus, key); }
  const row = node(hasProcesses ? 'summary' : 'div', undefined, 'gpu-row tree-row');
  if (!hasProcesses) { row.tabIndex = -1; }
  row.dataset.key = key;
  row.append(node('span', hasProcesses ? '›' : '', 'chevron'));
  const pct = gpu.memTotalMiB ? Math.round(gpu.memUsedMiB / gpu.memTotalMiB * 100) : 0;
  const color = memoryColor(pct);
  const gpuIcon = node('span', undefined, `gpu-icon ${color}`); gpuIcon.append(icon('database'));
  row.append(gpuIcon, node('span', `GPU ${gpu.index}  ${gpu.name}`, 'gpu-name'));
  const metrics = node('span', undefined, 'gpu-metrics');
  const used = (gpu.memUsedMiB / 1024).toFixed(1), total = (gpu.memTotalMiB / 1024).toFixed(1);
  const memory = node('strong', `${used}/${total} GiB`, 'memory');
  const filled = Math.max(0, Math.min(8, Math.round(pct / 100 * 8)));
  const bar = node('span', undefined, `memory-bar ${color}`);
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `显存使用率 ${pct}%`);
  for (let index = 0; index < 8; index++) {
    const segment = node('span', undefined, index < filled ? 'filled' : undefined);
    segment.setAttribute('aria-hidden', 'true');
    bar.append(segment);
  }
  metrics.append(memory, bar, node('span', `util ${gpu.utilizationPct}%`, 'util'), node('span', `${gpu.temperatureC}°C`, 'temperature'));
  row.append(metrics);
  row.title = `GPU ${gpu.index} · ${gpu.name}\n显存 ${used} / ${total} GiB (${pct}%)\n利用率 ${gpu.utilizationPct}% · 温度 ${gpu.temperatureC}°C\n${gpu.processes.length} 个 GPU 进程`;
  group.append(row);
  if (hasProcesses) {
    const processes = node('ul', undefined, 'processes');
    gpu.processes.forEach(proc => {
      const item = node('li', undefined, 'process-row tree-row');
      item.tabIndex = -1;
      item.dataset.key = JSON.stringify([host, gpu.index, proc.pid]);
      item.append(icon('terminal'), node('span', proc.processName, 'process-name'),
        node('span', `${(proc.memUsedMiB / 1024).toFixed(1)} GiB`, 'process-memory'), node('span', `PID ${proc.pid}`, 'pid'));
      item.title = `${proc.processName}\nPID ${proc.pid}\n显存 ${proc.memUsedMiB} MiB`;
      processes.append(item);
    });
    group.append(processes);
  }
  return group;
}

function serverRow(server) {
  const host = server.config.host;
  const group = node('details', undefined, 'server');
  group.open = !collapsedServers.has(host);
  toggleState(group, collapsedServers, host, true);
  const row = node('summary', undefined, 'server-row tree-row');
  row.dataset.key = `server:${host}`;
  row.append(node('span', ['online', 'loading'].includes(server.kind) ? '›' : '', 'chevron'));
  const maxUtil = Math.max(0, ...server.gpus.map(g => g.utilizationPct));
  const color = server.kind === 'online' ? (maxUtil > 80 ? 'high' : maxUtil > 15 ? 'medium' : 'low') : '';
  const status = node('span', server.kind === 'error' ? '×' : server.kind === 'needs-auth' ? '⌑' : server.kind === 'loading' ? '↻' : '●', `status ${server.kind} ${color}`);
  status.title = labels[server.kind]; status.setAttribute('aria-label', labels[server.kind]);
  row.append(status, node('span', host, 'server-name'));
  let description = server.error && server.kind === 'error' ? server.error : labels[server.kind];
  if (server.kind === 'online') {
    description = `${server.gpus.length} GPU · ${new Date(server.lastUpdated).toLocaleTimeString()}`;
  }
  row.append(node('span', description, `description ${server.kind}`));
  const controls = node('span', undefined, 'row-actions');
  const refresh = iconButton('refresh', `刷新 ${host}`, `refresh:${host}`, () => api.refreshServer(host));
  refresh.disabled = server.kind === 'loading'; controls.append(refresh);
  if (server.kind === 'needs-auth') { controls.append(iconButton('key', `连接 ${host}（输入密码）`, `password:${host}`, () => openPassword(host))); }
  controls.append(iconButton('more', `${host} 的更多操作`, `menu:${host}`, () => serverMenu(host)));
  row.append(controls);
  row.title = `${host}\n${server.config.user}@${server.config.hostname}:${server.config.port}${server.config.proxyJump ? `\nProxyJump: ${server.config.proxyJump}` : ''}\n${description}\n右键打开服务器操作`;
  row.oncontextmenu = event => { event.preventDefault(); action(() => serverMenu(host)); };
  row.addEventListener('click', event => {
    if (server.kind === 'needs-auth' && !event.target.closest('button')) { event.preventDefault(); openPassword(host); }
  });
  group.append(row);
  if (server.gpus.length && ['online', 'loading'].includes(server.kind)) {
    server.gpus.forEach(gpu => group.append(gpuRow(host, gpu)));
  } else if (server.kind === 'loading') { group.append(node('p', '正在连接…', 'message')); }
  return group;
}

function render() {
  if (!state) { return; }
  const { statuses, settings } = state;
  $('refresh').disabled = state.refreshing;
  $('refresh').classList.toggle('refreshing', state.refreshing);
  const online = statuses.filter(s => s.kind === 'online');
  $('overview').textContent = `${online.length}/${statuses.length} 台在线 · ${online.reduce((n, s) => n + s.gpus.length, 0)} GPU`;
  $('interval').textContent = `每 ${settings.refreshInterval} 秒刷新`;
  $('error').textContent = state.error || ''; $('error').hidden = !state.error;
  const focusKey = document.activeElement?.dataset.key;
  const scrollTop = $('servers').scrollTop;
  const list = $('servers'); list.replaceChildren();
  const query = $('search').value.toLowerCase();
  const filtered = statuses.filter(s => `${s.config.host} ${s.config.hostname}`.toLowerCase().includes(query));
  if (!filtered.length) {
    list.append(node('p', statuses.length ? '没有匹配的服务器。' : '未启用任何服务器。请在设置中勾选服务器，或在 SSH 配置中添加 Host 和 HostName。', 'empty'));
  }
  filtered.forEach(server => list.append(serverRow(server)));
  list.scrollTop = scrollTop;
  if (focusKey) { [...list.querySelectorAll('[data-key]')].find(el => el.dataset.key === focusKey)?.focus({ preventScroll: true }); }
}

function openSettings() {
  if (!state) { return; }
  const form = $('settings-form');
  form.elements.refreshInterval.value = state.settings.refreshInterval;
  form.elements.connectionTimeout.value = state.settings.connectionTimeout;
  $('refresh-value').value = form.elements.refreshInterval.value;
  $('config-path').textContent = state.configPath;
  $('settings-error').textContent = '';
  settingsHosts = state.hosts;
  $('settings-servers').replaceChildren();
  settingsHosts.forEach(config => {
    const row = node('label', undefined, 'settings-server');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.host = config.host;
    checkbox.checked = state.settings.servers.length ? state.settings.servers.includes(config.host) : !state.settings.excludedServers.includes(config.host);
    checkbox.setAttribute('aria-label', `监控 ${config.host}`);
    row.append(checkbox, node('span', config.host, 'settings-host'), node('span', `${config.hostname}${config.port !== 22 ? `:${config.port}` : ''}${config.proxyJump ? ` → ${config.proxyJump}` : ''}`, 'settings-address'),
      node('span', config.usePassword ? '密码' : '密钥', 'auth'));
    $('settings-servers').append(row);
  });
  if (!settingsHosts.length) { $('settings-servers').append(node('p', 'SSH 配置中尚未发现服务器。', 'empty')); }
  $('settings-dialog').showModal();
}

const toolbar = [
  ['refresh', '刷新全部', 'refresh', () => api.refresh()],
  ['collapse', '全部折叠', 'collapse-all', () => { state.statuses.forEach(s => collapsedServers.add(s.config.host)); expandedGpus.clear(); render(); }],
  ['settings', '设置', 'settings-open', openSettings],
  ['tray', '收起到托盘', 'hide', () => api.hide()],
];
for (const [name, label, id, callback] of toolbar) {
  const button = iconButton(name, label, id, callback); button.id = id; $('toolbar-actions').append(button);
}
$('search').oninput = render;
$('servers').onkeydown = event => {
  const row = event.target.closest('.tree-row');
  if (!row || event.target.closest('button')) { return; }
  const visibleRows = [...$('servers').querySelectorAll('.tree-row')].filter(el => el.getClientRects().length);
  const index = visibleRows.indexOf(row);
  let target;
  if (event.key === 'ArrowDown') { target = visibleRows[Math.min(index + 1, visibleRows.length - 1)]; }
  else if (event.key === 'ArrowUp') { target = visibleRows[Math.max(0, index - 1)]; }
  else if (event.key === 'Home') { target = visibleRows[0]; }
  else if (event.key === 'End') { target = visibleRows.at(-1); }
  else if (['Enter', ' ', 'ArrowRight'].includes(event.key) && row.tagName === 'SUMMARY') {
    if (event.key !== 'ArrowRight' || !row.parentElement.open) { row.click(); }
    else { target = visibleRows[index + 1]; }
  } else if (event.key === 'ArrowLeft') {
    if (row.tagName === 'SUMMARY' && row.parentElement.open) { row.click(); }
    else { target = (row.tagName === 'SUMMARY' ? row.parentElement.parentElement : row).closest('details')?.firstElementChild; }
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const server = row.closest('.server').querySelector('.server-row');
    server.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  } else { return; }
  event.preventDefault();
  if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
};
$('open-config').onclick = () => action(() => api.openConfig(), 'settings-error');
$('settings-form').elements.refreshInterval.oninput = event => { $('refresh-value').value = event.target.value; };
for (const [id, checked] of [['select-all', true], ['select-none', false]]) {
  $(id).onclick = () => $('settings-servers').querySelectorAll('input').forEach(input => { input.checked = checked; });
}
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('password-dialog').addEventListener('close', () => $('password-form').reset());
$('settings-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  const unknownExcluded = state.settings.excludedServers.filter(host => !settingsHosts.some(config => config.host === host));
  const excluded = [...$('settings-servers').querySelectorAll('input')].filter(input => !input.checked).map(input => input.dataset.host);
  action(async () => {
    await api.saveSettings({ refreshInterval: Number(form.elements.refreshInterval.value), connectionTimeout: Number(form.elements.connectionTimeout.value),
      servers: [], excludedServers: [...unknownExcluded, ...excluded] });
    $('settings-dialog').close();
  }, 'settings-error').finally(() => { submit.disabled = false; });
};
$('password-form').onsubmit = event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]'), password = $('password').value;
  $('password').value = ''; submit.disabled = true;
  action(async () => { await api.savePassword(passwordHost, password); $('password-dialog').close(); }, 'password-error')
    .finally(() => { submit.disabled = false; });
};
api.onState(value => { state = value; render(); });
api.onOpenSettings(openSettings);
action(async () => { state = await api.getState(); render(); });
