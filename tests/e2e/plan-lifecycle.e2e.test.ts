import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';

// E2E tests need extra time for browser startup, page navigation, and HTMX async swaps
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

interface TestContext {
  templateIds: string[];
  planIds: string[];
}

describe('Plan Lifecycle (Playwright E2E)', () => {
  const ctx: TestContext = { templateIds: [], planIds: [] };
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;

  /** Create a template via Prisma API and track its ID for cleanup */
  async function createTemplate(
    name: string,
    status: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED'
  ): Promise<string> {
    const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as {
      prisma: { template: { create: (args: Record<string, unknown>) => Promise<{ id: string }> } };
    };
    const template = await server.prisma.template.create({
      data: {
        name,
        description: `E2E template for plan lifecycle: ${name}`,
        content: JSON.stringify({
          name,
          invitationPrompt: '您好，欢迎参与E2E测试访谈！',
          questions: ['问题一：请介绍您的工作经历', '问题二：您最大的成就是什么？'],
          closingMessage: '感谢参与！',
        }),
        status,
      },
    });
    ctx.templateIds.push(template.id);
    return template.id;
  }

  /** Create a plan via Prisma API and track its ID for cleanup */
  async function createPlanViaDb(
    name: string,
    templateId: string,
    status = 'PENDING'
  ): Promise<string> {
    const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as {
      prisma: {
        interviewPlan: {
          create: (args: Record<string, unknown>) => Promise<{ id: string }>;
        };
      };
    };
    const plan = await server.prisma.interviewPlan.create({
      data: { name, templateId, status },
    });
    ctx.planIds.push(plan.id);
    return plan.id;
  }

  /** Perform browser-based login via form submission */
  async function loginViaBrowser(): Promise<void> {
    await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });
    await page.fill('#username', 'e2e-admin');
    await page.fill('#password', 'e2e-test-password');
    await Promise.all([
      page.waitForURL('**/admin', { timeout: 10000 }),
      page.click('button[type="submit"]'),
    ]);
  }

  beforeAll(async () => {
    process.env['ADMIN_API_KEY'] = 'test-admin-key';
    const server = await createE2EServer(0);
    baseUrl = server.baseUrl;
    (globalThis as Record<string, unknown>)['__E2E_SERVER'] = server;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Cache-Control': 'no-cache', 'X-Admin-Key': 'test-admin-key' },
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    // Clean up in dependency order: interviews → plans → templates
    const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as {
      prisma: {
        analysisReport: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        analysisFailure: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        response: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        message: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        batchAnalysisReport: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        interview: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        interviewPlan: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
        template: { deleteMany: (args: Record<string, unknown>) => Promise<unknown> };
      };
    };

    // Find and delete interviews linked to our plans
    if (ctx.planIds.length > 0) {
      // Find all interviews linked to our plans
      try {
        const server2 = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as {
          prisma: {
            interview: {
              findMany: (args: Record<string, unknown>) => Promise<Array<{ id: string }>>;
            };
          };
        };
        const interviews = await server2.prisma.interview.findMany({
          where: { planId: { in: ctx.planIds } },
          select: { id: true },
        });
        const interviewIds = interviews.map((i: { id: string }) => i.id);
        if (interviewIds.length > 0) {
          await server.prisma.analysisReport
            .deleteMany({ where: { interviewId: { in: interviewIds } } })
            .catch(() => {});
          await server.prisma.analysisFailure
            .deleteMany({ where: { interviewId: { in: interviewIds } } })
            .catch(() => {});
          await server.prisma.response
            .deleteMany({ where: { interviewId: { in: interviewIds } } })
            .catch(() => {});
          await server.prisma.message
            .deleteMany({ where: { interviewId: { in: interviewIds } } })
            .catch(() => {});
          await server.prisma.batchAnalysisReport
            .deleteMany({ where: { planId: { in: ctx.planIds } } })
            .catch(() => {});
          await server.prisma.interview
            .deleteMany({ where: { id: { in: interviewIds } } })
            .catch(() => {});
        }
      } catch {
        // Best-effort cleanup
      }
      await server.prisma.interviewPlan
        .deleteMany({ where: { id: { in: ctx.planIds } } })
        .catch(() => {});
    }
    if (ctx.templateIds.length > 0) {
      await server.prisma.template
        .deleteMany({ where: { id: { in: ctx.templateIds } } })
        .catch(() => {});
    }

    await context.close();
    await browser.close();
    const e2eServer = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
      ReturnType<typeof createE2EServer>
    >;
    if (e2eServer) {
      await e2eServer.teardown();
    }
  });

  describe('Plan Creation via Admin UI', () => {
    it('should create a plan through the admin HTMX form and verify in tree', async () => {
      // Setup: create a template
      await createTemplate('E2E UI Create Template');

      await loginViaBrowser();

      await page.waitForSelector('text=E2E UI Create Template', { timeout: 8000 });
      await page.click('text=E2E UI Create Template');
      await page.waitForSelector('button:has-text("创建计划")', { timeout: 8000 });
      await page.click('button:has-text("创建计划")');
      await page.waitForSelector('#planName', { timeout: 8000 });
      await page.waitForSelector('#plan-submit-btn', { timeout: 5000 });

      // Fill in plan details
      const planName = 'E2E UI 创建计划';
      await page.fill('#planName', planName);
      await page.fill('#targetDate', '2026-12-31');

      const responsePromise = page.waitForResponse(
        (res) => res.url().endsWith('/api/plans') && res.request().method() === 'POST',
        { timeout: 10000 }
      );
      await page.click('#plan-submit-btn');
      const planResponse = await responsePromise;

      expect(planResponse.status()).toBe(200);
      const responseBody: { id?: string } = await planResponse.json();
      expect(responseBody.id).toBeTruthy();
      if (responseBody.id) {
        ctx.planIds.push(responseBody.id);
      }

      // Give HTMX time to process the response and refresh the tree
      await page.waitForTimeout(3000);

      // Reload admin page to verify tree data contains the new plan name
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });
      const treeContent = await page.textContent('aside');
      expect(treeContent).toContain(planName);
      expect(treeContent).toContain('E2E UI Create Template');
    });

    it('should reject plan creation with empty form (validation)', async () => {
      // Setup: create a template
      await createTemplate('E2E Validation Template');

      // Navigate to plan form WITHOUT pre-selecting template
      await page.goto(`${baseUrl}/admin/content/plans/new`, {
        waitUntil: 'load',
      });

      await page.waitForSelector('#plan-submit-btn', { timeout: 5000 });

      // Submit empty form — should be rejected by HTML5 validation or server
      // The #planName is required and #templateId is required — submitting empty
      // should trigger browser-side validation (form won't submit via Playwright
      // if we try to click a submit in a form with required fields unfilled).
      // Instead, test via API to verify server-side validation.
      const apiResp = await page.context().request.post(`${baseUrl}/api/plans`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
        },
        data: {},
        failOnStatusCode: false,
      });
      expect(apiResp.status()).toBe(400);
      const errBody: { error?: string } = await apiResp.json();
      expect(errBody.error).toBe('Invalid input');
    });
  });

  describe('Plan Detail View', () => {
    it('should display plan info on detail page via admin fragment', async () => {
      const templateId = await createTemplate('E2E Detail View Template');
      const planId = await createPlanViaDb('E2E 详情页计划', templateId, 'READY');

      const response = await page.goto(`${baseUrl}/admin/content/plans/${planId}`, {
        waitUntil: 'load',
      });
      expect(response?.status()).toBe(200);

      // Fragment renders directly in body — not in #main-content (that's only in admin shell)
      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('E2E 详情页计划');
      expect(bodyText).toContain('E2E Detail View Template');
      // Status badge renders in Chinese: READY → 就绪
      expect(bodyText).toContain('就绪');
    });

    it('should show 404 message for non-existent plan', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const response = await page.goto(`${baseUrl}/admin/content/plans/${nonExistentId}`, {
        waitUntil: 'load',
      });
      expect(response?.status()).toBe(404);
    });
  });

  describe('Plan Pause/Resume Lifecycle', () => {
    it('should pause a plan and verify status changes to PAUSED', async () => {
      // Setup: create template + plan in READY status
      const templateId = await createTemplate('E2E Pause Template');
      const planId = await createPlanViaDb('E2E 暂停测试计划', templateId, 'READY');

      // Pause the plan via API
      const pauseResp = await page.context().request.post(`${baseUrl}/api/plans/${planId}/pause`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(pauseResp.status()).toBe(200);
      const pauseBody: { status?: string } = await pauseResp.json();
      expect(pauseBody.status).toBe('paused');

      // Verify plan status via API
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(200);
      const plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('PAUSED');
    });

    it('should resume a paused plan and verify status changes to RUNNING', async () => {
      // Setup: create template + plan in PAUSED status
      const templateId = await createTemplate('E2E Resume Template');
      const planId = await createPlanViaDb('E2E 恢复测试计划', templateId, 'PAUSED');

      // Resume the plan via API
      const resumeResp = await page
        .context()
        .request.post(`${baseUrl}/api/plans/${planId}/resume`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          failOnStatusCode: false,
        });
      expect(resumeResp.status()).toBe(200);
      const resumeBody: { status?: string } = await resumeResp.json();
      expect(resumeBody.status).toBe('running');

      // Verify plan status via API
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(200);
      const plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('RUNNING');
    });

    it('should round-trip pause → resume correctly', async () => {
      // Setup: create template + plan in READY status
      const templateId = await createTemplate('E2E Roundtrip Template');
      const planId = await createPlanViaDb('E2E 往返测试计划', templateId, 'READY');

      // API: Pause
      let resp = await page.context().request.post(`${baseUrl}/api/plans/${planId}/pause`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      expect(resp.status()).toBe(200);

      // API: Resume
      resp = await page.context().request.post(`${baseUrl}/api/plans/${planId}/resume`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      expect(resp.status()).toBe(200);
      const body: { status?: string } = await resp.json();
      expect(body.status).toBe('running');

      // Verify final status
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      const plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('RUNNING');
    });
  });

  describe('Plan Cancel Flow', () => {
    it('should cancel a plan and verify status changes to CANCELLED', async () => {
      // Setup: create template + plan in READY status
      const templateId = await createTemplate('E2E Cancel Template');
      const planId = await createPlanViaDb('E2E 取消测试计划', templateId, 'READY');

      // Cancel the plan via API
      const cancelResp = await page
        .context()
        .request.post(`${baseUrl}/api/plans/${planId}/cancel`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          failOnStatusCode: false,
        });
      expect(cancelResp.status()).toBe(200);
      const cancelBody: { status?: string } = await cancelResp.json();
      expect(cancelBody.status).toBe('cancelled');

      // Verify plan status via API
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(200);
      const plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('CANCELLED');
    });
  });

  describe('Plan Send Invitations', () => {
    it('should send invitations and transition plan to RUNNING', async () => {
      // Setup: create template + plan in PENDING status
      const templateId = await createTemplate('E2E Send Template');
      const planId = await createPlanViaDb('E2E 发送邀约计划', templateId, 'PENDING');

      // Send invitations via API
      const sendResp = await page.context().request.post(`${baseUrl}/api/plans/${planId}/send`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(sendResp.status()).toBe(200);
      const sendBody: { sent?: number; failed?: number } = await sendResp.json();
      // With no invitees, sent should be 0 and failed should be 0
      expect(sendBody.sent).toBe(0);

      // Verify plan status changed to RUNNING
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(200);
      const plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('RUNNING');
    });
  });

  describe('Plan Deletion', () => {
    it('should delete a plan with no interviews and verify 404 on retrieval', async () => {
      // Setup: create template + plan in PENDING status (no interviews)
      const templateId = await createTemplate('E2E Delete Template');
      const planId = await createPlanViaDb('E2E 删除测试计划', templateId, 'PENDING');

      // Delete the plan via admin API (force=true to simplify)
      const deleteResp = await page
        .context()
        .request.delete(`${baseUrl}/admin/api/plans/${planId}?force=true`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          failOnStatusCode: false,
        });
      // 200 with HTML body on success (no children so simple delete)
      expect(deleteResp.status()).toBe(200);

      // Remove from cleanup since we've already deleted it
      ctx.planIds = ctx.planIds.filter((id) => id !== planId);

      // Verify the plan no longer exists
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(404);
    });

    it('should reject deletion of plan with interviews without force flag', async () => {
      // Setup: create template + plan
      const templateId = await createTemplate('E2E Delete Reject Template');
      const planId = await createPlanViaDb('E2E 删除拒绝计划', templateId, 'PENDING');

      // Create an interview linked to the plan
      const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as {
        prisma: {
          interview: {
            create: (args: Record<string, unknown>) => Promise<{ id: string }>;
          };
        };
      };
      await server.prisma.interview.create({
        data: {
          userId: 'e2e-test-user-delete',
          templateId,
          planId,
          status: 'PENDING',
        },
      });

      // Try to delete the plan without force
      const deleteResp = await page
        .context()
        .request.delete(`${baseUrl}/admin/api/plans/${planId}`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          failOnStatusCode: false,
        });
      expect(deleteResp.status()).toBe(409);

      // Verify the plan still exists
      const getResp = await page.request.get(`${baseUrl}/api/plans/${planId}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
        failOnStatusCode: false,
      });
      expect(getResp.status()).toBe(200);
    });

    it('should return 404 when deleting a non-existent plan', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const deleteResp = await page
        .context()
        .request.delete(`${baseUrl}/admin/api/plans/${nonExistentId}?force=true`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          failOnStatusCode: false,
        });
      expect(deleteResp.status()).toBe(404);
    });
  });

  describe('Plan Lifecycle via Login Session', () => {
    it('should create a plan after browser login and verify via both UI and API', async () => {
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });
      const currentUrl = page.url();
      // If already redirected to /admin (already logged in), skip login
      if (!currentUrl.includes('/admin') || currentUrl.includes('/login')) {
        await loginViaBrowser();
      }

      // Step 2: Create template via API (using page context which has session cookies)
      const templateResp = await page.context().request.post(`${baseUrl}/api/templates`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
        },
        data: {
          name: 'E2E Session Lifecycle Template',
          description: 'Template for session-based lifecycle test',
          content: {
            name: 'E2E Session Lifecycle Template',
            invitationPrompt: '欢迎参与测试',
            questions: ['问题一', '问题二'],
          },
        },
      });
      const templateBody: { id: string } = await templateResp.json();
      expect(templateBody.id).toBeTruthy();
      ctx.templateIds.push(templateBody.id);

      // Step 3: Create plan via API
      const planResp = await page.context().request.post(`${baseUrl}/api/plans`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'test-admin-key',
        },
        data: {
          name: 'E2E 会话流程计划',
          templateId: templateBody.id,
        },
      });
      expect(planResp.status()).toBe(200);
      const planBody: { id: string } = await planResp.json();
      expect(planBody.id).toBeTruthy();
      ctx.planIds.push(planBody.id);

      // Step 4: Verify plan detail page loads via admin fragment
      await page.goto(`${baseUrl}/admin/content/plans/${planBody.id}`, {
        waitUntil: 'load',
      });
      const detailContent = await page.textContent('body');
      expect(detailContent).toContain('E2E 会话流程计划');
      expect(detailContent).toContain('E2E Session Lifecycle Template');
      expect(detailContent).toContain('待处理');

      // Step 5: Pause, resume, then cancel via API (session-based auth)
      let resp = await page.context().request.post(`${baseUrl}/api/plans/${planBody.id}/pause`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      expect(resp.status()).toBe(200);

      // Verify PAUSED
      let getResp = await page.request.get(`${baseUrl}/api/plans/${planBody.id}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      let plan: { status: string } = await getResp.json();
      expect(plan.status).toBe('PAUSED');

      // Resume
      resp = await page.context().request.post(`${baseUrl}/api/plans/${planBody.id}/resume`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      expect(resp.status()).toBe(200);

      // Cancel
      resp = await page.context().request.post(`${baseUrl}/api/plans/${planBody.id}/cancel`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      expect(resp.status()).toBe(200);

      // Verify final CANCELLED status
      getResp = await page.request.get(`${baseUrl}/api/plans/${planBody.id}`, {
        headers: { 'X-Admin-Key': 'test-admin-key' },
      });
      plan = await getResp.json();
      expect(plan.status).toBe('CANCELLED');
    });
  });
});
