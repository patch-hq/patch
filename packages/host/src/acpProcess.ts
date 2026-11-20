// An ACP agent as a plain child process of the host: for the probe that reads
// an agent's models and sign-in state, and for a turn when the host runs no
// detached turn runner. A turn under the runner goes through
// `DurableCodexProcess` instead (`acpBackend.ts`).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface AcpSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

const STDERR_KEEP = 8192;

export class AcpChildProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderr = '';
  private exited = false;

  constructor(private readonly spec: AcpSpawnSpec) {}

  start(
    onLine: (line: string) => void,
    onExit: (reason: string) => void,
    /** Each chunk the agent writes to stderr, as it comes (a sign-in prints its hand-off there). */
    onStderr?: (chunk: string) => void,
  ): void {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
      onStderr?.(chunk);
    });
    child.stdin.on('error', () => undefined);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() !== '') onLine(line);
    });
    let reported = false;
    const report = (reason: string): void => {
      if (reported) return;
      reported = true;
      this.exited = true;
      onExit(reason);
    };
    child.on('error', (err) => report(`could not start ${this.spec.command}: ${err.message}`));
    child.on('exit', (code, signal) => report(`exited (${signal ?? code ?? 'unknown'})`));
  }

  write(line: string): void {
    if (!this.child || this.exited) throw new Error(`${this.spec.command} is not running`);
    this.child.stdin.write(`${line}\n`);
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill('SIGTERM');
  }

  /** The last of what the agent wrote to stderr, for an error about it. */
  stderrTail(): string {
    return this.stderr.trim();
  }
}
