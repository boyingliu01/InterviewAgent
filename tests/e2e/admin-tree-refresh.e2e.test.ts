import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';

// E2E tests need extra time for browser startup, page navigation, and HTMX async swaps
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

describe('Admin Tree Refresh After Plan Creation (E2E - #159 follow-up)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;
  let templateId: string;

  beforeAll(async () => {
    process.env['ADMIN_API_KEY'] = 'test-admin-key';
    const server = await createE2EServer(0);
    baseUrl = server.baseUrl;
    (globalThis as Record<string, unknown>)['__E2E_SERVER'] = server;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      extraHTTPHeaders: { 'X-Admin-Key': 'test-admin-key' },
    });
    page = await context.newPage();

    // === Data setup: create a template via API ===
    const response = await page.context().request.post(`${baseUrl}/api/templates`, {
      headers: {
        'X-Admin-Key': 'test-admin-key',
        'Content-Type': 'application/json',
      },
      data: {
        name: 'E2E Tree Test Template',
        description: 'Template for tree refresh E2E test',
        content: { questions: [{ id: 'q1', text: 'How are you today?' }] },
      },
    });
    const body = await response.json();

    if (response.status() !== 201 && response.status() !== 200) {
      throw new Error(`Failed to create template: ${JSON.stringify(body)}`);
    }
    templateId = body.id;
    expect(templateId).toBeTruthy();
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

  /**
   * Navigate from the admin page to the plan creation form via the UI.
   * Requires HTMX to be loaded on the page (admin page must be loaded first).
   * Clicks the template node in the sidebar, then clicks "创建计划".
   */
  async function openPlanFormViaUI() {
    // Click the template node in the sidebar to load template-info
    await page.click('text=E2E Tree Test Template');

    // Click "创建计划" — wait for the plan form fragment to load
    await page.waitForSelector('button:has-text("创建计划")', { timeout: 8000 });
    await page.click('button:has-text("创建计划")');

    // Wait for the plan form to appear in #main-content
    await page.waitForSelector('#planName', { timeout: 8000 });
    await page.waitForSelector('#plan-submit-btn', { timeout: 5000 });
  }

  describe('Section 1: Login-based E2E (real user flow)', () => {
    it('should login, create plan via HTMX form, and verify tree updates', async () => {
      // Step 1: Login via browser form (CSRF handled by _csrf hidden field now in login.njk)
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });
      await page.fill('#username', 'e2e-admin');
      await page.fill('#password', 'e2e-test-password');

      await Promise.all([
        page.waitForURL('**/admin', { timeout: 10000 }),
        page.click('button[type="submit"]'),
      ]);

      // Step 2: Verify sidebar tree loaded with the template name
      await page.waitForFunction(
        "!!document.querySelector('aside')?.textContent?.includes('E2E Tree Test Template')",
        { timeout: 8000 }
      );

      // Step 3: Navigate to plan form via UI (HTMX loads form within admin layout)
      await openPlanFormViaUI();

      // Step 4: Fill and submit the form
      const planName = 'Login Flow Test Plan';
      await page.fill('#planName', planName);
      await page.selectOption('#templateId', { value: templateId });
      await page.fill('#targetDate', '2026-12-31');

      // Wait for the POST /api/plans response before clicking submit
      const responsePromise2 = page.waitForResponse(
        (res) => res.url().endsWith('/api/plans') && res.request().method() === 'POST',
        { timeout: 10000 }
      );
      await page.click('#plan-submit-btn');
      const planResponse = await responsePromise2;
      expect(planResponse.status()).toBe(200);

      // Give HTMX time to process and reload tree
      await page.waitForTimeout(3000);

      // Step 5: Reload admin page to verify tree data contains the new plan
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      const treeContent = await page.textContent('aside');
      expect(treeContent).toContain(planName);
      expect(treeContent).toContain('E2E Tree Test Template');
    });
  });

  describe('Section 2: API-Key-based E2E (plan-form tree refresh)', () => {
    it('should populate tree with new plan after HTMX form submission', async () => {
      // Step 1: Navigate to admin panel (loads HTMX, sets CSRF cookie)
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      const sidebarText = await page.textContent('aside');
      expect(sidebarText).toBeTruthy();

      // Step 2: Navigate to plan form via UI (HTMX loads form within admin layout)
      await openPlanFormViaUI();

      // Step 3: Fill and submit the form
      const planName = 'API Key Test Plan';
      await page.fill('#planName', planName);
      await page.selectOption('#templateId', { value: templateId });
      await page.fill('#targetDate', '2026-12-31');

      // Wait for the POST response
      const responsePromise = page.waitForResponse(
        (res) => res.url().endsWith('/api/plans') && res.request().method() === 'POST',
        { timeout: 10000 }
      );
      await page.click('#plan-submit-btn');
      const response = await responsePromise;

      expect(response.status()).toBe(200);
      const responseBody = await response.json();
      expect(responseBody.id).toBeTruthy();

      // Step 4: Give HTMX time to process the response and trigger the after-request
      // JS handler which loads plan detail and refreshes the sidebar via HTMX
      await page.waitForTimeout(3000);

      // Step 5: Reload full admin page to verify tree sidebar includes the plan name
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'load' });

      const treeContent = await page.textContent('aside');
      expect(treeContent).toContain(planName);
      expect(treeContent).toContain('E2E Tree Test Template');
    });
  });
});
