import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminSession } from '../middleware/session-auth.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    admin?: AdminSession;
  }
}

export async function adminAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/login', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.view('admin/login.njk', {
      error: null,
    });
  });

  fastify.post('/admin/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = request.body as { username: string; password: string };

    const expectedUsername = process.env['ADMIN_USERNAME'];
    const expectedHash = process.env['ADMIN_PASSWORD_HASH'];

    if (!expectedUsername || !expectedHash) {
      fastify.log.error('Admin credentials not configured');
      return reply.status(500).view('admin/login.njk', {
        error: '服务器配置错误：管理员凭据未设置',
      });
    }

    if (username !== expectedUsername) {
      return reply.status(401).view('admin/login.njk', {
        error: '用户名或密码错误',
      });
    }

    const isValid = await bcrypt.compare(password, expectedHash);
    if (!isValid) {
      return reply.status(401).view('admin/login.njk', {
        error: '用户名或密码错误',
      });
    }

    const session: AdminSession = {
      userId: username,
      role: 'admin',
      loginTime: Date.now(),
      lastActivity: Date.now(),
    };

    request.session.set('admin', session);

    return reply.redirect('/admin');
  });

  fastify.post('/admin/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    request.session.delete();
    return reply.redirect('/admin/login');
  });
}
