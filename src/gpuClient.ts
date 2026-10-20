import { spawn } from 'child_process';
import { Client } from 'ssh2';
import { SshHostConfig, GpuInfo, ProcessInfo, FetchResult } from './types';

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  delete(key: string): PromiseLike<void>;
}

// ---------------------------------------------------------------------------
// Remote command
// ---------------------------------------------------------------------------

/**
 * Shell one-liner that outputs three sections separated by known delimiters.
 *
 * Section 1 – GPU info:   index, name, util%, mem_used MiB, mem_total MiB, temp °C
 * Section 2 – Processes:  pid, process_name, used_memory (MiB), gpu_uuid
 * Section 3 – UUID map:   index, uuid
 */
const REMOTE_CMD = [
  "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
  "  --format=csv,noheader,nounits 2>/dev/null",
  "; echo '__PROCS__'",
  "; nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_uuid",
  "  --format=csv,noheader,nounits 2>/dev/null",
  "; echo '__UUIDS__'",
  "; nvidia-smi --query-gpu=index,uuid --format=csv,noheader 2>/dev/null",
].join('');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchGpuInfo(
  config: SshHostConfig,
  secrets: SecretStore,
  timeout = 8
): Promise<FetchResult> {
  if (config.usePassword) {
    return fetchWithPassword(config, secrets, timeout);
  }
  return fetchWithKey(config, timeout);
}

// ---------------------------------------------------------------------------
// Key-based: delegate to system ssh (handles ProxyJump transparently)
// ---------------------------------------------------------------------------

function fetchWithKey(config: SshHostConfig, timeout: number): Promise<FetchResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${timeout}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'LogLevel=ERROR',
      '-o', 'ClearAllForwardings=yes',   // disable RemoteForward/LocalForward from config
      config.host,     // use alias so SSH reads its own config (ProxyJump etc.)
      REMOTE_CMD,
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Hard kill after timeout + buffer
    const timer = setTimeout(() => {
      child.kill();
      resolve({ gpus: [], error: `Timeout (${timeout}s)` });
    }, (timeout + 6) * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({ gpus: [], error: prettifySSHError(stderr, code) });
        return;
      }

      if (!stdout.includes('__PROCS__')) {
        // Connected but nvidia-smi not found or not a GPU host
        resolve({ gpus: [], noGpu: true });
        return;
      }

      try {
        resolve({ gpus: parseOutput(stdout) });
      } catch (e) {
        resolve({ gpus: [], error: `Parse error: ${e}` });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ gpus: [], error: `spawn failed: ${err.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Password-based: use ssh2 library and the caller's secret storage
// ---------------------------------------------------------------------------

async function fetchWithPassword(
  config: SshHostConfig,
  secrets: SecretStore,
  timeout = 8
): Promise<FetchResult> {
  const secretKey = `gpu-monitor.pwd.${config.host}`;
  const password = await secrets.get(secretKey);

  // No stored password: wait for an explicit user action in the host application.
  if (!password) {
    return { gpus: [], needsAuth: true };
  }

  return new Promise((resolve) => {
    const conn = new Client();

    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ gpus: [], error: `Timeout (${timeout}s)` });
    }, (timeout + 6) * 1000);

    conn.on('ready', () => {
      conn.exec(REMOTE_CMD, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          resolve({ gpus: [], error: err.message });
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        stream.on('close', () => {
          clearTimeout(timer);
          conn.end();

          if (!stdout.includes('__PROCS__')) {
            resolve({ gpus: [], noGpu: true });
            return;
          }

          try {
            resolve({ gpus: parseOutput(stdout) });
          } catch (e) {
            resolve({ gpus: [], error: `Parse error: ${e}` });
          }
        });
      });
    });

    conn.on('error', async (err) => {
      clearTimeout(timer);
      // Clear stored password if authentication failed
      if (err.message.toLowerCase().includes('auth')) {
        await secrets.delete(secretKey);
      }
      resolve({ gpus: [], error: err.message });
    });

    conn.connect({
      host: config.hostname,
      port: config.port,
      username: config.user,
      password,
      readyTimeout: timeout * 1000,
    });
  });
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

function parseOutput(raw: string): GpuInfo[] {
  const [gpuSection = '', rest = ''] = raw.split('__PROCS__');
  const [procsSection = '', uuidSection = ''] = rest.split('__UUIDS__');

  // ---- GPU rows ----
  const gpus: GpuInfo[] = [];
  for (const line of gpuSection.trim().split('\n')) {
    const parts = line.trim().split(',').map(s => s.trim());
    if (parts.length < 6) { continue; }
    const index = parseInt(parts[0], 10);
    if (isNaN(index)) { continue; }

    gpus.push({
      index,
      name: parts[1],
      utilizationPct: parseIntSafe(parts[2]),
      memUsedMiB: parseIntSafe(parts[3]),
      memTotalMiB: parseIntSafe(parts[4]),
      temperatureC: parseIntSafe(parts[5]),
      processes: [],
    });
  }

  // ---- UUID → GPU index map ----
  const uuidToIndex = new Map<string, number>();
  for (const line of uuidSection.trim().split('\n')) {
    const parts = line.trim().split(',').map(s => s.trim());
    if (parts.length >= 2) {
      uuidToIndex.set(parts[1], parseInt(parts[0], 10));
    }
  }

  // ---- Process rows ----
  for (const line of procsSection.trim().split('\n')) {
    const parts = line.trim().split(',').map(s => s.trim());
    if (parts.length < 4) { continue; }

    const pid = parseInt(parts[0], 10);
    if (isNaN(pid)) { continue; }

    const proc: ProcessInfo = {
      pid,
      processName: parts[1],
      memUsedMiB: parseIntSafe(parts[2].replace(/\s*MiB$/i, '')),
    };

    const gpuIdx = uuidToIndex.get(parts[3]);
    const gpu = gpus.find(g => g.index === gpuIdx);
    if (gpu) {
      gpu.processes.push(proc);
    }
  }

  return gpus;
}

function parseIntSafe(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function prettifySSHError(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (s.includes('connection refused'))        { return 'Connection refused'; }
  if (s.includes('no route to host'))          { return 'Host unreachable'; }
  if (s.includes('network is unreachable'))    { return 'Network unreachable'; }
  if (s.includes('connection timed out'))      { return 'Connection timed out'; }
  if (s.includes('permission denied'))         { return 'Permission denied (check SSH key)'; }
  if (s.includes('host key verification'))     { return 'Host key mismatch'; }
  if (stderr.trim())                           { return stderr.trim().split('\n')[0]; }
  return `SSH exited with code ${code}`;
}
