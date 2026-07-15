import type {} from '@fastify/secure-session';
import type { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify/types/request.js';
import { type AdminSession, validateSession } from './session-auth.js';

const UNPROTECTED_METHODS = new Set<string>(['GET', 'HEAD', 'OPTIONS']);

export async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (UNPROTECTED_METHODS.has(request.method)) {
    return;
  }

  const adminApiKey = process.env['ADMIN_API_KEY'];

  if (!adminApiKey) {
    void reply
      .code(500)
      .type('text/html')
      .send('<div class="text-red-600">服务器配置错误：ADMIN_API_KEY 未设置</div>');
    return;
  }

  if (request.session) {
    const session = request.session.get('admin') as AdminSession | undefined;
    const maxAge = Number(process.env['SESSION_MAX_AGE'] || 28800);

    if (validateSession(session, maxAge)) {
      request.user = {
        userId: session.userId,
        role: session.role,
      };
      return;
    }
  }

  const apiKey = request.headers['x-admin-key'];

  if (apiKey === adminApiKey) {
    request.user = {
      userId: 'admin',
      role: 'admin',
    };
    return;
  }

  void reply
    .code(401)
    .type('text/html')
    .send('<div class="text-red-600">认证失败：无效的 Admin API Key</div>');
}
