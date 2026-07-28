import fastifyCsrfProtection from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import secureSession from '@fastify/secure-session';
import fastifyView from '@fastify/view';
import bcrypt from 'bcryptjs';
import Fastify from 'fastify';
import nunjucks from 'nunjucks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminAuthRoutes } from '../src/routes/admin-auth.js';

describe('adminAuthRoutes', () => {
  let app: ReturnType<typeof Fastify>;
  const testUsername = 'testadmin';
  let testHash: string;

  beforeEach(async () => {
    testHash = await bcrypt.hash('testpassword123', 12);

    app = Fastify();

    await app.register(secureSession, {
      secret: 'a'.repeat(32),
      salt: 'b'.repeat(16),
    });

    await app.register(fastifyCsrfProtection);

    await app.register(fastifyFormbody);

    await app.register(fastifyView, {
      engine: { nunjucks },
      templates: 'src/views',
      options: {
        autoescape: true,
        noCache: true,
      },
    });

    await app.register(adminAuthRoutes);

    process.env['ADMIN_USERNAME'] = testUsername;
    process.env['ADMIN_PASSWORD_HASH'] = testHash;

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['ADMIN_USERNAME'];
    delete process.env['ADMIN_PASSWORD_HASH'];
  });

  it('should return login page on GET /admin/login', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/login',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('登录');
  });

  it('should login with valid credentials and redirect to /admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: testUsername,
        password: 'testpassword123',
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/admin');
  });

  it('should reject login with wrong password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: testUsername,
        password: 'wrong-password',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('用户名或密码错误');
  });

  it('should reject login with wrong username', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: 'wronguser',
        password: 'testpassword123',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('用户名或密码错误');
  });

  it('should return 500 when credentials are not configured', async () => {
    delete process.env['ADMIN_USERNAME'];
    delete process.env['ADMIN_PASSWORD_HASH'];

    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: testUsername,
        password: 'testpassword123',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('管理员凭据未设置');
  });

  it('should redirect to login page on logout', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/logout',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/admin/login');
  });

  it('should redirect to /admin if already logged in on GET /admin/login', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: testUsername,
        password: 'testpassword123',
      },
    });
    const cookies = loginResponse.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookies) ? cookies.join('; ') : ((cookies as string) ?? '');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/login',
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/admin');
  });

  it('should reject login with invalid request body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: {
        username: '',
        password: '',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('无效的请求格式');
  });
});
