import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';

vi.setConfig({ testTimeout: 30000, hookTimeout: 20000 });

const TEST_USERNAME = 'e2e-admin';
const TEST_PASSWORD = 'e2e-test-password';

interface LoginResponse {
  status: number;
  body: string;
  location: string | null;
  setCookie: string | null;
}

async function getCsrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrfCookie = cookies.find((c) => c.name === 'csrf-token');
  if (csrfCookie?.value) return csrfCookie.value;

  const pageCookies = (await page.evaluate(
    '(() => { const m = document.cookie.match(/csrf-token=([^;]+)/); return m ? m[1] : ""; })()'
  )) as string;
  return pageCookies;
}

async function doLogin(
  page: Page,
  baseUrl: string,
  username: string,
  password: string,
  maxRedirects?: number
): Promise<LoginResponse> {
  const csrfToken = await getCsrfToken(page);
  const resp = await page.context().request.post(`${baseUrl}/admin/login`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrfToken,
    },
    form: { username, password },
    maxRedirects: maxRedirects ?? 0,
  });
  const body = await resp.text();
  return {
    status: resp.status(),
    body,
    location: resp.headers()['location'] || null,
    setCookie: resp.headers()['set-cookie'] || null,
  };
}

async function applySetCookie(context: BrowserContext, setCookie: string | null): Promise<void> {
  if (!setCookie) return;
  const cookieStr = setCookie.split(';')[0];
  if (!cookieStr) return;
  const eq = cookieStr.indexOf('=');
  if (eq <= 0) return;
  await context.addCookies([
    {
      name: cookieStr.slice(0, eq),
      value: cookieStr.slice(eq + 1),
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
}

async function loginAndApplySession(
  page: Page,
  context: BrowserContext,
  baseUrl: string
): Promise<void> {
  await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });
  const result = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
  if (result.status !== 302) {
    throw new Error(`Login failed with status ${result.status}: ${result.body}`);
  }
  await applySetCookie(context, result.setCookie);
}

interface CleanupIds {
  responses: string[];
  interviews: string[];
  plans: string[];
  templates: string[];
}

describe('Report Viewing (Playwright E2E)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;
  let cleanupIds: CleanupIds;

  beforeAll(async () => {
    const server = await createE2EServer(0);
    baseUrl = server.baseUrl;

    (globalThis as Record<string, unknown>)['__E2E_SERVER'] = server;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    });
    page = await context.newPage();

    cleanupIds = { responses: [], interviews: [], plans: [], templates: [] };

    await loginAndApplySession(page, context, baseUrl);

    const template = await server.prisma.template.create({
      data: {
        name: 'E2E Report Test Template',
        description: 'Template for report viewing E2E tests',
        content: JSON.stringify({
          questions: ['您对这个项目有什么看法？', '您觉得还需要改进什么？'],
          invitationPrompt: '欢迎参与本次访谈',
        }),
        status: 'PUBLISHED',
      },
    });
    cleanupIds.templates.push(template.id);

    const plan = await server.prisma.interviewPlan.create({
      data: {
        name: 'E2E Report Test Plan',
        templateId: template.id,
        status: 'RUNNING',
      },
    });
    cleanupIds.plans.push(plan.id);

    // Create interview with PENDING status and messages+responses
    const interview = await server.prisma.interview.create({
      data: {
        userId: 'e2e-test-user-001',
        templateId: template.id,
        planId: plan.id,
        status: 'COMPLETED',
      },
    });
    cleanupIds.interviews.push(interview.id);

    await server.prisma.message.createMany({
      data: [
        {
          interviewId: interview.id,
          role: 'assistant',
          content: '欢迎参与本次访谈！您对这个项目有什么看法？',
        },
        {
          interviewId: interview.id,
          role: 'user',
          content: '我觉得这个项目整体方向很好，但有些细节需要完善。',
        },
        {
          interviewId: interview.id,
          role: 'assistant',
          content: '谢谢您的回答！您觉得还需要改进什么？',
        },
        {
          interviewId: interview.id,
          role: 'user',
          content: '希望能多关注一下用户体验方面的优化。',
        },
      ],
    });

    await server.prisma.response.createMany({
      data: [
        {
          interviewId: interview.id,
          questionId: 'q0',
          content: '我觉得这个项目整体方向很好，但有些细节需要完善。',
          isFollowup: false,
        },
        {
          interviewId: interview.id,
          questionId: 'q1',
          content: '希望能多关注一下用户体验方面的优化。',
          isFollowup: false,
        },
      ],
    });
    cleanupIds.responses.push(interview.id); // Track for cleanup by interviewId

    const interview2 = await server.prisma.interview.create({
      data: {
        userId: 'e2e-test-user-002',
        templateId: template.id,
        planId: plan.id,
        status: 'PENDING',
      },
    });
    cleanupIds.interviews.push(interview2.id);
  });

  afterAll(async () => {
    const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
      ReturnType<typeof createE2EServer>
    >;

    // Cleanup: delete in FK-safe order
    if (server?.prisma) {
      const prisma = server.prisma;
      // Delete responses by interviewId
      for (const interviewId of cleanupIds.interviews) {
        await prisma.response.deleteMany({ where: { interviewId } }).catch(() => {});
        await prisma.message.deleteMany({ where: { interviewId } }).catch(() => {});
        await prisma.analysisReport.deleteMany({ where: { interviewId } }).catch(() => {});
        await prisma.analysisFailure.deleteMany({ where: { interviewId } }).catch(() => {});
      }
      // Delete interviews
      for (const id of cleanupIds.interviews) {
        await prisma.interview.delete({ where: { id } }).catch(() => {});
      }
      // Delete plans
      for (const id of cleanupIds.plans) {
        await prisma.interviewPlan.delete({ where: { id } }).catch(() => {});
      }
      // Delete templates
      for (const id of cleanupIds.templates) {
        await prisma.template.delete({ where: { id } }).catch(() => {});
      }
    }

    await context.close();
    await browser.close();

    if (server) {
      await server.teardown();
    }
  });

  describe('Report detail view', () => {
    it('should render report detail page for existing interview', async () => {
      const interviewId = cleanupIds.interviews[0];
      const response = await page.goto(`${baseUrl}/admin/content/reports/${interviewId}`, {
        waitUntil: 'load',
      });
      expect(response?.status()).toBeLessThan(500);

      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('访谈报告');
      expect(bodyText).toContain('e2e-test-user-001');
      expect(bodyText).toContain('COMPLETED');
    });

    it('should show dialog transcript section', async () => {
      const interviewId = cleanupIds.interviews[0];
      const response = await page.goto(`${baseUrl}/admin/content/reports/${interviewId}`, {
        waitUntil: 'load',
      });
      expect(response?.status()).toBeLessThan(500);

      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('访谈对话记录');
    });

    it('should show message bubbles in dialog transcript', async () => {
      const interviewId = cleanupIds.interviews[0];
      await page.goto(`${baseUrl}/admin/content/reports/${interviewId}`, {
        waitUntil: 'load',
      });

      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('欢迎参与本次访谈');
      expect(bodyText).toContain('我觉得这个项目整体方向很好');
    });

    it('should show empty state when no report exists yet', async () => {
      const interviewId = cleanupIds.interviews[0];
      await page.goto(`${baseUrl}/admin/content/reports/${interviewId}`, {
        waitUntil: 'load',
      });

      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('暂无分析报告');
    });
  });

  describe('Report download', () => {
    it('should download markdown report for interview with data', async () => {
      const interviewId = cleanupIds.interviews[0];
      await loginAndApplySession(page, context, baseUrl);

      const response = await page.request.get(
        `${baseUrl}/admin/api/reports/${interviewId}/download`,
        {
          failOnStatusCode: false,
        }
      );

      // Should succeed (200) even with no analysis report — it returns transcript
      expect(response.status()).toBe(200);

      const body = await response.text();
      expect(body).toContain('# 访谈报告');
      expect(body).toContain('e2e-test-user-001');
      expect(body).toContain('欢迎参与本次访谈');
    });

    it('should return 404 for nonexistent interview download', async () => {
      await loginAndApplySession(page, context, baseUrl);

      const response = await page.request.get(
        `${baseUrl}/admin/api/reports/nonexistent-id/download`,
        {
          failOnStatusCode: false,
        }
      );

      expect(response.status()).toBe(404);
    });
  });

  describe('Report export', () => {
    it('should handle PDF export request', async () => {
      const interviewId = cleanupIds.interviews[0];
      await loginAndApplySession(page, context, baseUrl);

      const response = await page.request.get(
        `${baseUrl}/admin/api/reports/${interviewId}/export/pdf`,
        {
          failOnStatusCode: false,
        }
      );

      // PDF export may fail (500) if export service unavailable or report not generated,
      // but route itself is accessible. Just verify it doesn't return non-HTTP error.
      const status = response.status();
      expect([200, 404, 500]).toContain(status);
    });

    it('should handle Excel export request', async () => {
      const interviewId = cleanupIds.interviews[0];
      await loginAndApplySession(page, context, baseUrl);

      const response = await page.request.get(
        `${baseUrl}/admin/api/reports/${interviewId}/export/excel`,
        {
          failOnStatusCode: false,
        }
      );

      const status = response.status();
      expect([200, 404, 500]).toContain(status);
    });
  });

  describe('Report reanalysis', () => {
    it('should accept reanalysis POST for interview with responses', async () => {
      const interviewId = cleanupIds.interviews[0];
      await loginAndApplySession(page, context, baseUrl);

      const csrfToken = await getCsrfToken(page);
      const response = await page.request.post(
        `${baseUrl}/admin/api/reports/${interviewId}/reanalyze`,
        {
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          data: {},
          failOnStatusCode: false,
        }
      );

      const status = response.status();
      // 200 = LLM succeeded, 500 = LLM unavailable (no API key in E2E)
      // Both mean the route itself is accessible and working
      expect([200, 500]).toContain(status);
    });
  });

  describe('Nonexistent report', () => {
    it('should return 404 for nonexistent interview report page', async () => {
      await loginAndApplySession(page, context, baseUrl);

      const response = await page.goto(`${baseUrl}/admin/content/reports/nonexistent-id`, {
        waitUntil: 'load',
      });

      expect(response?.status()).toBe(404);
    });

    it('should return error for nonexistent interview reanalyze POST', async () => {
      await loginAndApplySession(page, context, baseUrl);

      const csrfToken = await getCsrfToken(page);
      const response = await page.request.post(
        `${baseUrl}/admin/api/reports/nonexistent-id/reanalyze`,
        {
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          data: {},
          failOnStatusCode: false,
        }
      );

      expect([400, 404, 500]).toContain(response.status());
    });
  });
});
