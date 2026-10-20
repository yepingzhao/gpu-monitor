# GPU Monitor

A Cursor / VS Code extension that monitors NVIDIA GPU usage across your SSH servers, reading host configuration directly from `~/.ssh/config`.

![SSH GPU Monitor](https://raw.githubusercontent.com/huia711/gpu-monitor/main/media/screenshot.png)

## Features

- **Live GPU stats** — utilization %, VRAM usage (GB), temperature
- **Visual memory bar** — `[████████░░]` per GPU
- **Process list** — which processes are using each GPU (collapsed by default, click to expand)
- **Auto-sync** — reloads server list when `~/.ssh/config` changes
- **Password auth** — prompts once, stores securely in VS Code Secret Storage
- **Settings UI** — gear icon in panel header

## Requirements

- [Node.js](https://nodejs.org/) (for building)
- SSH servers running `nvidia-smi`
- SSH keys or passwords already configured in `~/.ssh/config`

## Installation

### Windows desktop / system tray

The standalone desktop app runs independently of VS Code / Cursor:

For the packaged app, run `GPU-Monitor-Setup-<version>-x64.exe`. The installation wizard supports Chinese and English, defaults to the current user, allows selecting the installation directory, and creates desktop and Start menu shortcuts. It also registers **GPU Monitor** in Windows Installed apps for uninstalling. Application settings and encrypted passwords are retained when uninstalling. Exit any running tray instance before installing or upgrading.

To run from source:

```powershell
git clone https://github.com/yepingzhao/gpu-monitor
cd gpu-monitor
git switch feat/windows-tray-app
npm ci
cd desktop
npm ci
npm start
```

- Reads `%USERPROFILE%\.ssh\config` and refreshes GPU usage, VRAM, temperature, and processes in the background.
- Uses the extension's compact server → GPU → process hierarchy: servers start expanded, GPU processes start collapsed, and each GPU row emphasizes VRAM usage with an eight-segment memory bar. Utilization, temperature, and detailed hover text remain available.
- Hover a server row to refresh only that server or open its native context menu. Password-required servers can be clicked directly; saved passwords can be cleared from the context menu. The header supports refreshing all servers and collapsing the tree.
- The **main window** provides the complete server/GPU/process tree, password actions, and settings. Minimize, close, or choose **收起到托盘** to hide it and keep monitoring.
- Single-click the tray icon to open a separate, compact **quick view** beside the icon. It shows live GPU memory/utilization/temperature and shares the same background polling as the main window. It stays out of the taskbar and dismisses on focus loss, Escape, or its close button.
- Choose **打开主窗口** in the quick view or tray context menu, or double-click the tray icon, to restore the full window. The quick view's **设置** button opens settings in the main window. Right-click the tray icon and choose **退出** to quit both windows.
- Windows controls whether the icon appears directly on the taskbar or under **Show hidden icons**. You can drag it between these areas or change taskbar settings.
- A second launch restores the existing window. Use `npm start -- --hidden` from `desktop` to start in the tray.
- The settings dialog supports refresh interval, connection timeout, per-server monitoring checkboxes, and opening the SSH config. SSH config changes are reloaded automatically. Existing include/exclude settings are reflected by the checkboxes.
- Key authentication uses Windows OpenSSH (`ssh` must be on `PATH`), including `ProxyJump` and `ssh-agent`. Password authentication uses direct `ssh2` connections, as in the extension; password connections through `ProxyJump` are not supported.
- Passwords are encrypted with Electron `safeStorage` (Windows DPAPI) under the app's user data directory, separately from VS Code secrets. Use **清除密码** to remove a saved password.
- Desktop settings and encrypted passwords are stored in `%APPDATA%\gpu-monitor-desktop`.

Build and test from `desktop`:

```powershell
npm test               # Local SSH fixture + native Electron integration tests
npm run dist           # Windows installation wizard: desktop/dist/GPU-Monitor-Setup-<version>-x64.exe
npm run dist:portable  # Standalone portable executable in desktop/dist
```

The tests use a temporary home directory and a local SSH server; they do not connect to your configured servers. The extension remains available with the installation steps below.

### macOS / Linux

```bash
git clone https://github.com/huia711/gpu-monitor
cd gpu-monitor
bash install.sh
```

Then restart Cursor / VS Code.

### Windows

```powershell
git clone https://github.com/huia711/gpu-monitor
cd gpu-monitor
.\install.ps1
```

> If PowerShell blocks the script: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

## Configuration

Click the **⚙ gear icon** in the GPU Monitor panel, or edit settings manually:

| Setting | Default | Description |
|---|---|---|
| `gpuMonitor.refreshInterval` | `30` | Auto-refresh interval (seconds) |
| `gpuMonitor.connectionTimeout` | `8` | SSH connection timeout (seconds) |
| `gpuMonitor.excludedServers` | `[]` | Host aliases to skip |
| `gpuMonitor.servers` | `[]` | Only monitor these hosts (empty = all) |

## Authentication

| Type | How it works |
|---|---|
| **SSH key** | Uses your system `ssh` command — ProxyJump, `ssh-agent`, etc. all work automatically |
| **Password** | Click the 🔑 key icon next to the server. Password is stored in VS Code Secret Storage and reused on subsequent refreshes. Right-click → *Clear Saved Password* to reset. |

## Updating

```bash
git pull
bash install.sh   # or .\install.ps1 on Windows
```

Then restart Cursor / VS Code.
