'use strict';
const $ = id => document.getElementById(id);
const api = window.monitor;
const labels = { idle: '等待刷新', loading: '刷新中…', online: '在线', 'no-gpu': '无 GPU', 'needs-auth': '需要密码', error: '连接失败' };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) { element.textContent = text; }
  if (className) { element.className = className; }
  return element;
}
async function action(callback) {
  try { await callback(); }
  catch (error) { $('quick-error').textContent = error.message || String(error); $('quick-error').hidden = false; }
}
function render(state) {
  const online = state.statuses.filter(s => s.kind === 'online' || (s.kind === 'loading' && s.gpus.length));
  $('quick-overview').textContent = `${online.length}/${state.statuses.length} 台在线 · ${online.reduce((n, s) => n + s.gpus.length, 0)} GPU`;
  $('quick-refresh').disabled = state.refreshing;
  $('quick-refresh').textContent = state.refreshing ? '刷新中…' : '刷新';
  $('quick-error').textContent = state.error || ''; $('quick-error').hidden = !state.error;
  const list = $('quick-servers'), scrollTop = list.scrollTop;
  list.replaceChildren();
  for (const status of state.statuses) {
    const section = node('section', undefined, 'quick-server');
    const header = node('div', undefined, 'quick-server-header');
    const name = node('h2', status.config.host);
    name.title = `${status.config.user}@${status.config.hostname}:${status.config.port}`;
    header.append(name, node('span', status.kind === 'online' ? `${status.gpus.length} GPU · 在线` : labels[status.kind], `quick-status ${status.kind}`));
    section.append(header);
    if (['online', 'loading'].includes(status.kind) && status.gpus.length) {
      const columns = node('div', undefined, 'quick-columns');
      ['GPU', '显存 (GiB)', '占用', '利用率', '温度'].forEach(label => columns.append(node('span', label)));
      section.append(columns);
      for (const gpu of status.gpus) {
        const pct = gpu.memTotalMiB ? Math.round(gpu.memUsedMiB / gpu.memTotalMiB * 100) : 0;
        const row = node('div', undefined, `quick-gpu ${pct > 80 ? 'high' : pct > 40 ? 'medium' : 'low'}`);
        const used = (gpu.memUsedMiB / 1024).toFixed(1), total = (gpu.memTotalMiB / 1024).toFixed(1);
        const progress = node('progress'); progress.max = Math.max(1, gpu.memTotalMiB); progress.value = gpu.memUsedMiB;
        progress.setAttribute('aria-label', `${status.config.host} GPU ${gpu.index} 显存使用率 ${pct}%`);
        row.append(node('span', `GPU ${gpu.index}`, 'quick-index'), node('span', `${used}/${total}`, 'quick-memory'), progress,
          node('span', `${gpu.utilizationPct}%`, 'quick-secondary'), node('span', `${gpu.temperatureC}°`, 'quick-secondary'));
        row.title = `${gpu.name}\n显存 ${used} / ${total} GiB (${pct}%)\n温度 ${gpu.temperatureC}°C · ${gpu.processes.length} 个 GPU 进程\n在主窗口查看进程详情`;
        section.append(row);
      }
    } else {
      section.append(node('p', status.error || (status.kind === 'needs-auth' ? '在主窗口输入 SSH 密码以连接。' : labels[status.kind]), 'quick-message'));
    }
    list.append(section);
  }
  if (!state.statuses.length) { list.append(node('p', '暂无监控服务器。请在主窗口的设置中选择服务器。', 'quick-message')); }
  list.scrollTop = scrollTop;
}
$('quick-refresh').onclick = () => action(() => api.refresh());
$('close-tray').onclick = () => action(() => api.hideTray());
$('open-main').onclick = () => action(() => api.showMain());
$('open-settings').onclick = () => action(() => api.showMain('settings'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); action(() => api.hideTray()); }
});
api.onState(render);
action(async () => render(await api.getState()));
