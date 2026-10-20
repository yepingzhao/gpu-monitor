const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-monitor-test-'));
const child = spawn(require('electron'), [path.join(__dirname, 'smoke.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, GPU_MONITOR_TEST_HOME: temp },
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  // Chromium releases its profile locks only after Electron has exited.
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exitCode = code ?? 1;
});
