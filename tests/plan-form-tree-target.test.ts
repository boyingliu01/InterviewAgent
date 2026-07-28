import { resolve } from 'node:path';
import nunjucks from 'nunjucks';
import { describe, expect, it } from 'vitest';

describe('plan-form.njk tree target', () => {
  const viewsDir = resolve(__dirname, '..', 'src', 'views');
  const env = nunjucks.configure(viewsDir, { autoescape: true, noCache: true });

  it('should target a DOM element that exists in admin-tree layout', () => {
    // The plan-form refreshes the sidebar tree after creation
    // The sidebar is <aside> in admin-tree.njk (no #tree-panel id)
    const html = env.render('admin/content/plan-form.njk', {
      isEdit: false,
      templates: [],
    });

    // Should target aside (the sidebar element that actually exists)
    // NOT #tree-panel (which doesn't exist in admin-tree.njk)
    expect(html).toContain("htmx.ajax('GET', '/admin', {target: 'aside'");
    expect(html).not.toContain("{target: '#tree-panel'");
  });

  it('should not use non-existent #tree-panel selector', () => {
    // Verify admin-tree.njk does NOT define #tree-panel
    const layoutHtml = env.render('layouts/admin-tree.njk', { templates: [] });
    expect(layoutHtml).toContain('<aside');
    expect(layoutHtml).not.toContain('id="tree-panel"');
  });
});
