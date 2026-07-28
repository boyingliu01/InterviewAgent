// @no-test-required: E2E test infrastructure helper, exercised by E2E test files
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { TestDatabase } from '../../helpers/test-db.js';

export interface E2EServer {
  app: FastifyInstance;
  prisma: PrismaClient;
  testDb: TestDatabase;
  baseUrl: string;
  teardown: () => Promise<void>;
}

/**
 * Create a full E2E test server with real database and HTTP listener.
 * Used by Playwright E2E tests that need a real HTTP server.
 * External services (DingTalk, LLM) must have dummy env vars configured.
 */
export async function createE2EServer(port = 0): Promise<E2EServer> {
  process.env['NODE_ENV'] = 'test';
  // Set dummy env vars for auth session
  if (!process.env['SESSION_SECRET'])
    process.env['SESSION_SECRET'] = 'e2e-session-secret-key-32chars!!';
  if (!process.env['SESSION_SALT']) process.env['SESSION_SALT'] = 'e2e-session-salt';
  // Set E2E admin credentials for login tests
  if (!process.env['ADMIN_USERNAME']) process.env['ADMIN_USERNAME'] = 'e2e-admin';
  if (!process.env['ADMIN_PASSWORD_HASH'])
    process.env['ADMIN_PASSWORD_HASH'] =
      '$2a$04$/n0nx2VL1x0uOwVndrujnufaskvd7PG9fLC.MsbejxijyJmoALqAG';
  // Set dummy DingTalk env vars so DingTalkStreamClient.fromEnv() doesn't throw
  if (!process.env['DINGTALK_CLIENT_ID']) process.env['DINGTALK_CLIENT_ID'] = 'e2e-dummy-client-id';
  if (!process.env['DINGTALK_CLIENT_SECRET'])
    process.env['DINGTALK_CLIENT_SECRET'] = 'e2e-dummy-client-secret';

  const testDb = new TestDatabase();
  await testDb.setup();

  const prisma = testDb.getPrisma();

  const { buildApp } = await import('../../../src/server.js');
  const { fastify: app } = await buildApp();

  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  const baseUrl =
    typeof address === 'object' && address
      ? `http://127.0.0.1:${address.port}`
      : 'http://127.0.0.1:3001';

  return {
    app,
    prisma,
    testDb,
    baseUrl,
    teardown: async () => {
      await app.close();
      await testDb.teardown();
    },
  };
}
