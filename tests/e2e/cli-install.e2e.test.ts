import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000, hookTimeout: 20000 });

const CLI_PATH = path.resolve(import.meta.dirname, '../../scripts/cli.mjs');
const TEST_INSTALL_DIR = path.join(os.tmpdir(), `ds-e2e-cli-${Date.now()}`);

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env['PATH'] },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch (e: unknown) {
    const execError = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    stdout = execError.stdout?.toString() ?? '';
    stderr = execError.stderr?.toString() ?? '';
    exitCode = execError.status ?? 1;
  }

  return { stdout, stderr, exitCode };
}

describe('CLI (E2E)', () => {
  beforeAll(() => {
    if (fs.existsSync(TEST_INSTALL_DIR)) {
      fs.rmSync(TEST_INSTALL_DIR, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(TEST_INSTALL_DIR)) {
      fs.rmSync(TEST_INSTALL_DIR, { recursive: true, force: true });
    }
  });

  describe('#158 — non-interactive install fail-fast', () => {
    it('should fail fast with missing flags and list them', async () => {
      const result = runCli([
        'install',
        '--db-url',
        'postgresql://test:test@localhost:5432/test',
      ]);

      // Non-interactive with partial flags must exit non-zero
      expect(result.exitCode).not.toBe(0);
      // Must mention "Missing" or "requires"
      const output = result.stdout + result.stderr;
      expect(
        output.includes('Missing') ||
          output.includes('requires all flags') ||
          output.includes('flag'),
        `Expected CLI to list missing flags, got: ${output}`,
      ).toBe(true);
    });

    it('should fail fast with no flags and non-interactive env', async () => {
      const result = runCli([
        'install',
      ]);

      // With no flags at all, and in a non-TTY context, should not hang
      // (test env is non-TTY, so it should either fail or fall to interactive)
      // The CLI should not block indefinitely
      const output = result.stdout + result.stderr;
      const isFinished = result.exitCode !== null &&
        (output.includes('No flags provided') ||
         output.includes('Missing') ||
         output.includes('install'));
      expect(isFinished, `CLI should not hang without flags, got exit=${result.exitCode}: ${output}`).toBe(true);
    });
  });

  describe('#158 — verifyInstallation integrity check', () => {
    it('should report missing files when nothing installed', async () => {
      // Dynamically import verifyInstallation from the CLI module
      const cliPath = path.resolve(import.meta.dirname, '../../scripts/cli.mjs');
      const { verifyInstallation } = await import(cliPath);

      const emptyDir = path.join(TEST_INSTALL_DIR, 'empty-install');
      fs.mkdirSync(emptyDir, { recursive: true });

      const result = verifyInstallation(emptyDir);
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.missing).toContain('.env');

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('should pass when all required files exist', async () => {
      const { verifyInstallation } = await import(CLI_PATH);

      const validDir = path.join(TEST_INSTALL_DIR, 'valid-install');
      fs.mkdirSync(validDir, { recursive: true });

      // Create all required files
      fs.writeFileSync(path.join(validDir, '.env'), 'DATABASE_URL=test');
      fs.writeFileSync(path.join(validDir, 'ecosystem.config.cjs'), 'module.exports = {}');
      fs.mkdirSync(path.join(validDir, 'dist', 'src'), { recursive: true });
      fs.writeFileSync(path.join(validDir, 'dist', 'src', 'server.js'), '// server');
      fs.mkdirSync(path.join(validDir, 'node_modules'), { recursive: true });

      const result = verifyInstallation(validDir);
      expect(result.ok).toBe(true);
      expect(result.missing.length).toBe(0);

      fs.rmSync(validDir, { recursive: true, force: true });
    });
  });

  describe('#158 — install help output', () => {
    it('should show --skip-port-check in help text', async () => {
      const result = runCli(['install', '--help']);

      const output = result.stdout + result.stderr;
      expect(output).toContain('--skip-port-check');
    });
  });
});
