import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SESSION_MAX_AGE } from '../config/constants.js';
import type { AdminSession } from '../middleware/session-auth.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    admin?: AdminSession;
  }
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function adminAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session.get('admin') as AdminSession | undefined;
    const maxAge = Number(process.env['SESSION_MAX_AGE']) || DEFAULT_SESSION_MAX_AGE;

    if (session && Date.now() - session.loginTime < maxAge * 1000) {
      return reply.redirect('/admin');
    }

    return reply.view('admin/login.njk', {
      error: null,
      csrfToken: reply.generateCsrf(),
    });
  });

  fastify.post('/admin/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      fastify.log.warn('Admin login failed: invalid request body');
      return reply.status(400).view('admin/login.njk', {
        error: '无效的请求格式',
        csrfToken: reply.generateCsrf(),
      });
    }
    const { username, password } = parsed.data;

    const expectedUsername = process.env['ADMIN_USERNAME'];
    const expectedHash = process.env['ADMIN_PASSWORD_HASH'];

    if (!expectedUsername || !expectedHash) {
      fastify.log.error('Admin credentials not configured');
      return reply.status(500).view('admin/login.njk', {
        error: '服务器配置错误：管理员凭据未设置',
        csrfToken: reply.generateCsrf(),
      });
    }

    if (username !== expectedUsername) {
      fastify.log.warn({ username }, 'Admin login failed: invalid credentials');
      return reply.status(401).view('admin/login.njk', {
        error: '用户名或密码错误',
        csrfToken: reply.generateCsrf(),
      });
    }

    const isValid = await bcrypt.compare(password, expectedHash);
    if (!isValid) {
      fastify.log.warn({ username }, 'Admin login failed: invalid credentials');
      return reply.status(401).view('admin/login.njk', {
        error: '用户名或密码错误',
        csrfToken: reply.generateCsrf(),
      });
    }

    fastify.log.info({ userId: username }, 'Admin login successful');

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
    fastify.log.info('Admin logout');
    request.session.delete();
    return reply.redirect('/admin/login');
  });
}
