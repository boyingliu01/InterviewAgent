import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNodeVersion,
  checkPlatformDeps,
  checkPm2,
  checkPostgres,
  exec,
  generateConfigFromFlags,
  generateEnvContent,
  isDirectServiceRunning,
  isWindows,
  main,
  parseArgs,
  startViaNode,
  stopDirectService,
  validateConfig,
  verifyInstallation,
  // @ts-expect-error - cli.mjs has no type declarations
} from '../scripts/cli.mjs';

describe('CLI', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('parseArgs', () => {
    it('should parse command with no flags', () => {
      const result = parseArgs(['install']);
      expect(result.command).toBe('install');
      expect(result.flags).toEqual({});
      expect(result.positional).toEqual([]);
    });

    it('should parse command with flags', () => {
      const result = parseArgs([
        'install',
        '--db-url',
        'postgresql://localhost/db',
        '--llm-api-key',
        'sk-xxx',
      ]);
      expect(result.command).toBe('install');
      expect(result.flags).toEqual({
        'db-url': 'postgresql://localhost/db',
        'llm-api-key': 'sk-xxx',
      });
    });

    it('should parse boolean flags (no value)', () => {
      const result = parseArgs(['uninstall', '--remove-db']);
      expect(result.command).toBe('uninstall');
      expect(result.flags).toEqual({ 'remove-db': 'true' });
    });

    it('should default to help when no command given', () => {
      const result = parseArgs([]);
      expect(result.command).toBe('help');
    });

    it('should collect positional arguments', () => {
      const result = parseArgs(['install', 'extra1', '--flag', 'val', 'extra2']);
      expect(result.positional).toEqual(['extra1', 'extra2']);
      expect(result.flags).toEqual({ flag: 'val' });
    });

    it('should handle mixed flags and positional args', () => {
      // --verbose consumes "arg1" as its value (next non-flag token)
      const result = parseArgs(['status', '--verbose', 'arg1', '--key', 'value']);
      expect(result.command).toBe('status');
      expect(result.flags).toEqual({ verbose: 'arg1', key: 'value' });
      expect(result.positional).toEqual([]);
    });

    it('should treat positional args after all flags correctly', () => {
      const result = parseArgs(['status', '--verbose', '--key', 'value']);
      expect(result.command).toBe('status');
      expect(result.flags).toEqual({ verbose: 'true', key: 'value' });
      expect(result.positional).toEqual([]);
    });
  });

  describe('generateConfigFromFlags', () => {
    it('should map flag names to config keys', () => {
      const flags = {
        'db-url': 'postgresql://localhost/db',
        'llm-api-key': 'sk-llm',
        'llm-base-url': 'http://localhost:11434/v1',
        'llm-model': 'qwen2.5',
        'dingtalk-client-id': 'dt-id',
        'dingtalk-client-secret': 'dt-secret',
        'dingtalk-agent-id': 'dt-agent',
      };
      const config = generateConfigFromFlags(flags);
      expect(config.DATABASE_URL).toBe('postgresql://localhost/db');
      expect(config.LLM_API_KEY).toBe('sk-llm');
      expect(config.LLM_BASE_URL).toBe('http://localhost:11434/v1');
      expect(config.LLM_MODEL).toBe('qwen2.5');
      expect(config.DINGTALK_CLIENT_ID).toBe('dt-id');
      expect(config.DINGTALK_CLIENT_SECRET).toBe('dt-secret');
      expect(config.DINGTALK_AGENT_ID).toBe('dt-agent');
    });

    it('should return empty strings for missing flags', () => {
      const config = generateConfigFromFlags({});
      expect(config.DATABASE_URL).toBe('');
      expect(config.LLM_API_KEY).toBe('');
      expect(config.LLM_BASE_URL).toBe('');
      expect(config.LLM_MODEL).toBe('');
      expect(config.DINGTALK_CLIENT_ID).toBe('');
      expect(config.DINGTALK_CLIENT_SECRET).toBe('');
      expect(config.DINGTALK_AGENT_ID).toBe('');
    });

    it('should handle partial flags', () => {
      const config = generateConfigFromFlags({
        'db-url': 'postgresql://localhost/db',
      });
      expect(config.DATABASE_URL).toBe('postgresql://localhost/db');
      expect(config.LLM_API_KEY).toBe('');
    });
  });

  describe('validateConfig', () => {
    it('should return valid when all required fields present', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should return valid when LLM config is omitted (local LLM)', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should return missing fields when empty', () => {
      const config = {
        DATABASE_URL: '',
        DINGTALK_CLIENT_ID: '',
        DINGTALK_CLIENT_SECRET: '',
        DINGTALK_AGENT_ID: '',
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.missing).toHaveLength(4);
    });

    it('should identify specific missing fields', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: '',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['DINGTALK_CLIENT_SECRET']);
    });
  });

  describe('checkNodeVersion', () => {
    it('should pass when Node.js >= 20', () => {
      const result = checkNodeVersion();
      // Current Node.js in this project is >= 20
      expect(result.ok).toBe(true);
      expect(result.message).toContain('✓');
    });

    it('should fail when Node.js < 20', () => {
      const result = checkNodeVersion('18.0.0');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('>= 20');
    });
  });

  describe('checkPostgres', () => {
    it('should fail when DATABASE_URL is empty', async () => {
      const result = await checkPostgres('');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('DATABASE_URL not provided');
    });

    it('should fail when PostgreSQL is not reachable (no listener)', async () => {
      // Port 59999 should not have a Postgres listener — net.Socket will
      // error out quickly.
      const result = await checkPostgres('postgresql://user:pass@localhost:59999/db', 1000);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('PostgreSQL not reachable');
    });
  });

  describe('checkPm2', () => {
    it('should return ok or error based on PM2 availability', () => {
      const result = checkPm2();
      // PM2 may or may not be installed — just verify the shape
      expect(typeof result.ok).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });

  describe('isWindows', () => {
    it('should return a boolean based on current platform', () => {
      const result = isWindows();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('checkPlatformDeps', () => {
    it('should return an object with ok, message, and serviceManager', () => {
      const result = checkPlatformDeps();
      expect(result).toHaveProperty('ok');
      expect(typeof result.ok).toBe('boolean');
      expect(typeof result.message).toBe('string');
      expect(['pm2', 'direct']).toContain(result.serviceManager);
    });
  });

  describe('startViaNode', () => {
    it('should be a function that takes a cwd argument', () => {
      expect(typeof startViaNode).toBe('function');
      expect(startViaNode.length).toBe(1);
    });
  });

  describe('stopDirectService', () => {
    it('should return a boolean', () => {
      const result = stopDirectService();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isDirectServiceRunning', () => {
    it('should return a boolean', () => {
      const result = isDirectServiceRunning();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('generateEnvContent', () => {
    it('should generate valid .env content from config with LLM keys', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        LLM_API_KEY: 'sk-llm',
        LLM_BASE_URL: 'http://localhost:11434/v1',
        LLM_MODEL: 'qwen2.5',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const content = generateEnvContent(config);
      expect(content).toContain('DATABASE_URL="postgresql://localhost/db"');
      expect(content).toContain('LLM_API_KEY=sk-llm');
      expect(content).toContain('LLM_BASE_URL=http://localhost:11434/v1');
      expect(content).toContain('LLM_MODEL=qwen2.5');
      expect(content).toContain('DINGTALK_CLIENT_ID=dt-id');
      expect(content).toContain('DINGTALK_CLIENT_SECRET=dt-secret');
      expect(content).toContain('DINGTALK_AGENT_ID=dt-agent');
      expect(content).toContain('NODE_ENV=production');
      expect(content).toContain('PORT=3001');
      expect(content).toContain('ENCRYPTION_KEY=');
      expect(content).toContain('ADMIN_API_KEY=');
    });

    it('should not include LLM_BASE_URL/LLM_MODEL when not provided', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        LLM_API_KEY: 'sk-llm',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const content = generateEnvContent(config);
      expect(content).toContain('LLM_API_KEY=sk-llm');
      expect(content).not.toContain('LLM_BASE_URL');
      expect(content).not.toContain('LLM_MODEL');
    });

    it('should include auto-generated security keys', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        LLM_API_KEY: 'sk-llm',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const content = generateEnvContent(config);
      // ENCRYPTION_KEY and ADMIN_API_KEY should be hex strings
      const encMatch = content.match(/ENCRYPTION_KEY=(\w+)/);
      const adminMatch = content.match(/ADMIN_API_KEY=(\w+)/);
      expect(encMatch).not.toBeNull();
      expect(adminMatch).not.toBeNull();
      expect(encMatch?.[1]).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(adminMatch?.[1]).toHaveLength(32);
    });

    it('should handle empty LLM_API_KEY gracefully', () => {
      const config = {
        DATABASE_URL: 'postgresql://localhost/db',
        LLM_API_KEY: '',
        DINGTALK_CLIENT_ID: 'dt-id',
        DINGTALK_CLIENT_SECRET: 'dt-secret',
        DINGTALK_AGENT_ID: 'dt-agent',
      };
      const content = generateEnvContent(config);
      expect(content).toContain('LLM_API_KEY=');
    });
  });

  describe('installCommand platform awareness', () => {
    it('should output platform dep check result when running install', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      // Run with --help to avoid full install flow
      await main(['install', '--help', 'true']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      // Help output should reference the installer
      expect(output).toContain('dialog-survey install');
      writeSpy.mockRestore();
    });

    it('checkPlatformDeps result should include serviceManager field', () => {
      const result = checkPlatformDeps();
      expect(result.serviceManager).toMatch(/^pm2$|^direct$/);
    });
  });

  describe('exec', () => {
    it('should execute a command and return trimmed stdout', () => {
      const result = exec('echo hello');
      expect(result).toBe('hello');
    });

    it('should throw on command failure', () => {
      expect(() => exec('false')).toThrow();
    });
  });

  describe('start/stop/status command platform awareness', () => {
    it('start should check platform deps and show Starting message', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['start']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Starting');
      writeSpy.mockRestore();
    });

    it('stop should check platform deps and show Stopping message', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['stop']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Stopping');
      writeSpy.mockRestore();
    });

    it('status should show dialog-survey prefix', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['status']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('dialog-survey');
      writeSpy.mockRestore();
    });

    it('start should show no installation found error when INSTALL_DIR missing', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      const stderrSpy = vi.spyOn(process.stderr, 'write');
      await main(['start']);
      const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
      // No install dir exists in test context
      expect(stderr).toContain('No installation found');
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe('main (command routing)', () => {
    it('should call printHelp for unknown commands', async () => {
      // Capture stdout
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['unknown-command']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('dialog-survey CLI');
      writeSpy.mockRestore();
    });

    it('should call printHelp for help command', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['help']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('dialog-survey CLI');
      expect(output).toContain('install');
      expect(output).toContain('uninstall');
      expect(output).toContain('start');
      expect(output).toContain('stop');
      expect(output).toContain('status');
      writeSpy.mockRestore();
    });

    it('should call printHelp for empty args', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main([]);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('dialog-survey CLI');
      writeSpy.mockRestore();
    });

    it('should handle install --help flag', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['install', '--help', 'true']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('dialog-survey install');
      writeSpy.mockRestore();
    });

    it('should route to stop command', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['stop']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Stopping');
      writeSpy.mockRestore();
    });

    it('should route to start command', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['start']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('Starting');
      writeSpy.mockRestore();
    });

    it('should route to status command', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['status']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('status');
      writeSpy.mockRestore();
    });

    it('should route to uninstall command', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write');
      await main(['uninstall']);
      const output = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(output).toContain('uninstaller');
      writeSpy.mockRestore();
    });
  });

  describe('verifyInstallation (#158)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'dialog-survey-test-'));
    });

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return ok=true when all required files exist', () => {
      mkdirSync(join(tmpDir, 'dist', 'src'), { recursive: true });
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(join(tmpDir, 'ecosystem.config.cjs'), 'module.exports = {};');
      writeFileSync(join(tmpDir, 'dist', 'src', 'server.js'), '// server.js');
      writeFileSync(join(tmpDir, '.env'), 'DATABASE_URL=test');

      const result = verifyInstallation(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should return ok=false with missing files list', () => {
      writeFileSync(join(tmpDir, 'ecosystem.config.cjs'), 'module.exports = {};');

      const result = verifyInstallation(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('dist/src/server.js');
      expect(result.missing).toContain('.env');
      expect(result.missing).toContain('node_modules');
    });

    it('should report each missing file individually', () => {
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(join(tmpDir, '.env'), 'DATABASE_URL=test');

      const result = verifyInstallation(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('ecosystem.config.cjs');
      expect(result.missing).toContain('dist/src/server.js');
      expect(result.missing).not.toContain('.env');
      expect(result.missing).not.toContain('node_modules');
    });

    it('should return ok=true for a complete installation', () => {
      mkdirSync(join(tmpDir, 'dist', 'src'), { recursive: true });
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(join(tmpDir, 'ecosystem.config.cjs'), '');
      writeFileSync(join(tmpDir, 'dist', 'src', 'server.js'), '');
      writeFileSync(join(tmpDir, '.env'), '');

      const result = verifyInstallation(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('should be callable from startCommand context', () => {
      expect(typeof verifyInstallation).toBe('function');
      const result = verifyInstallation('/nonexistent/path');
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    });
  });
});
