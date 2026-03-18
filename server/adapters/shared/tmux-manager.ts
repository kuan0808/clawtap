import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';

const exec = promisify(execFile);
const TMUX = 'tmux';
const SESSION_NAME = 'clawtap';

/** A tmux window entry from listWindows */
export interface TmuxWindow {
  id: string;
  name: string;
  command: string;
  cwd: string;
}

export class TmuxManager {
  async ensureSession(): Promise<void> {
    try {
      await exec(TMUX, ['has-session', '-t', SESSION_NAME]);
    } catch {
      await exec(TMUX, ['new-session', '-d', '-s', SESSION_NAME, '-n', 'main']);
    }
  }

  async createWindow(name: string, cwd: string, command: string): Promise<string> {
    await this.ensureSession();
    await exec(TMUX, [
      'new-window', '-t', SESSION_NAME, '-n', name, '-c', cwd, command
    ]);
    const { stdout } = await exec(TMUX, [
      'list-windows', '-t', SESSION_NAME, '-F', '#{window_name}\t#{window_id}'
    ]);
    const line = stdout.trim().split('\n').find(l => l.startsWith(name + '\t'));
    return line ? line.split('\t')[1]! : name;
  }

  async sendKeys(windowId: string, text: string, enter: boolean = true): Promise<void> {
    const target = `${SESSION_NAME}:${windowId}`;
    await exec(TMUX, ['send-keys', '-t', target, '-l', text]);
    if (enter) {
      await exec(TMUX, ['send-keys', '-t', target, 'Enter']);
    }
  }

  async sendControl(windowId: string, key: string): Promise<void> {
    const target = `${SESSION_NAME}:${windowId}`;
    await exec(TMUX, ['send-keys', '-t', target, key]);
  }

  async pasteBuffer(windowId: string, content: string, sendEnter: boolean = true): Promise<void> {
    const id = randomUUID();
    const tmpFile = `/tmp/clawtap-buf-${id}.txt`;
    const bufName = `ct-${id.slice(0, 8)}`;
    await writeFile(tmpFile, content);
    const target = `${SESSION_NAME}:${windowId}`;
    try {
      await exec(TMUX, ['load-buffer', '-b', bufName, tmpFile]);
      await exec(TMUX, ['paste-buffer', '-b', bufName, '-t', target]);
      if (sendEnter) {
        await exec(TMUX, ['send-keys', '-t', target, 'Enter']);
      }
    } finally {
      exec(TMUX, ['delete-buffer', '-b', bufName]).catch(() => {});
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  async capturePane(windowId: string, lines: number = 200): Promise<string> {
    const target = `${SESSION_NAME}:${windowId}`;
    const { stdout } = await exec(TMUX, [
      'capture-pane', '-t', target, '-p', '-S', `-${lines}`
    ]);
    return stdout;
  }

  async killWindow(windowId: string): Promise<void> {
    const target = `${SESSION_NAME}:${windowId}`;
    try { await exec(TMUX, ['kill-window', '-t', target]); } catch {}
  }

  async renameWindow(windowId: string, newName: string): Promise<void> {
    const target = `${SESSION_NAME}:${windowId}`;
    await exec(TMUX, ['rename-window', '-t', target, newName]);
  }

  async killSession(): Promise<void> {
    try { await exec(TMUX, ['kill-session', '-t', SESSION_NAME]); } catch {}
  }

  async listWindows(): Promise<TmuxWindow[]> {
    try {
      const { stdout } = await exec(TMUX, [
        'list-windows', '-t', SESSION_NAME, '-F',
        '#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}'
      ]);
      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [id, name, command, cwd] = line.split('\t');
        return { id: id!, name: name!, command: command!, cwd: cwd! };
      });
    } catch { return []; }
  }
}

export const tmuxManager = new TmuxManager();
