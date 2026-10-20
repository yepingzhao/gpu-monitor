const { app, BrowserWindow, Tray, Menu, dialog, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { Server } = require('ssh2');

const temp = process.env.GPU_MONITOR_TEST_HOME;
assert.ok(temp, 'Run this test through test/run.cjs');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(path.join(temp, '.ssh'));
app.setPath('home', temp);
app.setPath('userData', path.join(temp, 'data'));
let menu;
let trayIcon;
let utilization = 67;
let queries = 0;
let tooltip;
let popup;
const queryCounts = new Map();
const nativePopup = Menu.prototype.popup;
Menu.prototype.popup = function(options) { popup = this; return nativePopup.call(this, options); };
const setMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(value) { trayIcon = this; menu = value; return setMenu.call(this, value); };
const setTooltip = Tray.prototype.setToolTip;
Tray.prototype.setToolTip = function(value) { tooltip = value; return setTooltip.call(this, value); };
dialog.showErrorBox = (title, content) => { console.error(title, content); app.exit(1); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) { return; } await pause(50); }
  throw new Error(`Timed out: ${label}`);
}

const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const clients = new Set();
const server = new Server({ hostKeys: [key] }, client => {
  let username;
  clients.add(client);
  client.on('close', () => clients.delete(client));
  client.on('error', () => {});
  client.on('authentication', ctx => {
    username = ctx.username;
    return ctx.method === 'password' && ctx.password === 'smoke-password' ? ctx.accept() : ctx.reject();
  });
  client.on('ready', () => client.on('session', accept => {
    accept().on('exec', (acceptExec, _reject, info) => {
      assert.match(info.command, /nvidia-smi/);
      queries++;
      queryCounts.set(username, (queryCounts.get(username) || 0) + 1);
      const stream = acceptExec();
      const memoryUsage = [8192, 0, 17203, 19661, 22118, 24576, 12288, 2048];
      const gpuLines = Array.from({ length: username === 'idle' ? 2 : 8 }, (_, i) => `${i}, NVIDIA RTX A6000, ${i === 0 ? utilization : 0}, ${memoryUsage[i]}, 24576, ${i === 0 ? 52 : 29}`).join('\n');
      const uuidLines = Array.from({ length: username === 'idle' ? 2 : 8 }, (_, i) => `${i}, GPU-test-${i}`).join('\n');
      stream.write(`${gpuLines}\n__PROCS__\n123, <img src=x onerror=alert(1)>, 8192, GPU-test-0\n__UUIDS__\n${uuidLines}\n`);
      stream.exit(0); stream.end();
    });
  }));
});

