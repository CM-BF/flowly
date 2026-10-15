import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';
const dir = new URL('./', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const evidence = { startedAt: new Date().toISOString(), viewport: { width: 390, height: 844 }, method: 'Playwright headless Chromium 1.63, isolated context, local-network-access granted only to https://app.paseo.sh', checks: {}, screenshots: [], consoleErrors: [], pageErrors: [] };
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: evidence.viewport, colorScheme: 'light' });
await context.grantPermissions(['local-network-access'], { origin: 'https://app.paseo.sh' });
const page = await context.newPage(); page.setDefaultTimeout(10000);
page.on('console', (m) => { if (m.type() === 'error') evidence.consoleErrors.push(m.text().slice(0, 500)); });
page.on('pageerror', (e) => evidence.pageErrors.push(String(e).slice(0, 500)));
const shot = async (name) => { await page.screenshot({ path: new URL(`${name}.png`, dir).pathname, fullPage: true }); evidence.screenshots.push(`${name}.png`); };
const has = async (l) => (await l.count()) > 0;
const navToFixture = async () => {
  await page.goto('https://app.paseo.sh', { waitUntil: 'networkidle', timeout: 45000 });
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await has(menu)) await menu.click();
  await page.getByText('Ultra Kanban', { exact: true }).first().click();
  const currentProject = page.getByRole('button', { name: /Project: Ultra Kanban/ });
  if (await has(currentProject)) {
    await currentProject.click();
    await page.getByRole('button', { name: fixture.project.title, exact: true }).click();
  }
  await page.getByRole('button', { name: /Open task Insights urgent next card/ }).waitFor();
};
try {
  await navToFixture();
  await shot('board-compact-light');
  const entry = page.getByRole('button', { name: /Project insights/ });
  evidence.checks.insightsEntryVisible = await has(entry);
  await entry.scrollIntoViewIfNeeded(); await entry.click();
  await page.getByText('Waiting on you', { exact: true }).waitFor();
  const metrics = await page.evaluate(() => ({ innerWidth, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  const tileLabels = await page.locator('[aria-label*="7-day average"]').evaluateAll((els) => els.map((el) => ({ label: el.getAttribute('aria-label'), y: Math.round(el.getBoundingClientRect().y) })));
  evidence.checks.compactLight = { metrics, noHorizontalOverflow: metrics.docWidth <= metrics.innerWidth && metrics.bodyWidth <= metrics.innerWidth, tileLabels, tilesWrap: new Set(tileLabels.map((x) => x.y)).size > 1, trendCollapsedByDefault: !(await has(page.getByText('Most changed files', { exact: true }))) };
  evidence.checks.headerControls = { back: await has(page.getByRole('button', { name: /Back to board/ })), previous: await has(page.getByRole('button', { name: 'Previous day' })), next: await has(page.getByRole('button', { name: 'Next day' })) };
  await shot('insights-compact-light');
  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByText('Yesterday', { exact: true }).first().waitFor();
  evidence.checks.compactPreviousUsable = true;
  await page.getByRole('button', { name: 'Next day' }).click();
  await page.getByText('Today', { exact: true }).first().waitFor();
  evidence.checks.compactNextUsable = await page.getByRole('button', { name: 'Next day' }).isDisabled();
  await page.getByText('Last 7 days', { exact: true }).click();
  await page.getByText('Most changed files', { exact: true }).waitFor();
  evidence.checks.compactTrendOpens = true;
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
  const darkMetrics = await page.evaluate(() => ({ innerWidth, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, background: getComputedStyle(document.body).backgroundColor }));
  evidence.checks.compactDark = { metrics: darkMetrics, noHorizontalOverflow: darkMetrics.docWidth <= darkMetrics.innerWidth && darkMetrics.bodyWidth <= darkMetrics.innerWidth };
  await shot('insights-compact-dark');
} catch (error) {
  evidence.error = String(error?.stack ?? error).slice(0, 1600);
  try { evidence.tail = (await page.locator('body').innerText()).slice(-1000); await shot('compact-error'); } catch {}
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('./compact-evidence.json', dir), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await context.close(); await browser.close();
  console.log(JSON.stringify({ error: evidence.error ?? null, checks: evidence.checks, screenshots: evidence.screenshots, consoleErrors: evidence.consoleErrors, pageErrors: evidence.pageErrors }, null, 2));
}
