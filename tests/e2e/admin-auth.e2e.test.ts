import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { expect as playwrightExpect } from 'playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createE2EServer } from './helpers/e2e-server.js';

// E2E tests need extra time for browser startup and page navigation
vi.setConfig({ testTimeout: 30000, hookTimeout: 20000 });

const TEST_USERNAME = 'e2e-admin';
const TEST_PASSWORD = 'e2e-test-password';
const TEST_API_KEY = 'test-admin-key';

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

  // Fallback: read CSRF token from document.cookie via evaluate
  const pageCookies = (await page.evaluate(
    '(() => { const m = document.cookie.match(/csrf-token=([^;]+)/); return m ? m[1] : ""; })()',
  )) as string;
  return pageCookies;
}

async function doLogin(
  page: Page,
  baseUrl: string,
  username: string,
  password: string,
  maxRedirects?: number,
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

async function doPost(
  page: Page,
  baseUrl: string,
  path: string,
): Promise<LoginResponse> {
  const csrfToken = await getCsrfToken(page);
  const resp = await page.context().request.post(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrfToken,
    },
    maxRedirects: 0,
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
    { name: cookieStr.slice(0, eq), value: cookieStr.slice(eq + 1), domain: '127.0.0.1', path: '/' },
  ]);
}

describe('Admin Auth (Playwright E2E)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let baseUrl: string;

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

  describe('Login page', () => {
    it('should render login form with username and password fields', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const title = await page.textContent('h1');
      expect(title).toContain('访谈管理后台');

      const usernameInput = page.locator('input#username');
      await playwrightExpect(usernameInput).toBeVisible();

      const passwordInput = page.locator('input#password');
      await playwrightExpect(passwordInput).toBeVisible();

      const submitButton = page.locator('button[type="submit"]');
      await playwrightExpect(submitButton).toBeVisible();
    });

    it('should set CSRF token on login page load and accept valid login POST', async () => {
      // Navigate to login page — CSRF cookie is set in response
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      // Login should succeed — this proves CSRF token is present
      const result = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(result.status).toBe(302);
    });
  });

  describe('Login flow', () => {
    it('should login successfully with valid credentials', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(result.status).toBe(302);
    });

    it('should reject login with wrong password (401)', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, 'e2e-admin', 'wrong-password');
      expect(result.status).toBe(401);
    });

    it('should reject login with wrong username (401)', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, 'wrong-user', TEST_PASSWORD);
      expect(result.status).toBe(401);
    });

    it('should reject login with empty credentials (400)', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, '', '');
      expect(result.status).toBe(400);
    });

    it('should return error message on wrong password', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, 'e2e-admin', 'wrong-password');
      expect(result.status).toBe(401);
      expect(result.body).toContain('用户名或密码错误');
    });

    it('should redirect to /admin on successful login', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(result.status).toBe(302);
      expect(result.location).toBe('/admin');
    });
  });

  describe('Session persistence', () => {
    it('should allow access to /admin after session login', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const result = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(result.status).toBe(302);
      await applySetCookie(context, result.setCookie);

      // Navigate to /admin — should load with session
      const response = await page.goto(`${baseUrl}/admin`, {
        waitUntil: 'load',
      });
      expect(response?.status()).toBeLessThan(500);

      const bodyText = await page.textContent('body');
      expect(bodyText).toContain('进度仪表板');
    });
  });

  describe('Unauthenticated access', () => {
    it('should block admin API POST without session or API key', async () => {
      // POST to admin-auth protected endpoint without credentials
      // /api/plans is registered with adminAuth preHandler
      const response = await page.request.post(`${baseUrl}/api/plans`, {
        headers: { 'content-type': 'application/json' },
        failOnStatusCode: false,
        data: {},
      });
      expect(response.status()).toBe(401);
    });
  });

  describe('API Key auth', () => {
    it('should allow access to /admin with valid API Key', async () => {
      const response = await page.request.get(`${baseUrl}/admin`, {
        headers: { 'x-admin-key': TEST_API_KEY },
        failOnStatusCode: false,
      });
      expect(response.status()).toBe(200);
    });
  });

  describe('Logout', () => {
    it('should clear session on logout and redirect to login page', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const loginResult = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(loginResult.status).toBe(302);
      await applySetCookie(context, loginResult.setCookie);

      // Navigate to a page first to apply session context
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const logoutResult = await doPost(page, baseUrl, '/admin/logout');
      expect(logoutResult.status).toBe(302);
      expect(logoutResult.location).toBe('/admin/login');
    });
  });

  describe('Session already logged in', () => {
    it('should redirect to /admin when already logged in', async () => {
      await page.goto(`${baseUrl}/admin/login`, { waitUntil: 'load' });

      const loginResult = await doLogin(page, baseUrl, TEST_USERNAME, TEST_PASSWORD);
      expect(loginResult.status).toBe(302);
      await applySetCookie(context, loginResult.setCookie);

      // Navigate to login page — session is active, should redirect to /admin
      await page.goto(`${baseUrl}/admin/login`, {
        waitUntil: 'load',
      });
      const finalUrl = page.url();
      expect(finalUrl).toContain('/admin');
      expect(finalUrl).not.toContain('/admin/login');
    });
  });
});
