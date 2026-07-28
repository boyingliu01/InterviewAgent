import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { resolve } from 'node:path';

describe('plan-form.njk tree refresh', () => {
  const viewsDir = resolve(__dirname, '..', 'src', 'views');
  const env = nunjucks.configure(viewsDir, { autoescape: true, noCache: true });

  it('should refresh sidebar tree after creating a new plan', () => {
    // Render the create form (isEdit: false)
    const html = env.render('admin/content/plan-form.njk', {
      isEdit: false,
      templates: [],
    });

    // After creating, BOTH main-content AND tree-panel should refresh
    expect(html).toContain("htmx.ajax('GET', '/admin/content/plans/' + resp.id");
    // The fix: add sidebar refresh
    expect(html).toContain("htmx.ajax('GET', '/admin', {target: 'aside'");
  });

  it('should preserve main-content refresh on edit', () => {
    const html = env.render('admin/content/plan-form.njk', {
      isEdit: true,
      templates: [],
      plan: { id: 'plan-123', name: 'Test' },
    });

    expect(html).toContain("htmx.ajax('GET', '/admin/content/plans/plan-123'");
  });
});
