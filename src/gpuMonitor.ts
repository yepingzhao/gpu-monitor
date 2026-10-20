import * as vscode from 'vscode';
import { SshHostConfig, FetchResult } from './types';
import { fetchGpuInfo as fetch } from './gpuClient';

export async function fetchGpuInfo(
  config: SshHostConfig,
  secrets: vscode.SecretStorage
): Promise<FetchResult> {
  const timeout = vscode.workspace.getConfiguration('gpuMonitor').get<number>('connectionTimeout') ?? 8;
  const result = await fetch(config, secrets, timeout);
  if (config.usePassword && result.error?.toLowerCase().includes('auth')) {
    vscode.window.showWarningMessage(
      `GPU Monitor: Authentication failed for ${config.host}. Password cleared – connect again to enter a new password.`
    );
  }
  return result;
}

/** Prompt only after an explicit user action. */
export async function promptPassword(
  config: SshHostConfig,
  secrets: vscode.SecretStorage
): Promise<boolean> {
  const password = await vscode.window.showInputBox({
    title: 'GPU Monitor – SSH Password',
    prompt: `Password for ${config.user}@${config.hostname}:${config.port} (${config.host})`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) { return false; }
  await secrets.store(`gpu-monitor.pwd.${config.host}`, password);
  return true;
}
