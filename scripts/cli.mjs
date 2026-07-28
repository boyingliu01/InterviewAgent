#!/usr/bin/env node

/**
 * dialog-survey CLI — npx-based install and lifecycle management
 *
 * Commands: install, uninstall, start, stop, status, help
 * Zero external dependencies — pure Node.js ESM
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ─── Constants ───────────────────────────────────────────────────────────────

const INSTALL_DIR = join(homedir(), '.dialog-survey');
const PM2_APP_NAME = 'dialog-survey';
const HEALTH_URL = 'http://localhost:3001/health';
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const MIN_NODE_MAJOR = 20;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Execute a shell command synchronously, returning stdout.
 * Throws with stderr on failure.
 */
export function exec(cmd, options = {}) {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/**
 * Print a message to stdout.
 */
function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/**
 * Print an error message to stderr.
 */
function logError(msg) {
  process.stderr.write(`Error: ${msg}\n`);
}

/**
 * Start the dialog-survey service via the appropriate process manager.
 * Uses PM2 on Linux/macOS, falls back to direct node on Windows.
 * Shared between installCommand and startCommand.
 */
async function startViaServiceManager() {
  const platformCheck = checkPlatformDeps();
  if (platformCheck.serviceManager === 'pm2') {
    try {
      exec(`pm2 start ecosystem.config.cjs --name ${PM2_APP_NAME} --env production`, {
        cwd: INSTALL_DIR,
      });
      log('PM2 process started ✓');
    } catch (err) {
      logError(`PM2 start failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    log('Starting service directly (PM2 is unstable on Windows, using direct node)...');
    try {
      startViaNode(INSTALL_DIR);
      log('Direct process started ✓');
    } catch (err) {
      logError(`Direct start failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

/**
 * Parse CLI arguments into a command name and a flags object.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ command: string, flags: Record<string, string>, positional: string[] }}
 */
export function parseArgs(argv) {
  const command = argv[0] || 'help';
  const flags = {};
  const positional = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

// ─── Config Generation ───────────────────────────────────────────────────────

/**
 * Generate config object from CLI flags.
 *
 * @param {Record<string, string>} flags
 * @returns {Record<string, string>}
 */
export function generateConfigFromFlags(flags) {
  return {
    DATABASE_URL: flags['db-url'] || '',
    LLM_API_KEY: flags['llm-api-key'] || '',
    LLM_BASE_URL: flags['llm-base-url'] || '',
    LLM_MODEL: flags['llm-model'] || '',
    DINGTALK_CLIENT_ID: flags['dingtalk-client-id'] || '',
    DINGTALK_CLIENT_SECRET: flags['dingtalk-client-secret'] || '',
    DINGTALK_AGENT_ID: flags['dingtalk-agent-id'] || '',
  };
}

/**
 * Check if all required config values are present.
 *
 * @param {Record<string, string>} config
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateConfig(config) {
  const required = [
    'DATABASE_URL',
    'DINGTALK_CLIENT_ID',
    'DINGTALK_CLIENT_SECRET',
    'DINGTALK_AGENT_ID',
  ];
  const missing = required.filter((key) => !config[key]);
  return { valid: missing.length === 0, missing };
}

// ─── Interactive Prompts ─────────────────────────────────────────────────────

/**
 * Prompt user for a single value via readline.
 *
 * @param {string} question
 * @param {import("node:readline").Interface} rl
 * @returns {Promise<string>}
 */
function prompt(question, rl) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Collect config interactively via readline prompts.
 *
 * @returns {Promise<Record<string, string>>}
 */
export async function collectConfigInteractive() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    log('\n📋 dialog-survey configuration\n');

    const config = {
      DATABASE_URL: await prompt('Database URL (PostgreSQL connection string): ', rl),
      LLM_API_KEY: await prompt('LLM API Key (leave empty for local LLM): ', rl),
      LLM_BASE_URL: await prompt('LLM Base URL (optional, e.g. http://localhost:11434/v1): ', rl),
      LLM_MODEL: await prompt('LLM Model (optional, e.g. qwen2.5): ', rl),
      DINGTALK_CLIENT_ID: await prompt('DingTalk Client ID: ', rl),
      DINGTALK_CLIENT_SECRET: await prompt('DingTalk Client Secret: ', rl),
      DINGTALK_AGENT_ID: await prompt('DingTalk Agent ID: ', rl),
    };

    return config;
  } finally {
    rl.close();
  }
}

// ─── Prerequisites ───────────────────────────────────────────────────────────

/**
 * Check Node.js version >= 20.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(version.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message: `Node.js >= ${MIN_NODE_MAJOR} required (current: ${process.versions.node})`,
    };
  }
  return { ok: true, message: `Node.js ${process.versions.node} ✓` };
}

/**
 * Check if PostgreSQL is reachable using the given DATABASE_URL.
 * Uses a TCP socket connect instead of pg_isready for cross-platform
 * support (pg_isready is unavailable on Windows by default).
 * @param {string} databaseUrl
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function checkPostgres(databaseUrl, timeoutMs = 3000) {
  if (!databaseUrl) {
    return { ok: false, message: 'DATABASE_URL not provided' };
  }
  try {
    const url = new URL(databaseUrl);
    const host = url.hostname;
    const port = url.port || '5432';

    await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const cleanup = () => {
        socket.destroy();
      };
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        cleanup();
        resolve();
      });
      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });
      socket.on('timeout', () => {
        cleanup();
        reject(new Error('timeout'));
      });
      socket.connect(Number(port), host);
    });

    return { ok: true, message: `PostgreSQL ${host}:${port} ✓` };
  } catch {
    return {
      ok: false,
      message:
        'PostgreSQL not reachable. Ensure PostgreSQL is running and DATABASE_URL is correct.',
    };
  }
}

/**
 * Check if port 3001 is available.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkPort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({
          ok: false,
          message: 'Port 3001 is already in use. Stop the existing service first.',
        });
      } else {
        resolve({ ok: false, message: `Port check failed: ${err.message}` });
      }
    });
    server.once('listening', () => {
      server.close(() => {
        resolve({ ok: true, message: 'Port 3001 available ✓' });
      });
    });
    server.listen(3001, '0.0.0.0');
  });
}

/**
 * Run all prerequisite checks.
 * @param {string} databaseUrl
 * @returns {Promise<{ ok: boolean, messages: string[] }>}
 */
export async function checkPrerequisites(databaseUrl, options = {}) {
  const messages = [];
  let allOk = true;

  const nodeCheck = checkNodeVersion();
  messages.push(nodeCheck.message);
  if (!nodeCheck.ok) allOk = false;

  const pgCheck = await checkPostgres(databaseUrl);
  messages.push(pgCheck.message);
  if (!pgCheck.ok) allOk = false;

  if (!options.skipPortCheck) {
    const portCheck = await checkPort();
    messages.push(portCheck.message);
    if (!portCheck.ok) allOk = false;
  }

  return { ok: allOk, messages };
}

/**
 * Verify installation integrity by checking required files exist.
 * @param {string} installDir
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function verifyInstallation(installDir) {
  const requiredFiles = [
    'ecosystem.config.cjs',
    'dist/src/server.js',
    '.env',
    'node_modules',
  ];

  const missing = [];
  for (const file of requiredFiles) {
    if (!existsSync(join(installDir, file))) {
      missing.push(file);
    }
  }

  return { ok: missing.length === 0, missing };
}

// ─── PM2 Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if PM2 is installed and accessible.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkPm2() {
  try {
    exec('pm2 --version');
    return { ok: true, message: 'PM2 found ✓' };
  } catch {
    return {
      ok: false,
      message: 'PM2 is not installed. Install it with: npm install -g pm2',
    };
  }
}

// ─── Cross-platform helpers ──────────────────────────────────────────────────

/**
 * Check if current platform is Windows.
 * @returns {boolean}
 */
export function isWindows() {
  return platform() === 'win32';
}

/**
 * Platform-aware dependency check.
 * - Linux: check PM2
 * - Windows: check tsc (TypeScript compiler)
 * @returns {{ ok: boolean, message: string, serviceManager: 'pm2' | 'direct' }}
 */
export function checkPlatformDeps() {
  if (isWindows()) {
    try {
      exec('npx -y tsc --version');
      return {
        ok: true,
        message: 'tsc found ✓ (Windows: will start via direct node)',
        serviceManager: 'direct',
      };
    } catch {
      return {
        ok: false,
        message: 'tsc not found. Ensure TypeScript is installed: npm install',
        serviceManager: 'direct',
      };
    }
  } else {
    const pm2Check = checkPm2();
    return {
      ok: pm2Check.ok,
      message: pm2Check.message,
      serviceManager: pm2Check.ok ? 'pm2' : 'direct',
    };
  }
}

/**
 * Start service directly via node (no PM2, used on Windows).
 * @param {string} cwd
 */
export function startViaNode(cwd) {
  exec('node dist/src/server.js &', { cwd });
}

/**
 * Stop service started directly (no PM2).
 * @returns {boolean}
 */
export function stopDirectService() {
  try {
    exec('pkill -f "node dist/src/server"');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a direct node service is running.
 * @returns {boolean}
 */
export function isDirectServiceRunning() {
  try {
    const result = exec('pgrep -f "node dist/src/server"');
    return result.length > 0;
  } catch {
    return false;
  }
}

// ─── Health Check ────────────────────────────────────────────────────────────

/**
 * Poll the health endpoint until it responds or timeout.
 * @param {string} url
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
export function waitForHealth(
  url = HEALTH_URL,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_POLL_INTERVAL_MS
) {
  return new Promise((resolve) => {
    const start = Date.now();

    const poll = () => {
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }

      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve(true);
        } else {
          res.resume();
          setTimeout(poll, intervalMs);
        }
      });

      req.on('error', () => {
        setTimeout(poll, intervalMs);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, intervalMs);
      });
    };

    poll();
  });
}

// ─── .env Generation ─────────────────────────────────────────────────────────

/**
 * Generate .env file content from config.
 * @param {Record<string, string>} config
 * @returns {string}
 */
export function generateEnvContent(config) {
  const lines = [
    '# Generated by dialog-survey CLI',
    'NODE_ENV=production',
    'PORT=3001',
    'HOST=0.0.0.0',
    '',
    `DATABASE_URL="${config.DATABASE_URL}"`,
    '',
    '# LLM Configuration (OpenAI-compatible — local or cloud)',
    `LLM_API_KEY=${config.LLM_API_KEY || ''}`,
  ];
  if (config.LLM_BASE_URL) {
    lines.push(`LLM_BASE_URL=${config.LLM_BASE_URL}`);
  }
  if (config.LLM_MODEL) {
    lines.push(`LLM_MODEL=${config.LLM_MODEL}`);
  }
  lines.push(
    '',
    `DINGTALK_CLIENT_ID=${config.DINGTALK_CLIENT_ID}`,
    `DINGTALK_CLIENT_SECRET=${config.DINGTALK_CLIENT_SECRET}`,
    `DINGTALK_AGENT_ID=${config.DINGTALK_AGENT_ID}`,
    '',
    '# Security',
    `ENCRYPTION_KEY=${crypto.randomBytes(16).toString('hex')}`,
    `ADMIN_API_KEY=${crypto.randomBytes(16).toString('hex')}`,
    '',
    '# Logging',
    'LOG_LEVEL=info',
    ''
  );
  return lines.join('\n');
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Install command — interactive or non-interactive installation.
 * @param {Record<string, string>} flags
 */
export async function installCommand(flags) {
  log('🚀 dialog-survey installer\n');

  // Step 1: Collect config
  let config;
  const fromFlags = generateConfigFromFlags(flags);
  const flagValidation = validateConfig(fromFlags);

  if (flagValidation.valid) {
    config = fromFlags;
    log('Using configuration from CLI flags.\n');
  } else if (flags.help) {
    printInstallHelp();
    return;
  } else {
    // Detect if any non-interactive flags were provided
    const PROVIDED_FLAGS = [
      'db-url', 'llm-api-key', 'llm-base-url', 'llm-model',
      'dingtalk-client-id', 'dingtalk-client-secret', 'dingtalk-agent-id',
    ];
    const anyFlagProvided = PROVIDED_FLAGS.some((f) => flags[f] !== undefined);

    if (anyFlagProvided) {
      logError(
        `Non-interactive install requires all flags. Missing: ${flagValidation.missing.join(', ')}`
      );
      log('Usage: npx dialog-survey install \\');
      log('  --db-url "postgresql://..." \\');
      log('  --dingtalk-client-id "xxx" \\');
      log('  --dingtalk-client-secret "xxx" \\');
      log('  --dingtalk-agent-id "xxx"');
      log('  [--llm-api-key "xxx"]');
      log('  [--llm-base-url "http://localhost:11434/v1"]');
      log('  [--llm-model "qwen2.5"]');
      log('  [--skip-port-check]');
      process.exitCode = 1;
      return;
    }

    log('No flags provided. Starting interactive mode...\n');
    config = await collectConfigInteractive();
    const interactiveValidation = validateConfig(config);
    if (!interactiveValidation.valid) {
      logError(`Missing required config: ${interactiveValidation.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  // Step 2: Check prerequisites
  log('Checking prerequisites...');
  const prereqs = await checkPrerequisites(config.DATABASE_URL, {
    skipPortCheck: flags['skip-port-check'] === 'true',
  });
  for (const msg of prereqs.messages) {
    log(`  ${msg}`);
  }
  if (!prereqs.ok) {
    logError('Prerequisites check failed. Fix the issues above and retry.');
    process.exitCode = 1;
    return;
  }

  // Step 3: Check platform-specific deps
  const platformCheck = checkPlatformDeps();
  log(`  ${platformCheck.message}`);
  if (!platformCheck.ok) {
    logError(platformCheck.message);
    process.exitCode = 1;
    return;
  }

  // Step 4: Create install directory
  log('\nSetting up installation directory...');
  const sourceDir = join(__dirname, '..');
  await mkdir(INSTALL_DIR, { recursive: true });
  log(`  Created ${INSTALL_DIR}`);

  // Step 5: Copy package files
  log('Copying package files...');
  const filesToCopy = [
    'package.json',
    'dist',
    'prisma',
    'src/views',
    'public',
    'ecosystem.config.cjs',
  ];
  for (const file of filesToCopy) {
    const src = join(sourceDir, file);
    const dest = join(INSTALL_DIR, file);
    if (existsSync(src)) {
      await cp(src, dest, { recursive: true });
      log(`  Copied ${file}`);
    }
  }

  // Step 6: Generate .env
  log('Generating .env file...');
  const envContent = generateEnvContent(config);
  await writeFile(join(INSTALL_DIR, '.env'), envContent, 'utf-8');
  log(`  Created ${INSTALL_DIR}/.env`);

  // Step 7: npm install
  // Use npm install instead of npm ci because package-lock.json is never
  // included in npm published packages by design. npm install generates
  // its own lock file from package.json.
  log('Installing dependencies (npm install --omit=dev)...');
  try {
    exec('npm install --omit=dev --ignore-scripts', { cwd: INSTALL_DIR });
    log('  Dependencies installed ✓');
  } catch (err) {
    logError(`npm install failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Step 7.5: Install Playwright browser for PDF export
  // This is non-fatal — PDF export is an optional feature.
  log('Installing Playwright browser for PDF export...');
  try {
    exec('npx playwright install chromium', { cwd: INSTALL_DIR });
    log('  Playwright browser installed ✓');
  } catch {
    log('  ⚠ Playwright browser installation failed (PDF export unavailable)');
    log("    Run 'npx playwright install chromium' manually if PDF export is needed.");
  }

  // Step 8: prisma generate
  log('Generating Prisma client...');
  try {
    exec('npx prisma generate', { cwd: INSTALL_DIR });
    log('  Prisma client generated ✓');
  } catch (err) {
    logError(`prisma generate failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Step 9: prisma db push
  log('Pushing schema to database...');
  try {
    exec('npx prisma db push', { cwd: INSTALL_DIR });
    log('  Schema pushed ✓');
  } catch (err) {
    logError(`prisma db push failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Step 10: Start service (platform-aware)
  // Note: No build step needed — dist/ is pre-compiled in the npm package.
  await startViaServiceManager();

  // Step 12: Wait for health
  log('Waiting for health check...');
  const healthy = await waitForHealth();
  if (healthy) {
    log('  Health check passed ✓');
    log('\n✅ dialog-survey installed and running successfully!');
    log(`   Install dir: ${INSTALL_DIR}`);
    log(`   Health:      ${HEALTH_URL}`);
    if (platformCheck.serviceManager === 'pm2') {
      log(`   Logs:        pm2 logs ${PM2_APP_NAME}`);
    }
    log('   Stop:        npx dialog-survey stop');
    log('   Status:      npx dialog-survey status');
  } else {
    logError('Health check timed out after 30s. Service may still be starting.');
    if (platformCheck.serviceManager === 'pm2') {
      log(`   Check logs: pm2 logs ${PM2_APP_NAME}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Uninstall command — remove installation.
 * @param {Record<string, string>} flags
 */
export async function uninstallCommand(flags) {
  log('🗑️  dialog-survey uninstaller\n');

  // Step 1: Stop PM2 process
  const pm2Check = checkPm2();
  if (pm2Check.ok) {
    log('Stopping PM2 process...');
    try {
      exec(`pm2 delete ${PM2_APP_NAME}`);
      log('  PM2 process removed ✓');
    } catch {
      log('  No PM2 process found (may already be removed)');
    }
  }

  // Step 2: Optional DB removal
  if (flags['remove-db'] === 'true') {
    log('\n⚠️  Database removal requested.');
    log('To drop the database, run:');
    log('  psql -c "DROP DATABASE IF EXISTS dialog_survey;"');
    log('  (adjust connection parameters as needed)\n');
  }

  // Step 3: Remove install directory
  if (existsSync(INSTALL_DIR)) {
    log(`Removing ${INSTALL_DIR}...`);
    await rm(INSTALL_DIR, { recursive: true, force: true });
    log('  Installation directory removed ✓');
  } else {
    log('  No installation directory found.');
  }

  log('\n✅ dialog-survey uninstalled successfully.');
}

/**
 * Start command — start service via PM2.
 */
export async function startCommand() {
  log('▶️  Starting dialog-survey...\n');

  if (!existsSync(join(INSTALL_DIR, 'ecosystem.config.cjs'))) {
    logError(`No installation found at ${INSTALL_DIR}. Run 'npx dialog-survey install' first.`);
    process.exitCode = 1;
    return;
  }

  const verification = verifyInstallation(INSTALL_DIR);
  if (!verification.ok) {
    logError(`Installation is incomplete. Missing: ${verification.missing.join(', ')}`);
    logError("Run 'npx dialog-survey install' to repair the installation.");
    process.exitCode = 1;
    return;
  }

  await startViaServiceManager();
  log('Waiting for health check...');
  const healthy = await waitForHealth();
  if (healthy) {
    log('✅ dialog-survey is running.');
    log(`   Health: ${HEALTH_URL}`);
  } else {
    logError('Health check timed out. Check logs for details.');
    process.exitCode = 1;
  }
}

/**
 * Stop command — stop service via PM2.
 */
export async function stopCommand() {
  log('⏹  Stopping dialog-survey...\n');

  const platformCheck = checkPlatformDeps();

  if (platformCheck.serviceManager === 'pm2') {
    try {
      exec(`pm2 stop ${PM2_APP_NAME}`);
      log('✅ dialog-survey stopped.');
    } catch (err) {
      logError(`PM2 stop failed: ${err.message}`);
      process.exitCode = 1;
    }
  } else {
    const stopped = stopDirectService();
    if (stopped) {
      log('✅ dialog-survey stopped.');
    } else {
      log('No running dialog-survey process found.');
    }
  }
}

/**
 * Status command — show service status.
 */
export async function statusCommand() {
  log('📊 dialog-survey status\n');

  const platformCheck = checkPlatformDeps();

  if (platformCheck.serviceManager === 'pm2') {
    try {
      const pm2Status = exec('pm2 jlist');
      const processes = JSON.parse(pm2Status);
      const app = processes.find((p) => p.name === PM2_APP_NAME);

      if (!app) {
        log('  PM2 process: not found');
        log('  Status: stopped\n');
        log("  Run 'npx dialog-survey start' to start the service.");
        return;
      }

      const pm2StatusText = app.pm2_env?.status || 'unknown';
      log(`  PM2 process: ${pm2StatusText}`);
      log(`  PID: ${app.pid || 'N/A'}`);
      log(
        `  Uptime: ${app.pm2_env?.pm_uptime ? new Date(app.pm2_env.pm_uptime).toISOString() : 'N/A'}`
      );
      log(`  Restarts: ${app.pm2_env?.restart_time ?? 'N/A'}`);
      log(
        `  Memory: ${app.monit?.memory ? `${Math.round(app.monit.memory / 1024 / 1024)}MB` : 'N/A'}`
      );
    } catch (err) {
      logError(`PM2 status check failed: ${err.message}`);
    }
  } else {
    const running = isDirectServiceRunning();
    if (running) {
      log('  Direct process: running');
    } else {
      log('  Direct process: not found');
      log('  Status: stopped\n');
      log("  Run 'npx dialog-survey start' to start the service.");
      return;
    }
  }

  // Check health endpoint (shared by both platforms)
  const healthy = await waitForHealth(HEALTH_URL, 5000, 500);
  if (healthy) {
    log(`  Health: ${HEALTH_URL} ✓`);
    log('\n  Status: running ✅');
  } else {
    log(`  Health: ${HEALTH_URL} ✗`);
    log('\n  Status: degraded ⚠️');
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function printHelp() {
  log(`
dialog-survey CLI — npx-based install and lifecycle management

Usage:
  npx dialog-survey <command> [options]

Commands:
  install     Install dialog-survey (interactive or non-interactive)
  uninstall   Remove dialog-survey installation
  start       Start the dialog-survey service
  stop        Stop the dialog-survey service
  status      Show service status
  help        Show this help message

Install Options:
  --db-url <url>                  PostgreSQL connection string (required)
  --llm-api-key <key>             LLM API key (required, or leave empty for local setup)
  --llm-base-url <url>            LLM base URL (optional, e.g. http://localhost:11434/v1)
  --llm-model <name>              LLM model name (optional, e.g. qwen2.5)
  --dingtalk-client-id <id>       DingTalk client ID (required)
  --dingtalk-client-secret <sec>  DingTalk client secret (required)
  --dingtalk-agent-id <id>        DingTalk agent ID (required)

Uninstall Options:
  --remove-db                     Also print instructions to drop the database

Examples:
  # Interactive install
  npx dialog-survey install

  # Non-interactive install
  npx dialog-survey install \\
    --db-url "postgresql://user:pass@localhost:5432/db" \\
    --llm-api-key "sk-xxx" \\
    --dingtalk-client-id "xxx" \\
    --dingtalk-client-secret "xxx" \\
    --dingtalk-agent-id "xxx"

  # Lifecycle management
  npx dialog-survey start
  npx dialog-survey stop
  npx dialog-survey status
  npx dialog-survey uninstall
`);
}

function printInstallHelp() {
  log(`
dialog-survey install — Install dialog-survey

Usage:
  npx dialog-survey install [options]

Options:
  --db-url <url>                  PostgreSQL connection string (required)
  --llm-api-key <key>             LLM API key (optional for local LLM)
  --llm-base-url <url>            LLM base URL (optional, e.g. http://localhost:11434/v1)
  --llm-model <name>              LLM model name (optional, e.g. qwen2.5)
  --dingtalk-client-id <id>       DingTalk client ID (required)
  --dingtalk-client-secret <sec>  DingTalk client secret (required)
  --dingtalk-agent-id <id>        DingTalk agent ID (required)

If any required option is missing, the installer falls back to interactive mode.

Examples:
  # Interactive — prompts for each value
  npx dialog-survey install

  # Non-interactive — all values via flags
  npx dialog-survey install \\
    --db-url "postgresql://user:pass@localhost:5432/db" \\
    --llm-api-key "sk-xxx" \\
    --dingtalk-client-id "xxx" \\
    --dingtalk-client-secret "xxx" \\
    --dingtalk-agent-id "xxx"
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  switch (command) {
    case 'install':
      await installCommand(flags);
      break;
    case 'uninstall':
      await uninstallCommand(flags);
      break;
    case 'start':
      await startCommand();
      break;
    case 'stop':
      await stopCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    default:
      printHelp();
      break;
  }
}

// Run if invoked directly
// Use path-based check instead of import.meta.resolve() which may return
// non-file URLs on Node.js >= 26, causing ERR_INVALID_URL_SCHEME.
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('cli.mjs') ||
    process.argv[1].endsWith('dialog-survey') ||
    process.argv[1].endsWith(`dialog-survey${process.platform === 'win32' ? '.cmd' : ''}`));

if (isMain) {
  main(process.argv.slice(2));
}