(async () => {
  const { trayWindowBounds } = require('../build/desktop/trayPlacement.js');
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 960 }, { x: 0, y: 40, width: 400, height: 400 }]) {
    for (const anchor of [{ x: area.x, y: area.y - 40, width: 24, height: 24 }, { x: area.x + area.width - 24, y: area.y + area.height, width: 24, height: 24 }]) {
      const bounds = trayWindowBounds(anchor, area);
      assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, 'quick view fits top/bottom taskbars and negative-coordinate displays');
    }
  }
  // Exercise the shared OpenSSH adapter without contacting configured hosts.
  const childProcess = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const originalSpawn = childProcess.spawn;
  let sshOutput = '0, NVIDIA Test GPU, 67, 8192, 24576, 52\n__PROCS__\n__UUIDS__\n0, GPU-test\n';
  childProcess.spawn = (command, args, options) => {
    assert.equal(command, 'ssh');
    assert.ok(args.includes('smoke-key'));
    assert.equal(options.windowsHide, true, 'SSH launches without a console window');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write(sshOutput); child.emit('close', 0); });
    return child;
  };
  const { fetchGpuInfo } = require('../build/src/gpuClient.js');
  const keyConfig = { host: 'smoke-key', hostname: '127.0.0.1', port: 22, user: 'test', usePassword: false };
  const store = { get: async () => undefined, delete: async () => {} };
  assert.equal((await fetchGpuInfo(keyConfig, store, 3)).gpus[0].memUsedMiB, 8192);
  sshOutput = 'nvidia-smi: command not found';
  assert.equal((await fetchGpuInfo(keyConfig, store, 3)).noGpu, true);
  childProcess.spawn = originalSpawn;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(temp, '.ssh', 'config'), ['smoke-gpu', 'smoke-idle'].map((host, i) => `Host ${host}\n  HostName 127.0.0.1\n  Port ${server.address().port}\n  User ${i === 0 ? 'test' : 'idle'}\n  PreferredAuthentications password\n`).join('\n'));
  require(process.argv.includes('--packaged')
    ? '../dist/win-unpacked/resources/app.asar/build/desktop/main.js' : '../build/desktop/main.js');
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length === 2, 'separate main and tray windows created');
  const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'GPU Monitor');
  const quick = BrowserWindow.getAllWindows().find(w => w !== win);
  const errors = [];
  win.webContents.on('console-message', (_e, _level, message) => { if (/Uncaught|preload|Unable to load/i.test(message)) { errors.push(message); } });
  const run = script => win.webContents.executeJavaScript(script, true);
  const runQuick = script => quick.webContents.executeJavaScript(script, true);
  const state = () => run('window.monitor.getState()');
  await until(async () => !win.webContents.isLoading() && await run('!!window.monitor'), 'preload bridge');
  await until(async () => !quick.webContents.isLoading() && await runQuick('!!window.monitor'), 'quick view preload bridge');
  await until(async () => (await state()).statuses[0]?.kind === 'needs-auth', 'password required');
  assert.equal(queries, 0, 'no automatic password prompt or network connection');
  assert.equal(await run('typeof require'), 'undefined', 'renderer has no Node access');
  assert.ok(menu && tooltip, 'native tray and menu created');
  assert.equal(quick.isVisible(), false, 'quick view stays hidden on startup');
  assert.equal(quick.isResizable(), false);
  assert.equal(quick.isAlwaysOnTop(), true);
  await assert.rejects(() => runQuick(`window.monitor.saveSettings({refreshInterval: 5, connectionTimeout: 8, servers: [], excludedServers: []})`), /Untrusted IPC sender/);
  if (process.argv.includes('--hidden')) {
    assert.equal(win.isVisible(), false, '--hidden starts directly in the tray');
    menu.items[0].click();
    await until(() => win.isVisible(), 'restore hidden startup');
  }

  await run(`document.querySelector('.server-row').click()`);
  assert.equal(await run(`document.getElementById('password-dialog').open`), true, 'clicking an auth-required server opens password dialog');
  await run(`document.getElementById('password').value = 'smoke-password'; document.getElementById('password-form').requestSubmit()`);
  await until(async () => (await state()).statuses[0].kind === 'online' && !await run(`document.getElementById('password-dialog').open`), 'password submitted through UI');
  let current = await state();
  assert.equal(current.statuses[0].kind, 'online');
  assert.equal(current.statuses[0].gpus[0].utilizationPct, 67);
  assert.equal(current.statuses[0].gpus[0].processes[0].pid, 123);
  assert.ok(!JSON.stringify(current).includes('smoke-password'), 'password not exposed in state');
  const files = fs.readdirSync(path.join(temp, 'data', 'secrets'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(temp, 'data', 'secrets', files[0])).includes(Buffer.from('smoke-password')), 'password encrypted at rest');
  assert.equal(await run(`document.querySelectorAll('#servers img').length`), 0, 'process names cannot inject HTML');
  assert.ok(await run(`document.querySelector('.process-name').textContent.includes('<img')`));
  assert.equal(await run(`document.querySelector('details.gpu').open`), false, 'GPU processes start collapsed');
  assert.equal(await run(`document.querySelector('details.server').open`), true, 'servers start expanded');
  await run(`document.querySelector('.gpu summary').click()`);
  await run('window.monitor.refresh()');
  assert.equal(await run(`document.querySelector('details.gpu').open`), true, 'process expansion survives refresh');
  await run(`window.monitor.savePassword('smoke-idle', 'smoke-password')`);
  const idleQueries = queryCounts.get('idle');
  const firstQueries = queryCounts.get('test');
  await run(`document.querySelector('[data-key="refresh:smoke-gpu"]').click()`);
  await until(async () => queryCounts.get('test') > firstQueries && !(await state()).refreshing, 'inline single-server refresh');
  assert.equal(queryCounts.get('idle'), idleQueries, 'refreshing one host does not query another');
  await run(`document.querySelector('.server-row').click()`);
  await run('window.monitor.refresh()');
  assert.equal(await run(`document.querySelector('details.server').open`), false, 'server collapse survives refresh');
  await run(`document.querySelector('.server-row').focus()`);
  assert.equal(await run(`document.activeElement.classList.contains('server-row')`), true);
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(async () => await run(`document.querySelector('details.server').open`), 'keyboard expands server');

  await run(`document.getElementById('settings-open').click()`);
  assert.equal(await run(`document.querySelectorAll('#settings-servers input').length`), 2);
  await run(`document.querySelectorAll('#settings-servers input')[1].checked = false; document.getElementById('settings-form').requestSubmit()`);
  await until(async () => (await state()).statuses.length === 1 && !await run(`document.getElementById('settings-dialog').open`), 'settings checkbox excludes host');
  assert.deepEqual((await state()).settings.excludedServers, ['smoke-idle']);
  await run(`document.getElementById('settings-open').click()`);
  assert.equal(await run(`document.querySelectorAll('#settings-servers input')[1].checked`), false, 'excluded hosts remain visible in settings');
  await pause(150);
  fs.writeFileSync(path.join(artifacts, 'settings.png'), (await win.webContents.capturePage()).toPNG());
  await run(`document.getElementById('select-all').click(); document.getElementById('settings-form').requestSubmit()`);
  await until(async () => (await state()).statuses.length === 2 && !await run(`document.getElementById('settings-dialog').open`), 'select all restores hosts');
  await run(`document.getElementById('collapse-all').click()`);
  assert.equal(await run(`[...document.querySelectorAll('details.server')].every(el => !el.open)`), true);
  await run(`document.querySelectorAll('.server-row').forEach(row => row.click())`);
  assert.equal(await run(`[...document.querySelectorAll('details.gpu')].every(el => !el.open)`), true);

  await assert.rejects(() => run(`window.monitor.saveSettings({refreshInterval: 0, connectionTimeout: 8, servers: [], excludedServers: []})`));
  await run(`window.monitor.saveSettings({refreshInterval: 5, connectionTimeout: 3, servers: [], excludedServers: []})`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'data', 'settings.json'))).refreshInterval, 5);
  await run(`document.getElementById('search').value = 'not-found'; document.getElementById('search').dispatchEvent(new Event('input'))`);
  assert.match(await run(`document.getElementById('servers').textContent`), /没有匹配/);
  await run(`document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input'))`);

  const captures = [{ width: 1080, height: 760 }, { width: 580, height: 620 }];
  for (const size of captures) {
    win.setSize(size.width, size.height);
    await pause(100);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal overflow');
    fs.writeFileSync(path.join(artifacts, `desktop-${size.width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  win.minimize();
  await until(() => !win.isVisible(), 'minimize hides window');
  const before = queries;
  await until(() => queries > before, 'background polling while hidden');
  await until(async () => !(await state()).refreshing, 'background poll completed');
  const beforeOpen = queries;
  trayIcon.emit('click');
  await until(() => quick.isVisible(), 'single tray click opens quick view');
  assert.equal(win.isVisible(), false, 'quick view does not restore the main window');
  assert.equal(queries, beforeOpen, 'opening quick view does not start another poll');
  assert.equal(await runQuick(`document.querySelectorAll('.quick-gpu').length`), 10);
  assert.equal(await runQuick(`document.getElementById('settings-dialog')`), null, 'settings belong to main window');
  const bounds = quick.getBounds(), area = screen.getDisplayMatching(quick.getBounds()).workArea;
  assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
  utilization = 43;
  await runQuick(`document.getElementById('quick-refresh').click()`);
  await until(async () => !(await state()).refreshing && (await state()).statuses[0].gpus[0].utilizationPct === 43, 'quick view refresh updates shared data');
  assert.equal(await runQuick(`document.querySelector('.quick-secondary').textContent`), '43%');
  assert.equal(await run(`document.querySelector('.util').textContent`), 'util 43%', 'hidden main window receives the same update');
  await pause(150);
  fs.writeFileSync(path.join(artifacts, 'tray-window.png'), (await quick.webContents.capturePage()).toPNG());
  quick.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  quick.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() => !quick.isVisible(), 'Escape dismisses quick view');
  trayIcon.emit('click');
  await until(() => quick.isVisible(), 'reopen quick view');
  await runQuick(`document.getElementById('close-tray').click()`);
  await until(() => !quick.isVisible(), 'quick view close button hides it');
  trayIcon.emit('click');
  await until(() => quick.isVisible(), 'quick view available after close');
  win.show(); win.focus();
  await until(() => !quick.isVisible(), 'quick view dismisses on focus loss');
  await run('window.monitor.hide()');
  trayIcon.emit('click');
  await until(() => quick.isVisible(), 'quick view reopens independently');
  await runQuick(`document.getElementById('open-settings').click()`);
  await until(async () => win.isVisible() && !quick.isVisible() && await run(`document.getElementById('settings-dialog').open`), 'quick view settings open in main window');
  await run(`document.querySelector('[data-close="settings-dialog"]').click(); window.monitor.hide()`);
  trayIcon.emit('click');
  await until(() => quick.isVisible(), 'reopen before switching to main');
  await runQuick(`document.getElementById('open-main').click()`);
  await until(() => win.isVisible() && !win.isMinimized() && !quick.isVisible(), 'quick view opens main window');
  quick.close();
  assert.equal(quick.isDestroyed(), false, 'closing quick view preserves its window');
  await run('window.monitor.hide()');
  trayIcon.emit('double-click');
  await until(() => win.isVisible() && !quick.isVisible(), 'tray double click restores main window');
  menu.items[0].click();
  await until(() => win.isVisible() && !win.isMinimized(), 'tray restores minimized window');
  win.close();
  await until(() => !win.isVisible(), 'close hides window');
  assert.equal(win.isDestroyed(), false);
  menu.items[0].click();
  await until(() => win.isVisible(), 'tray restores closed window');
  const previous = queries;
  menu.items[1].click();
  await until(() => queries > previous, 'tray refresh action');

  await run(`document.querySelector('.server-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
  await until(() => !!popup, 'native server context menu');
  assert.equal(popup.items[0].label, '刷新此服务器');
  popup.items[2].click(); popup.closePopup();
  await until(async () => (await state()).statuses[0].kind === 'needs-auth', 'context menu clears password');
  assert.equal((await state()).statuses[0].kind, 'needs-auth');
  assert.equal(fs.readdirSync(path.join(temp, 'data', 'secrets')).length, 1);
  await run(`window.monitor.savePassword('smoke-gpu', 'wrong-password')`);
  assert.equal((await state()).statuses[0].kind, 'error');
  assert.equal(fs.readdirSync(path.join(temp, 'data', 'secrets')).length, 1, 'rejected password deleted');
  assert.deepEqual(errors, []);
  console.log('PASS: distinct main/quick-view windows, tray placement, focus/Escape dismissal, shared data and polling, main/settings handoff, compact tree, server controls, encrypted passwords and tray lifecycle.');
  for (const client of clients) { client.end(); }
  server.close();
  menu.items[3].click();
})().catch(e => { console.error(e); for (const client of clients) { client.destroy(); } server.close(); app.exit(1); });
