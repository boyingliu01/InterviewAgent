import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { adminAuth } from '../src/middleware/admin-auth.js';

function createMockReply(): Partial<FastifyReply> {
  const reply: Partial<FastifyReply> = {};
  reply.code = vi.fn().mockReturnValue(reply);
  reply.type = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  reply.status = vi.fn().mockReturnValue(reply);
  reply.redirect = vi.fn().mockReturnValue(reply);
  return reply;
}

function createMockRequest(
  sessionData: Record<string, unknown> | null,
  headers: Record<string, string | undefined> = {},
  method = 'POST'
): Partial<FastifyRequest> {
  return {
    method,
    session: {
      get: vi.fn().mockReturnValue(sessionData),
      delete: vi.fn(),
      set: vi.fn(),
      data: vi.fn(),
      changed: false,
      deleted: false,
      regenerate: vi.fn(),
      options: vi.fn(),
      touch: vi.fn(),
    },
    headers,
    url: '/admin/api/templates',
  };
}

describe('adminAuth middleware', () => {
  it('should allow access with valid session', async () => {
    const session = {
      userId: 'admin',
      role: 'admin' as const,
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };
    const request = createMockRequest(session);
    const reply = createMockReply();
    process.env['ADMIN_API_KEY'] = 'test-api-key';

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('should allow access with valid API key', async () => {
    const request = createMockRequest(null, { 'x-admin-key': 'test-api-key' });
    const reply = createMockReply();
    process.env['ADMIN_API_KEY'] = 'test-api-key';

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('should reject request with invalid session and no API key', async () => {
    const request = createMockRequest(null);
    const reply = createMockReply();
    process.env['ADMIN_API_KEY'] = 'test-api-key';

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.stringContaining('Admin API Key'));
  });

  it('should reject request with invalid API key', async () => {
    const request = createMockRequest(null, { 'x-admin-key': 'wrong-key' });
    const reply = createMockReply();
    process.env['ADMIN_API_KEY'] = 'test-api-key';

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('should prefer session over API key', async () => {
    const session = {
      userId: 'admin',
      role: 'admin' as const,
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };
    const request = createMockRequest(session, {
      'x-admin-key': 'test-api-key',
    });
    const reply = createMockReply();
    process.env['ADMIN_API_KEY'] = 'test-api-key';

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('should allow GET requests without authentication', async () => {
    const request = createMockRequest(null, {}, 'GET');
    const reply = createMockReply();

    await adminAuth(request as FastifyRequest, reply as FastifyReply);

    expect(reply.code).not.toHaveBeenCalled();
  });
});
