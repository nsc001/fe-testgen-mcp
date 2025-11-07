import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

export interface RunTestsInput {
  projectRoot?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunTestsOutput {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class RunTestsTool {
  async run(input: RunTestsInput = {}): Promise<RunTestsOutput> {
    const {
      projectRoot = process.cwd(),
      command = 'npm',
      args = ['test', '--', '--runInBand'],
      env = {},
      timeoutMs = 10 * 60 * 1000, // 默认 10 分钟超时
    } = input;

    return new Promise<RunTestsOutput>((resolve, reject) => {
      const start = Date.now();
      logger.info('Running tests...', {
        projectRoot,
        command,
        args,
        timeoutMs,
      });

      const child = spawn(command, args, {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...env,
        },
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | null = null;

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          logger.error('Test run timed out', { timeoutMs });
          child.kill('SIGTERM');
          resolve({
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + `\nTest run timed out after ${timeoutMs} ms`,
            durationMs: Date.now() - start,
          });
        }, timeoutMs);
      }

      child.stdout?.on('data', data => {
        const text = data.toString();
        stdout += text;
        logger.debug(text.trim());
      });

      child.stderr?.on('data', data => {
        const text = data.toString();
        stderr += text;
        logger.debug(text.trim());
      });

      child.on('error', error => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        logger.error('Failed to start test process', { error: error.message });
        reject(error);
      });

      child.on('close', exitCode => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const duration = Date.now() - start;
        const success = exitCode === 0;

        logger.info('Test run completed', {
          success,
          exitCode,
          duration,
        });

        resolve({
          success,
          exitCode,
          stdout,
          stderr,
          durationMs: duration,
        });
      });
    });
  }
}
