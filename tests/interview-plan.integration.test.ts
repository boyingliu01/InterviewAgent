/**
 * Integration tests for InterviewPlan API routes
 * Uses real PostgreSQL database + real Fastify server — no Mocks
 *
 * Prerequisites: PostgreSQL running + dialog_survey_test database
 * Run: npx vitest run tests/interview-plan.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/utils/security.js';
import { type TestServer, createTestServer } from './helpers/test-server.js';

const TEST_API_KEY = 'test-api-key-for-integration';

describe('InterviewPlan API (Integration)', () => {
  let ctx: TestServer;
  let templateId: string;
  let createdIds: { apiKeys: string[]; templates: string[]; interviewPlans: string[] };

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  beforeEach(async () => {
    createdIds = { apiKeys: [], templates: [], interviewPlans: [] };

    const keyHash = hashApiKey(TEST_API_KEY);
    let apiKey = await ctx.prisma.apiKey.findFirst({ where: { keyHash } });
    if (!apiKey) {
      apiKey = await ctx.prisma.apiKey.create({
        data: {
          keyHash,
          role: 'admin',
        },
      });
      createdIds.apiKeys.push(apiKey.id);
    }

    const template = await ctx.prisma.template.create({
      data: {
        name: '测试模板',
        content: JSON.stringify({ invitationPrompt: '欢迎', questions: ['Q1', 'Q2'] }),
        status: 'DRAFT',
        createdBy: 'admin',
        updatedBy: 'admin',
      },
    });
    createdIds.templates.push(template.id);
    templateId = template.id;
  });

  afterEach(async () => {
    await ctx.testDb.cleanup(createdIds);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('POST /api/plans', () => {
    it('should create an interview plan with valid data', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/plans',
        headers: { 'x-api-key': TEST_API_KEY },
        payload: {
          name: '测试访谈计划',
          templateId,
          description: '集成测试计划',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBeDefined();
      createdIds.interviewPlans.push(body.id);

      // Verify in DB
      const plan = await ctx.prisma.interviewPlan.findUnique({
        where: { id: body.id },
      });
      expect(plan).not.toBeNull();
      expect(plan?.name).toBe('测试访谈计划');
      expect(plan?.templateId).toBe(templateId);
      expect(plan?.status).toBe('PENDING');
    });

    it('should reject plan creation without required fields', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/plans',
        headers: { 'x-api-key': TEST_API_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject plan with non-existent templateId (FK violation)', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/plans',
        headers: { 'x-api-key': TEST_API_KEY },
        payload: {
          name: '无效模板计划',
          templateId: '00000000-0000-0000-0000-000000000000',
        },
      });

      // Should fail — either 400 (validation) or 500 (FK constraint)
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/plans', () => {
    it('should list all plans', async () => {
      const before = await ctx.app.inject({
        method: 'GET',
        url: '/api/plans',
        headers: { 'x-api-key': TEST_API_KEY },
      });
      const beforeCount = before.json().plans.length;

      // Create 2 plans
      const planA = await ctx.prisma.interviewPlan.create({
        data: {
          name: '计划A',
          templateId,
          status: 'PENDING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(planA.id);
      const planB = await ctx.prisma.interviewPlan.create({
        data: {
          name: '计划B',
          templateId,
          status: 'PENDING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(planB.id);

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/plans',
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.plans).toBeDefined();
      // Total is across ALL records (including previous test runs), but
      // the default pagination is 20. Verify total increased by at least 2
      // (the 2 plans we just created), not that paginated length equals beforeCount+2.
      expect(body.total).toBeGreaterThanOrEqual(beforeCount + 2);
    });

    it('should filter plans by status', async () => {
      const pending = await ctx.prisma.interviewPlan.create({
        data: {
          name: '待处理',
          templateId,
          status: 'PENDING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(pending.id);
      const running = await ctx.prisma.interviewPlan.create({
        data: {
          name: '运行中',
          templateId,
          status: 'RUNNING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(running.id);

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/plans?status=RUNNING',
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.plans.length).toBe(1);
      expect(body.plans[0].name).toBe('运行中');
    });
  });

  describe('GET /api/plans/:id', () => {
    it('should return plan details with interviews', async () => {
      const plan = await ctx.prisma.interviewPlan.create({
        data: {
          name: '详情测试',
          templateId,
          status: 'PENDING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(plan.id);

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/plans/${plan.id}`,
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe('详情测试');
      expect(body.interviews).toBeDefined();
      expect(body.template).toBeDefined();
    });

    it('should return 404 for non-existent plan', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/plans/00000000-0000-0000-0000-000000000000',
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/plans/:id', () => {
    it('should update plan name', async () => {
      const plan = await ctx.prisma.interviewPlan.create({
        data: {
          name: '原始名称',
          templateId,
          status: 'PENDING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(plan.id);

      const response = await ctx.app.inject({
        method: 'PUT',
        url: `/api/plans/${plan.id}`,
        headers: { 'x-api-key': TEST_API_KEY },
        payload: {
          name: '更新后名称',
          templateId,
        },
      });

      expect(response.statusCode).toBe(200);

      // Verify in DB
      const updated = await ctx.prisma.interviewPlan.findUnique({
        where: { id: plan.id },
      });
      expect(updated?.name).toBe('更新后名称');
    });
  });

  describe('POST /api/plans/:id/pause and resume', () => {
    it('should pause a running plan', async () => {
      const plan = await ctx.prisma.interviewPlan.create({
        data: {
          name: '暂停测试',
          templateId,
          status: 'RUNNING',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(plan.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/pause`,
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);

      const updated = await ctx.prisma.interviewPlan.findUnique({
        where: { id: plan.id },
      });
      expect(updated?.status).toBe('PAUSED');
    });

    it('should resume a paused plan', async () => {
      const plan = await ctx.prisma.interviewPlan.create({
        data: {
          name: '恢复测试',
          templateId,
          status: 'PAUSED',
          createdBy: 'admin',
          updatedBy: 'admin',
        },
      });
      createdIds.interviewPlans.push(plan.id);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/resume`,
        headers: { 'x-api-key': TEST_API_KEY },
      });

      expect(response.statusCode).toBe(200);

      const updated = await ctx.prisma.interviewPlan.findUnique({
        where: { id: plan.id },
      });
      expect(updated?.status).toBe('RUNNING');
    });
  });
});
