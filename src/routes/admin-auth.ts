import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SESSION_MAX_AGE } from '../config/constants.js';
import { adminAuth } from '../middleware/admin-auth.js';
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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, '新密码至少6个字符'),
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

  fastify.get(
    '/admin/content/change-password',
    { preHandler: adminAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.view('admin/content/change-password.njk');
    }
  );

  fastify.post(
    '/admin/change-password',
    { preHandler: adminAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(422)
          .send(
            `<div class="text-red-600 text-sm">${parsed.error.issues[0]?.message ?? '输入格式错误'}</div>`
          );
      }

      const { currentPassword, newPassword } = parsed.data;
      const expectedHash = process.env['ADMIN_PASSWORD_HASH'];

      if (!expectedHash) {
        return reply
          .status(500)
          .send('<div class="text-red-600 text-sm">服务器配置错误：管理员凭据未设置</div>');
      }

      const isValid = await bcrypt.compare(currentPassword, expectedHash);
      if (!isValid) {
        return reply.status(422).send('<div class="text-red-600 text-sm">当前密码错误</div>');
      }

      const newHash = await bcrypt.hash(newPassword, 12);
      process.env['ADMIN_PASSWORD_HASH'] = newHash;
      fastify.log.info('Admin password changed');

      return reply.send('<div class="text-green-600 text-sm">密码修改成功</div>');
    }
  );
}
