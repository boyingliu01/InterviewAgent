import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server.js';

const ADMIN_KEY = 'test-admin-key';
const prisma = new PrismaClient();

describe('Admin Tree Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    vi.stubEnv('SESSION_SALT', 'b'.repeat(16));
    vi.stubEnv('ADMIN_API_KEY', ADMIN_KEY);
    vi.stubEnv('DINGTALK_CLIENT_ID', 'test-client-id');
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'test-client-secret');
    const result = await buildApp();
    app = result.fastify;
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /admin', () => {
    it('should return 200 with tree structure containing tree-node class', async () => {
      const template = await prisma.template.create({
        data: {
          name: 'Tree Test Template',
          content: '[]',
          status: 'DRAFT',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('tree-node');

      await prisma.template.delete({ where: { id: template.id } });
    });

    it('should return 200 with admin interface in response', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('访谈管理后台');
    });
  });

  describe('GET /admin/content/templates/:id', () => {
    it('should return 404 for non-existent template ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/content/templates/non-existent-template-id',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('模板不存在');
    });
  });

  describe('GET /admin/content/plans/:id', () => {
    it('should return 404 for non-existent plan ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/content/plans/non-existent-plan-id',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('计划不存在');
    });
  });

  describe('GET /admin/content/reports/:interviewId', () => {
    it('should return 404 for non-existent interview ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/content/reports/non-existent-interview-id',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('访谈不存在');
    });
  });

  describe('GET /admin/content/plans/:id/all-interviews', () => {
    it('should return 404 for non-existent plan ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/content/plans/non-existent-plan-id-2/all-interviews',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('计划不存在');
    });
  });

  describe('POST /admin/api/templates — Create template (JSON)', () => {
    it('should create template and return 201 with redirect', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/api/templates',
        headers: {
          'x-admin-key': ADMIN_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Integration Test Template',
          invitationPrompt: 'Please answer our survey',
          questions: { '0': { text: 'How are you?' } },
        }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['hx-redirect']).toBe('/admin');

      const created = await prisma.template.findFirst({
        where: { name: 'Integration Test Template' },
      });
      if (!created) throw new Error('Created template not found');
      expect(created.content).toContain('Please answer our survey');

      await prisma.template.delete({ where: { id: created.id } });
    });

    it('should return 422 when name is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/api/templates',
        headers: {
          'x-admin-key': ADMIN_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: { invitationPrompt: 'test' },
        }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).toContain('text-red-600');
    });
  });

  describe('GET /admin/content/templates/:id — action buttons render', () => {
    it('should render template detail page with edit, delete, and create plan buttons', async () => {
      const template = await prisma.template.create({
        data: {
          name: 'Buttons Test Template',
          content: '[]',
          status: 'DRAFT',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/admin/content/templates/${template.id}`,
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('编辑');
      expect(response.body).toContain('删除');
      expect(response.body).toContain('创建计划');

      await prisma.template.delete({ where: { id: template.id } });
    });
  });

  describe('GET /admin/content/plans/new — Plan creation form', () => {
    it('should return 200 and render plan form with template dropdown', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/content/plans/new',
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('新建访谈计划');
      expect(response.body).toContain('保存计划');
    });

    it('should pre-select template when templateId query param is provided', async () => {
      const template = await prisma.template.create({
        data: {
          name: 'Preselect Test',
          content: '[]',
          status: 'DRAFT',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/admin/content/plans/new?templateId=${template.id}`,
        headers: {
          'x-admin-key': ADMIN_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('selected');

      await prisma.template.delete({ where: { id: template.id } });
    });
  });
});
