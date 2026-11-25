import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createDashboardPreviewServer, dashboardFixture } from './fixture.mjs';

const fixture = dashboardFixture();
const server = await createDashboardPreviewServer({ fixture });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const output = process.env.DASHBOARD_SCREENSHOTS || '/tmp/servus-dashboard-qa';
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const summary = page.locator('.dashboard-service-summary');
  await expect(summary.locator('dd')).toHaveText(['9', '1', '1']);
  await expect(page.getByText('Docker connected', { exact: true })).toBeVisible();
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('listitem')).toHaveCount(3);
  const attentionFilter = attention.getByRole('combobox', { name: 'Filter attention by status' });
  await attentionFilter.selectOption('failed');
  await expect(attention.getByRole('listitem')).toHaveCount(1);
  await expect(attention.getByRole('link', { name: 'Open logs for api' })).toHaveAttribute('href', '/services/api?tab=logs');
  await attentionFilter.selectOption('changes');
  await expect(attention.getByRole('listitem')).toHaveCount(1);
  await expect(attention.getByRole('link', { name: 'Review changes for website' }))
    .toHaveAttribute('href', '/services/website?tab=overview#configuration-changes');
  await attention.getByRole('link', { name: 'Review changes for website' }).click();
  await expect(page.locator('#configuration-changes')).toContainText('Saved revision 3 · Last deployed revision 2');
  await expect(page.locator('#configuration-changes')).toContainText('Changed: Environment.');
  await page.goBack();
  await attentionFilter.selectOption('all');
  const projects = page.locator('#dashboard-projects-title');
  await expect(page.locator('.dashboard-service-card')).toHaveCount(9);
  await expect(page.locator('.dashboard-project-heading h3').first()).toHaveText('Production');
  await expect(page.locator('.dashboard-service-identity strong').first()).toHaveText('api');
  assert.equal(await attention.getByRole('link', { name: 'Open logs for api' }).evaluate(el => el.getBoundingClientRect().bottom < innerHeight), true, 'Failure and its action fit above the fold');

  await expect(page.locator('#dashboard-filters')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Sort projects', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Collapse all', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Logs for api', exact: true })).toHaveAttribute('href', '/services/api?tab=logs');
  await page.getByRole('button', { name: 'Collapse Production', exact: true }).click();
  await expect(page.locator('#project-services-production')).toBeHidden();
  await page.reload();
  await expect(page.locator('#project-services-production')).toBeHidden();
  await page.getByRole('button', { name: 'Expand Production', exact: true }).click();
  await expect(page.locator('.dashboard-service-card:visible')).toHaveCount(9);
  const search = page.getByRole('textbox', { name: 'Search projects and services' });
  await search.fill('website');
  await expect(projects).toHaveText('Projects 1/3');
  await expect(page.locator('.dashboard-service-card')).toHaveCount(1);
  await expect(page.locator('.dashboard-project-meta > span')).toHaveText('1/4 services');
  await search.fill('no-matching-service');
  await expect(projects).toHaveText('Projects 0/3');
  await expect(page.getByText('No projects or services match the current filters.')).toBeVisible();
  await search.fill('');

  for (const width of [375, 768, 1440, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true, `${width}: no horizontal overflow`);
    const website = page.locator('.dashboard-service-identity strong', { hasText: /^website$/ });
    assert.equal(await website.evaluate(el => el.getBoundingClientRect().height < 30), true, `${width}: short names do not break into fragments`);
    const heights = await page.locator('.dashboard-service-entry').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
    assert.equal(new Set(heights).size, 1, `${width}: all service cards have equal height`);
    await page.getByRole('button', { name: 'Error details for api', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Database connection refused');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${output}/overview-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 900 });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const navigation = page.locator('#workspace-navigation');
  await expect(navigation).toBeHidden();
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.screenshot({ path: `${output}/mobile-menu.png` });
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).click();
  await expect(navigation).toBeHidden();
  await menu.click();
  await navigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(navigation).toBeHidden();
  await menu.click();
  await navigation.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(`${base}/activity`);
  await page.goto(base);
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toHaveCount(0);
  await expect(page.locator('#dashboard-filters')).toHaveCount(0);
  await menu.click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(navigation).not.toHaveAttribute('popover');
  await expect(navigation).toBeVisible();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(navigation).toBeHidden();

  const fallback = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
  await fallback.addInitScript(() => { delete HTMLElement.prototype.popover; });
  await fallback.goto(base);
  await fallback.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(fallback.locator('#workspace-navigation')).toBeVisible();
  await fallback.keyboard.press('Escape');
  await expect(fallback.locator('#workspace-navigation')).toBeHidden();
  await fallback.close();

  const loadingPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await loadingPage.route('**/api/v1/projects/production/services', async route => { await pending; await route.continue(); });
  try {
    await loadingPage.goto(base);
    await expect(loadingPage.locator('#project-services-production')).toBeVisible();
    await expect(loadingPage.locator('#project-services-production').getByRole('status', { name: 'Loading services', exact: true })).toBeVisible();
    await expect(loadingPage.locator('.dashboard-service-summary dd')).toHaveText(['—','—','—']);
    await loadingPage.screenshot({ path: `${output}/loading.png` });
    release();
    await expect(loadingPage.locator('#project-services-production .dashboard-service-card')).toHaveCount(4);
  } finally { release(); await loadingPage.close(); }

  fixture.unavailableProject = 'production';
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Service data unavailable.' })).toBeVisible();
  await expect(summary.locator('dd')).toHaveText(['—','—','—']);
  await expect(attention.getByText('Some project data is unavailable.', { exact: false })).toBeVisible();
  await expect(attention.getByRole('link', { name: 'Open logs for api' })).toHaveCount(0);
  await expect(page.locator('.dashboard-project-heading h3').first()).toHaveText('Production');
  await page.screenshot({ path: `${output}/unavailable.png`, fullPage: true });
  fixture.unavailableProject = null;
  fixture.projects = [];
  fixture.services = [];
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await expect(projects).toHaveText('Projects 0');
  await page.screenshot({ path: `${output}/empty.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: measured totals, attention filters and direct actions, partial data, project cards, search, persistence, 4 responsive widths and workspace navigation');
} finally {
  await browser.close();
  await server.close();
}
