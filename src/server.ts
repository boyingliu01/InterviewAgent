import { dirname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import csrfProtection from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import nunjucks from 'nunjucks';

// Load .env early but explicitly (not via side-effect import).
// Use override only outside tests so vi.stubEnv() controls env in test runs.
dotenv.config({ override: process.env['NODE_ENV'] !== 'test' });
import cron from 'node-cron';
import { adminTemplatesRoutes } from './api/admin-templates.js';
import { analysisRoutes } from './api/analysis.js';
import { healthRoutes } from './api/health.js';
import { interviewPlanRoutes } from './api/plans.js';
import { templateRoutes } from './api/templates.js';
import { DEFAULT_SESSION_MAX_AGE } from './config/constants.js';
import { DingTalkMessageSender } from './integrations/dingtalk/message-sender.js';
import { DingTalkStreamClient } from './integrations/dingtalk/stream-client.js';
import { tokenManager } from './integrations/dingtalk/token-manager.js';
import { InterviewRepository } from './repositories/interview.repository.js';
import { TemplateRepository } from './repositories/template.repository.js';
import { adminAuthRoutes } from './routes/admin-auth.js';
import { AnalysisService } from './services/analysis.service.js';
import { AnalyticsService } from './services/analytics.service.js';
import { AuditCleanupService } from './services/audit-cleanup.service.js';
import { ExportService } from './services/export.service.js';
import { InterviewPlanService } from './services/interview-plan.service.js';
import { type StreamMessage, processStreamMessage } from './services/stream-message.service.js';
import { error, info, warn } from './utils/logger.js';
import { renderMarkdown } from './utils/markdown.js';
import { resolveAssetRoots } from './utils/path-resolver.js';
import { createVerifyApiKey, securityMiddleware } from './utils/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_CHECK_TIMEOUT_MS = 5000;
const NODE_ENV = process.env['NODE_ENV'] || 'development';
const LOG_LEVEL = process.env['LOG_LEVEL'] || (NODE_ENV === 'production' ? 'info' : 'debug');

export async function checkDatabaseConnection(): Promise<boolean> {
  const prisma = new PrismaClient();

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database connection timeout')), DB_CHECK_TIMEOUT_MS)
      ),
    ]);
    info('Database connection OK');
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    error('Database connection FAILED', { error: errMsg });
    error('PostgreSQL must be running before starting the server');
    error('Run: sudo systemctl start postgresql');
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export async function buildApp() {
  const isProduction = NODE_ENV === 'production';

  const prodLoggerConfig: Record<string, unknown> = {
    level: LOG_LEVEL,
  };
  const devLoggerConfig: Record<string, unknown> = {
    level: LOG_LEVEL,
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  };

  const fastify = Fastify({
    logger: isProduction ? prodLoggerConfig : devLoggerConfig,
  });

  // Security: limit content-type parsing to known safe types (XML bombs, CSV injection).
  // Fastify natively handles `application/json` and `application/x-www-form-urlencoded`.
  fastify.addContentTypeParser(
    ['application/xml', 'text/xml', 'text/csv'],
    { parseAs: 'string' },
    (_req, _body, done) => {
      done(null, '');
    }
  );

  const { viewsDir, staticRoot } = resolveAssetRoots(__dirname);

  await fastify.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
  });

  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(fastifyFormbody);

  await fastify.register(fastifyMultipart, {
    limits: { fileSize: 1 * 1024 * 1024, parts: 1 },
  });

  const customNunjucks = {
    ...nunjucks,
    configure(templatesDir: string | string[], opts: Record<string, unknown>) {
      const env = nunjucks.configure(templatesDir, opts);
      env.addFilter('date', (input: Date | string | null, format?: string) => {
        if (!input) return '';
        const date = new Date(input);
        if (Number.isNaN(date.getTime())) return '';
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const HH = String(date.getHours()).padStart(2, '0');
        const MM = String(date.getMinutes()).padStart(2, '0');

        if (format === 'Y-m-d H:i') return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
        return `${yyyy}-${mm}-${dd}`;
      });
      env.addFilter('markdown', (input: string | null | undefined) => renderMarkdown(input));
      return env;
    },
  };

  await fastify.register(fastifyView, {
    engine: { nunjucks: customNunjucks as unknown as typeof nunjucks },
    templates: viewsDir,
    options: {
      autoescape: true,
      noCache: true,
    },
  });

  const prisma = new PrismaClient();
  const templateRepo = new TemplateRepository(prisma);
  const streamClient = DingTalkStreamClient.fromEnv();
  const interviewPlanService = new InterviewPlanService(
    prisma,
    undefined,
    streamClient,
    tokenManager
  );
  const interviewRepo = new InterviewRepository(prisma);
  const analysisService = new AnalysisService(prisma);
  const analyticsService = new AnalyticsService(prisma);
  const exportService = new ExportService(prisma);

  await securityMiddleware(fastify, prisma);

  const sessionSecret = process.env['SESSION_SECRET'];
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  const sessionSalt = process.env['SESSION_SALT'];
  if (!sessionSalt) {
    throw new Error('SESSION_SALT environment variable is required');
  }

  await fastify.register(secureSession, {
    secret: sessionSecret,
    salt: Buffer.from(sessionSalt, 'hex'),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: Number(process.env['SESSION_MAX_AGE']) || DEFAULT_SESSION_MAX_AGE,
    },
  });

  await fastify.register(csrfProtection, {
    cookieOpts: {
      path: '/',
      httpOnly: false,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
    },
  });

  await fastify.register(adminAuthRoutes);

  // Rate limiting — skip in test environment since fastify.inject() bypasses the hook
  if (NODE_ENV !== 'test') {
    await fastify.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)} seconds`,
      }),
    });
  }

  // Content-Security-Policy header
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; " +
        "img-src 'self' data:; " +
        "font-src 'self'; " +
        "connect-src 'self'"
    );
    done(null, payload);
  });

  // Schedule daily audit log cleanup at 2:00 AM
  const auditCleanup = new AuditCleanupService(prisma);
  cron.schedule('0 2 * * *', async () => {
    try {
      await auditCleanup.cleanupOldLogs(90);
    } catch (err) {
      error('Audit cleanup cron job failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  info('Audit cleanup cron scheduled (daily at 2:00 AM)');

  const verifyApiKey = createVerifyApiKey(prisma);

  await fastify.register(healthRoutes, { prisma });

  await fastify.register(async (api) => {
    api.addHook('preHandler', verifyApiKey);
    await api.register(interviewPlanRoutes, { interviewPlanService, prisma });
    await api.register(templateRoutes, { templateRepo, prisma });
    await api.register(analysisRoutes, { prisma });
  });

  await fastify.register(adminTemplatesRoutes, {
    templateRepo,
    interviewPlanService,
    interviewRepo,
    analysisService,
    analyticsService,
    exportService,
    prisma,
  });

  return { fastify, prisma };
}

export async function startServer() {
  const dbOk = await checkDatabaseConnection();
  if (!dbOk) {
    process.exit(1);
  }

  const { fastify: app, prisma } = await buildApp();

  try {
    await app.listen({
      port: Number(process.env['PORT']) || 3001,
      host: process.env['HOST'] || '0.0.0.0',
    });

    const sender = new DingTalkMessageSender();
    const stalledInterviews = await prisma.interview.findMany({
      where: { status: { in: ['ACTIVE', 'PROCESSING'] } },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    for (const iv of stalledInterviews) {
      const lastMsg = iv.messages[0];
      if (!lastMsg || lastMsg.role !== 'assistant') continue;
      info('Resending unsent message on startup', {
        interviewId: iv.id,
        userId: iv.userId,
      });
      sender.sendTextMessage([iv.userId], lastMsg.content).catch((e: unknown) => {
        error('Failed to resend on startup', {
          interviewId: iv.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }

    const clientId = process.env['DINGTALK_CLIENT_ID'];
    const clientSecret = process.env['DINGTALK_CLIENT_SECRET'];
    const agentId = process.env['DINGTALK_AGENT_ID'];

    if (clientId && clientSecret && agentId) {
      const client = DingTalkStreamClient.fromEnv();

      client.on('connected', () => {
        info('DingTalk Stream connected');
      });

      client.on('message', (message: unknown) => {
        info('Received DingTalk message', {
          topic: (message as StreamMessage)?.headers?.topic,
          messageId: (message as StreamMessage)?.headers?.messageId,
        });
        processStreamMessage(message as StreamMessage, prisma).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          error('Failed to process message', { error: errMsg });
        });
      });

      client.on('error', (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        error('DingTalk Stream error', { error: errMsg });
      });

      client.on('disconnected', () => {
        info('DingTalk Stream disconnected');
      });

      // Non-blocking DingTalk connection — server stays up even if DingTalk fails
      client.connect().catch((err: unknown) => {
        warn('DingTalk Stream connection failed, server continues without it', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      info('DingTalk Stream mode not configured, skipping WebSocket connection');
    }

    const gracefulShutdown = async (signal: string) => {
      info(`Received ${signal}, shutting down gracefully`);
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    return app;
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const normalizedArg = normalize(process.argv[1]);
if (import.meta.url === pathToFileURL(normalizedArg).href) {
  startServer();
}
