import { resolve } from 'node:path';
import nunjucks from 'nunjucks';
import { describe, expect, it } from 'vitest';

describe('login.njk CSRF token', () => {
  const viewsDir = resolve(__dirname, '..', 'src', 'views');
  const env = nunjucks.configure(viewsDir, { autoescape: true, noCache: true });

  it('should include _csrf hidden input in login form', () => {
    const html = env.render('admin/login.njk', {
      error: null,
      csrfToken: 'csrf-value-from-server',
    });

    expect(html).toContain('name="_csrf"');
    expect(html).toContain('type="hidden"');
    expect(html).toContain('value="csrf-value-from-server"');
  });

  it('should render _csrf with value from context', () => {
    const html = env.render('admin/login.njk', {
      error: null,
      csrfToken: 'test-csrf-value-123',
    });

    expect(html).toContain('value="test-csrf-value-123"');
  });
});
