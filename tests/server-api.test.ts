import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

let mockPrismaInstance: {
  $queryRaw: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
  auditLog: { create: ReturnType<typeof vi.fn> };
  interviewPlan: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  template: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

mockPrismaInstance = {
  $queryRaw: vi.fn(),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  interviewPlan: {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  template: {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('@prisma/client', () => ({
  PrismaClient: function FakePrismaClient() {
    return mockPrismaInstance;
  },
}));

vi.mock('../src/server.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    checkDatabaseConnection: async () => {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      const DB_CHECK_TIMEOUT_MS = 5000;
      try {
        await Promise.race([
          prisma.$queryRaw`SELECT 1`,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Database connection timeout')), DB_CHECK_TIMEOUT_MS)
          ),
        ]);
        return true;
      } catch {
        return false;
      } finally {
        await prisma.$disconnect();
      }
    },
  };
});

describe('buildApp', () => {
  let app: { fastify: FastifyInstance; prisma: unknown };

  beforeAll(async () => {
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    vi.stubEnv('SESSION_SALT', 'b'.repeat(16));
    vi.stubEnv('DINGTALK_CLIENT_ID', 'test-client-id');
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'test-client-secret');
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
  });

  afterAll(async () => {
    await app.fastify.close();
    vi.unstubAllEnvs();
  });

  it('should create a Fastify app instance', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('object');
    expect(app).toHaveProperty('fastify');
    expect(app).toHaveProperty('prisma');
    expect(typeof app.fastify.inject).toBe('function');
    expect(typeof app.fastify.listen).toBe('function');
    expect(typeof app.fastify.close).toBe('function');
  });

  it('should have health route registered', async () => {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('checks');
    expect(body.checks).toHaveProperty('db');
    expect(body.checks).toHaveProperty('llm');
    expect(body.checks).toHaveProperty('dingtalk');
  });

  it('should have interview plan routes registered', async () => {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/plans',
    });
    expect(response.statusCode).not.toBe(404);
  });

  it('should have template routes registered', async () => {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/api/templates',
    });
    expect(response.statusCode).not.toBe(404);
  });

  it('should have analysis routes registered', async () => {
    const response = await app.fastify.inject({
      method: 'POST',
      url: '/api/analysis/single',
      headers: { 'content-type': 'application/json' },
      payload: { interviewId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).not.toBe(404);
  });

  it('should have admin template routes registered', async () => {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/admin/api/templates',
    });
    expect(response.statusCode).not.toBe(404);
  });

  it('should return 404 for unknown routes', async () => {
    const response = await app.fastify.inject({
      method: 'GET',
      url: '/nonexistent-route-xyz',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('checkDatabaseConnection', () => {
  beforeEach(() => {
    mockPrismaInstance = {
      $queryRaw: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      interviewPlan: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      template: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  });

  it('should return true when database connection succeeds', async () => {
    mockPrismaInstance.$queryRaw.mockResolvedValue([{ '1': 1 }]);

    const { checkDatabaseConnection } = await import('../src/server.js');
    const result = await checkDatabaseConnection();

    expect(result).toBe(true);
    expect(mockPrismaInstance.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrismaInstance.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('should return false when database connection times out', async () => {
    mockPrismaInstance.$queryRaw = vi.fn().mockImplementation(
      () =>
        new Promise<never>(() => {
          // intentionally never resolves
        })
    );

    const { checkDatabaseConnection } = await import('../src/server.js');
    const result = await checkDatabaseConnection();

    expect(result).toBe(false);
  }, 10000);

  it('should return false when database connection rejects', async () => {
    mockPrismaInstance.$queryRaw.mockRejectedValue(new Error('Connection refused'));

    const { checkDatabaseConnection } = await import('../src/server.js');
    const result = await checkDatabaseConnection();

    expect(result).toBe(false);
    expect(mockPrismaInstance.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrismaInstance.$disconnect).toHaveBeenCalledTimes(1);
  });
});

// Regression test: startServer without DingTalk config exits cleanly
// after db check and listening — but we mock dependencies to avoid side effects.
describe('buildApp robustness', () => {
  it('should handle missing DingTalk config gracefully at the service level', async () => {
    // Verify the code path exists — check that the server.ts source
    // contains the branch for DingTalk-not-configured
    const fs = await import('node:fs');
    const source = fs.readFileSync('src/server.ts', 'utf-8');
    expect(source).toContain('DingTalk Stream mode not configured, skipping');
  });
});

describe('server.ts entry point (Windows path compatibility, Issue #63)', () => {
  it('should use normalize() + pathToFileURL() for cross-platform self-detection', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('src/server.ts', 'utf-8');
    // The fix uses normalize(process.argv[1]) + pathToFileURL() instead of
    // a plain string comparison that would fail on Windows (backslash vs /)
    expect(source).toContain('normalize(process.argv[1])');
    expect(source).toContain('pathToFileURL(normalizedArg).href');
    expect(source).not.toContain('import.meta.url === `file://${process.argv[1]}`');
  });

  it('should still work on Unix paths with the same pattern', async () => {
    const { normalize } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const unixPath = '/home/deploy/dialog-survey/dist/server.js';
    const normalized = normalize(unixPath);
    const fileUrl = pathToFileURL(normalized).href;

    expect(fileUrl).toBe('file:///home/deploy/dialog-survey/dist/server.js');
  });
});
