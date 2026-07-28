import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { expect as playwrightExpect } from 'playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';

// E2E tests need extra time for browser startup, HTMX async swaps, and template CRUD operations
vi.setConfig({ testTimeout: 30000, hookTimeout: 20000 });

const TEST_USERNAME = 'e2e-admin';
const TEST_PASSWORD = 'e2e-test-password';
const TEST_API_KEY = 'test-admin-key';

/**
 * Login helper for browser-based session auth.
 * Navigates to login page, fills form, submits, and redirects to /admin.
 */
async function loginViaBrowser(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });
  await page.fill('#username', TEST_USERNAME);
  await page.fill('#password', TEST_PASSWORD);
  await Promise.all([
    page.waitForURL('**/admin', { timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * Create a template via the public API (using X-Admin-Key) for test data setup.
 */
async function createTemplateViaApi(
  page: Page,
  baseUrl: string,
  name: string,
  questions: string[],
  invitationPrompt?: string
): Promise<string> {
  const response = await page.context().request.post(`${baseUrl}/api/templates`, {
    headers: {
      'X-Admin-Key': TEST_API_KEY,
      'Content-Type': 'application/json',
    },
    data: {
      name,
      content: {
        name,
        invitationPrompt: invitationPrompt ?? '您好，欢迎参与测试访谈！',
        questions,
      },
    },
  });
  const body = await response.json();
  if (response.status() !== 201 && response.status() !== 200) {
    throw new Error(
      `Failed to create template via API: ${response.status()} ${JSON.stringify(body)}`
    );
  }
  return body.id as string;
}

/**
 * Publish a template via the admin API.
 */
async function publishTemplateViaApi(
  page: Page,
  baseUrl: string,
  templateId: string
): Promise<number> {
  const resp = await page
    .context()
    .request.post(`${baseUrl}/admin/api/templates/${templateId}/publish`, {
      headers: { 'X-Admin-Key': TEST_API_KEY },
      maxRedirects: 0,
    });
  return resp.status();
}

describe('Admin Template CRUD (Playwright E2E)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;
  const createdTemplateIds: string[] = [];

  beforeAll(async () => {
    process.env['ADMIN_API_KEY'] = TEST_API_KEY;
    const server = await createE2EServer(0);
    baseUrl = server.baseUrl;

    (globalThis as Record<string, unknown>)['__E2E_SERVER'] = server;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      extraHTTPHeaders: { 'Cache-Control': 'no-cache', 'X-Admin-Key': TEST_API_KEY },
    });
    page = await context.newPage();

    // Login via browser session for all tests
    await loginViaBrowser(page, baseUrl);
  });

  afterEach(async () => {
    // Clean up created templates after each test
    if (createdTemplateIds.length > 0) {
      const ids = [...createdTemplateIds];
      const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
        ReturnType<typeof createE2EServer>
      >;
      if (server) {
        await server.prisma.template.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
      }
      createdTemplateIds.length = 0;
    }
  });

  afterAll(async () => {
    await context.close();
    await browser.close();

    const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
      ReturnType<typeof createE2EServer>
    >;
    if (server) {
      await server.teardown();
    }
  });

  describe('Template creation via admin UI form', () => {
    it('should create a template via the UI form and see it in the tree sidebar', async () => {
      // Step 1: Navigate to admin main page
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      // Step 2: Click "新建模板" button in the sidebar
      const newTemplateBtn = page.locator('button[title="新建模板"]');
      await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/admin/content/templates/new') && res.status() === 200,
          { timeout: 10000 }
        ),
        newTemplateBtn.click(),
      ]);

      // Verify form loaded
      const formContent = await page.textContent('#main-content');
      expect(formContent).toContain('新建模板');

      // Step 3: Fill the form
      await page.fill('input#name[name="name"]', 'E2E UI 创建模板');
      await page.fill(
        'textarea#invitationPrompt[name="invitationPrompt"]',
        '您好，欢迎参与 E2E 测试访谈！'
      );

      // Add a question
      const questionInputs = page.locator('input[name^="questions["]');
      const questionCount = await questionInputs.count();
      if (questionCount > 0) {
        await questionInputs.first().fill('问题一：请介绍一下您的工作经历');
      }

      // Add a second question
      const addBtn = page.locator('button:has-text("+ 添加问题")');
      if ((await addBtn.count()) > 0) {
        await addBtn.click();
        await page.waitForTimeout(200);
        await page.fill('input[name="questions[1][text]"]', '问题二：您最大的成就是什么？');
      }

      // Step 4: Submit — wait for the POST response, then HX-Redirect
      const postResponsePromise = page.waitForResponse(
        (res) => res.url().endsWith('/admin/api/templates') && res.request().method() === 'POST',
        { timeout: 10000 }
      );
      await page.click('button#submit-btn');
      const postResponse = await postResponsePromise;
      expect(postResponse.status()).toBe(201);

      // Step 5: After HX-Redirect, verify the template appears in the sidebar tree
      await page.waitForTimeout(2000);
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      const sidebarText = await page.textContent('aside');
      expect(sidebarText).toContain('E2E UI 创建模板');
    });
  });

  describe('Template detail view', () => {
    it('should display template info after creation', async () => {
      // Create a template via API
      const templateId = await createTemplateViaApi(page, baseUrl, 'E2E 详情测试模板', [
        '问题一：请介绍您的工作经历',
        '问题二：您最大的成就是什么？',
      ]);
      createdTemplateIds.push(templateId);

      // Navigate to admin and wait for tree to load
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });
      await page.waitForFunction(
        "!!document.querySelector('aside')?.textContent?.includes('E2E 详情测试模板')",
        { timeout: 8000 }
      );

      // Click the template name in sidebar to load detail view
      await page.click('text=E2E 详情测试模板');

      // Wait for the detail view to appear in #main-content
      await page.waitForSelector('h2:has-text("E2E 详情测试模板")', { timeout: 8000 });

      const detailContent = await page.textContent('#main-content');
      expect(detailContent).toContain('E2E 详情测试模板');
      expect(detailContent).toContain('草稿');
      expect(detailContent).toContain('v1');
      expect(detailContent).toContain('问题一：请介绍您的工作经历');
      expect(detailContent).toContain('问题二：您最大的成就是什么？');
    });
  });

  describe('Template edit form loads', () => {
    it('should pre-fill edit form with existing template name and questions', async () => {
      // Create a template via API
      const templateId = await createTemplateViaApi(page, baseUrl, 'E2E 编辑测试模板', [
        '问题一：请介绍您的工作经历',
        '问题二：您最大的成就是什么？',
      ]);
      createdTemplateIds.push(templateId);

      // Navigate to admin
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      // Load detail view first
      await page.waitForFunction(
        "!!document.querySelector('aside')?.textContent?.includes('E2E 编辑测试模板')",
        { timeout: 8000 }
      );
      await page.click('text=E2E 编辑测试模板');
      await page.waitForSelector('button:has-text("编辑")', { timeout: 8000 });

      // Click "编辑" button
      await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().includes('/admin/content/templates/') &&
            res.url().endsWith('/edit') &&
            res.status() === 200,
          { timeout: 10000 }
        ),
        page.click('button:has-text("编辑")'),
      ]);

      // Verify edit form is loaded with pre-filled content
      await page.waitForSelector('h2:has-text("编辑模板")', { timeout: 8000 });

      const nameInput = page.locator('input#name[name="name"]');
      await playwrightExpect(nameInput).toHaveValue('E2E 编辑测试模板');

      const invitePrompt = page.locator('textarea#invitationPrompt[name="invitationPrompt"]');
      await playwrightExpect(invitePrompt).toHaveValue('您好，欢迎参与测试访谈！');

      // Verify questions are pre-filled
      const questionTextareas = page.locator('textarea[name^="questions["]');
      const count = await questionTextareas.count();
      expect(count).toBeGreaterThanOrEqual(2);

      // Version hidden field should be present (type="hidden" — verify via toHaveValue)
      const versionInput = page.locator('input[name="version"]');
      await playwrightExpect(versionInput).toHaveValue('1');
    });
  });

  describe('Template validation error', () => {
    it('should reject template creation with missing questions via API', async () => {
      const resp = await page.context().request.post(`${baseUrl}/admin/api/templates`, {
        headers: {
          'content-type': 'application/json',
          'X-Admin-Key': TEST_API_KEY,
        },
        data: {
          name: 'Validation Test No Questions',
          content: {
            invitationPrompt: 'Some prompt',
            questions: [],
          },
        },
        failOnStatusCode: false,
      });
      expect(resp.status()).toBe(422);
      const body = await resp.text();
      expect(body).toContain('请至少添加一个问题');
    });
  });

  describe('Template publish flow', () => {
    it('should publish a DRAFT template and verify status changes to PUBLISHED', async () => {
      // Create a template via API
      const templateId = await createTemplateViaApi(page, baseUrl, 'E2E 发布测试模板', [
        '问题一：请介绍您的工作经历',
      ]);
      createdTemplateIds.push(templateId);

      // Verify initial status is DRAFT
      const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
        ReturnType<typeof createE2EServer>
      >;
      const initial = await server.prisma.template.findUnique({ where: { id: templateId } });
      expect(initial?.status).toBe('DRAFT');

      // Publish via admin API
      const publishStatus = await publishTemplateViaApi(page, baseUrl, templateId);
      expect([200, 302]).toContain(publishStatus);

      // Verify status changed to PUBLISHED in database
      const published = await server.prisma.template.findUnique({ where: { id: templateId } });
      expect(published?.status).toBe('PUBLISHED');

      // Also verify via the UI detail view
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });
      await page.waitForFunction(
        "!!document.querySelector('aside')?.textContent?.includes('E2E 发布测试模板')",
        { timeout: 8000 }
      );
      await page.click('text=E2E 发布测试模板');
      await page.waitForSelector('h2:has-text("E2E 发布测试模板")', { timeout: 8000 });

      const detailContent = await page.textContent('#main-content');
      expect(detailContent).toContain('已发布');
    });
  });

  describe('Template delete with usage check', () => {
    it('should delete a DRAFT template with no linked plans', async () => {
      // Create a template via API (DRAFT, no linked plans)
      const templateId = await createTemplateViaApi(page, baseUrl, 'E2E 删除测试模板', [
        '问题一：请介绍您的工作经历',
      ]);
      createdTemplateIds.push(templateId);

      const server = (globalThis as Record<string, unknown>)['__E2E_SERVER'] as Awaited<
        ReturnType<typeof createE2EServer>
      >;

      // Check usage stats: should have no ACTIVE/WAITING interviews
      const usageResp = await page.request.get(
        `${baseUrl}/admin/api/templates/${templateId}/stats`,
        { headers: { 'X-Admin-Key': TEST_API_KEY } }
      );
      expect(usageResp.status()).toBe(200);
      const usageData = await usageResp.json();
      expect(usageData.totalInterviews).toBe(0);
      expect(usageData.totalPlans).toBe(0);

      // Delete via admin API
      const deleteResp = await page
        .context()
        .request.delete(`${baseUrl}/admin/api/templates/${templateId}`, {
          headers: {
            'X-Admin-Key': TEST_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          maxRedirects: 0,
        });
      const deleteStatus = deleteResp.status();
      expect([200, 302]).toContain(deleteStatus);

      // Verify template no longer exists
      const deleted = await server.prisma.template.findUnique({ where: { id: templateId } });
      expect(deleted).toBeNull();

      // Remove from cleanup array since we already deleted it
      const idx = createdTemplateIds.indexOf(templateId);
      if (idx !== -1) createdTemplateIds.splice(idx, 1);
    });
  });
});
