import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';
const root = new URL('../../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const evidence = { startedAt: new Date().toISOString(), checks: {}, screenshots: [], consoleErrors: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
await context.grantPermissions(['local-network-access'], { origin: 'https://app.paseo.sh' });
const page = await context.newPage(); page.setDefaultTimeout(8000);
page.on('console', (m) => { if (m.type() === 'error') evidence.consoleErrors.push(m.text().slice(0, 350)); });
page.on('pageerror', (e) => evidence.consoleErrors.push(String(e).slice(0, 350)));
const shot = async (name) => { await page.screenshot({ path: new URL(`../../ideas-ui-${name}.png`, import.meta.url).pathname }); evidence.screenshots.push(`ideas-ui-${name}.png`); };
const has = async (locator) => (await locator.count()) > 0;
try {
  await page.goto('https://app.paseo.sh', { waitUntil: 'networkidle', timeout: 45000 });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByText('Ultra Kanban', { exact: true }).click();
  await page.getByRole('button', { name: /Project: Ultra Kanban/ }).click();
  await page.getByText(/^Ideas UI [a-f0-9]{8}$/).click();
  await page.getByText('Fix stale filter state after refresh', { exact: true }).first().click();
  await page.getByRole('link', { name: 'Open source task Ideas UI source card A' }).waitFor();
  evidence.checks.derivedCardHasNoNewSession = !(await page.getByText('Sessions\n1', { exact: false }).count());
  await page.getByRole('link', { name: 'Open source task Ideas UI source card A' }).click().catch(() => {});
  await page.getByText('Closed · 1', { exact: true }).waitFor();
  evidence.checks.returnedToSource = (await page.locator('body').innerText()).includes('Ideas UI source card A');
  await page.getByText('Closed · 1', { exact: true }).click();
  evidence.checks.acceptedTaskLinkVisible = await has(page.getByRole('link', { name: 'Open task Fix stale filter state after refresh' }));
  await page.getByText('Ideas', { exact: true }).scrollIntoViewIfNeeded();
  await shot('closed-accepted-compact-light');
  await page.getByRole('link', { name: 'Open task Fix stale filter state after refresh' }).click().catch(() => {});
  await page.getByRole('link', { name: 'Open source task Ideas UI source card A' }).waitFor();
  evidence.checks.acceptedLinkOpensNewCard = await has(page.getByText('From idea on Ideas UI source card A', { exact: false }));
  await shot('derived-origin-compact-light');
  await page.getByRole('link', { name: 'Open source task Ideas UI source card A' }).click().catch(() => {});
  await page.getByText('Closed · 1', { exact: true }).waitFor();
  await page.getByText('Ideas', { exact: true }).scrollIntoViewIfNeeded();
  await shot('drawer-compact-light');
  const metrics = await page.evaluate(() => ({ innerWidth, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  evidence.checks.compactLayout = { viewport: { width: 390, height: 844 }, metrics, noHorizontalOverflow: metrics.docWidth <= metrics.innerWidth && metrics.bodyWidth <= metrics.innerWidth, closedGroupVisible: await has(page.getByText('Closed · 1', { exact: true })) };
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(250); await shot('drawer-compact-dark');
  evidence.checks.darkTheme = { bodyBackground: await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor) };
} catch (e) {
  evidence.error = String(e?.stack ?? e).slice(0, 1200);
  try { evidence.tail = (await page.locator('body').innerText()).slice(-1000); } catch {}
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('./compact-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await context.close(); await browser.close();
  console.log(JSON.stringify({ error: evidence.error ?? null, checks: evidence.checks, screenshots: evidence.screenshots, consoleErrors: evidence.consoleErrors }));
}
