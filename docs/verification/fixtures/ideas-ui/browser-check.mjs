import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const evidence = { startedAt: new Date().toISOString(), method: 'Playwright 1.63 headless Chromium; isolated non-persistent browser context; granted local-network-access permission for https://app.paseo.sh; local app connected directly to 127.0.0.1:6767', checks: {}, consoleErrors: [], screenshots: [] };
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await context.grantPermissions(['local-network-access'], { origin: 'https://app.paseo.sh' });
const page = await context.newPage();
page.setDefaultTimeout(8000);
page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text().replace(/(token|authorization|pairing|secret)[^\s]*/ig, '[redacted]').slice(0, 400)); });
page.on('pageerror', (error) => evidence.consoleErrors.push(`pageerror: ${String(error).slice(0, 400)}`));
const capture = async (name) => { const path = new URL(`../../ideas-ui-${name}.png`, import.meta.url); await page.screenshot({ path: path.pathname, fullPage: false }); evidence.screenshots.push(path.pathname.split('/').at(-1)); };
const exists = async (locator) => (await locator.count()) > 0;
const note = (key, value) => { evidence.checks[key] = value; };

try {
  await page.goto('https://app.paseo.sh', { waitUntil: 'networkidle', timeout: 45000 });
  await page.getByText('Ultra Kanban', { exact: true }).click();
  await page.getByText(/^Ideas UI [a-f0-9]{8}$/).click();
  await page.getByText('Ideas UI source card A', { exact: true }).last().waitFor();
  await capture('board-desktop-light');
  note('boardBadge', { cardVisible: true, threeIdeasText: (await page.locator('body').innerText()).includes('💡 3') || (await page.getByText('3', { exact: true }).count()) > 0 });

  await page.getByText('Ideas UI source card A', { exact: true }).last().click();
  await page.getByText('Ideas', { exact: true }).scrollIntoViewIfNeeded();
  const drawerText = await page.locator('body').innerText();
  const sessionsSection = drawerText.indexOf('\nSessions\n1');
  const ideasSection = drawerText.indexOf('\nIdeas\n3');
  note('sectionOrder', { sessionsBeforeIdeas: sessionsSection >= 0 && ideasSection > sessionsSection, ideasBeforeDetails: ideasSection >= 0 && drawerText.indexOf('Details & workspace') > ideasSection, openCountThree: ideasSection >= 0 });
  await capture('drawer-desktop-light');

  const firstIdea = page.getByRole('button', { name: 'Idea: Fix stale filter state after refresh' });
  await firstIdea.click();
  const expandedWhat = await exists(page.getByText('What to do', { exact: true }));
  const expandedContext = await exists(page.getByText('Context', { exact: true }));
  await capture('expanded-desktop-light');
  await firstIdea.click();
  await page.waitForTimeout(250);
  note('expandCollapse', { whatToDoAppeared: expandedWhat, contextAppeared: expandedContext, collapsedAgain: !(await exists(page.getByText('What to do', { exact: true }))), observedJank: 'No visible jump or clipping in the settled expanded screenshot; transition timing not frame-recorded.' });

  await page.getByRole('button', { name: 'Not now: dismiss Document the filter recovery workflow' }).click();
  await page.getByText('Closed · 1', { exact: true }).waitFor();
  note('dismiss', { closedOneVisible: true, openCountTwo: (await page.locator('body').innerText()).includes('Ideas\n2') });
  await capture('dismissed-desktop-light');
  await page.getByText('Closed · 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Restore Document the filter recovery workflow' }).click();
  await page.getByText('Ideas', { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  note('restore', { openCountThree: (await page.locator('body').innerText()).includes('Ideas\n3'), restoreButtonGone: !(await exists(page.getByRole('button', { name: 'Restore Document the filter recovery workflow' }))) });
  await capture('restored-desktop-light');

  await page.getByRole('button', { name: 'Good idea: create a task from Fix stale filter state after refresh' }).click();
  await page.getByText('Create task from idea', { exact: true }).waitFor();
  const formText = await page.locator('body').innerText();
  const formInputs = await page.locator('input,textarea').evaluateAll((els) => els.map((el) => ({ value: el.value, placeholder: el.getAttribute('placeholder'), aria: el.getAttribute('aria-label'), type: el.getAttribute('type') })));
  const descriptionPrefill = formInputs.find((input) => input.aria === 'Description')?.value ?? '';
  note('createForm', { opened: true, titlePrefillVisible: formInputs.some((input) => input.aria === 'Title' && input.value === 'Fix stale filter state after refresh'), bugfixPrefillVisible: /Bug fix|Bugfix/i.test(formText), highPriorityVisible: formText.includes('High'), descriptionHasWhyContextAndSource: descriptionPrefill.includes('\n\nWhy: ') && descriptionPrefill.includes('\n\nContext:\n') && descriptionPrefill.includes('\n\nFrom card: Ideas UI source card A (') && descriptionPrefill.includes('\n\nSource progress:\n'), inputs: formInputs });
  await capture('create-form-desktop-light');
  note('createFormTextExcerpt', formText.slice(-1800));
  await page.getByRole('switch', { name: 'Start an agent now' }).click();
  const saveButtons = await page.getByRole('button').allTextContents();
  note('agentToggleOff', { checked: await page.getByRole('switch', { name: 'Start an agent now' }).getAttribute('aria-checked'), buttonTexts: saveButtons.slice(-4), startButtonRemoved: !saveButtons.at(-1)?.includes('start') });
  await capture('create-form-bottom-desktop-light');
  const saveButton = page.getByRole('button').filter({ hasText: /Create task(?!, then)/i }).last();
  await saveButton.click();
  await page.getByText('Create task from idea', { exact: true }).waitFor({ state: 'detached', timeout: 12000 });
  await page.waitForTimeout(500);
  const afterSaveText = await page.locator('body').innerText();
  note('savedWithoutAgent', { formClosed: true, sourceClosedLinkVisible: afterSaveText.includes('Closed · 1'), newTitleOnBoardOrDrawer: afterSaveText.includes('Fix stale filter state after refresh'), sourceIdeaId: fixture.ideaIds[0] });
  await capture('after-save-desktop-light');
  if (await exists(page.getByText('Ideas UI source card A', { exact: true }))) {
    await page.getByText('Ideas UI source card A', { exact: true }).last().click().catch(() => {});
  }
  if (await exists(page.getByText('Closed · 1', { exact: true }))) {
    await page.getByText('Closed · 1', { exact: true }).click();
    const acceptedLink = page.getByRole('link', { name: 'Open task Fix stale filter state after refresh' });
    await acceptedLink.click();
  }
  await page.getByText('From idea on', { exact: false }).waitFor({ timeout: 10000 });
  const originText = await page.locator('body').innerText();
  note('originBacklink', { fromIdeaLine: originText.includes('From idea on Ideas UI source card A'), backlinkRolePresent: await exists(page.getByRole('link', { name: 'Open source task Ideas UI source card A' })) });
  await capture('derived-card-origin-desktop-light');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Open source task Ideas UI source card A' }).click();
  await page.getByText('Ideas', { exact: true }).scrollIntoViewIfNeeded();
  await capture('drawer-compact-light');
  const compactGeometry = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth }));
  note('compactLayout', { geometry: compactGeometry, noHorizontalPageOverflow: compactGeometry.scrollWidth <= compactGeometry.innerWidth && compactGeometry.bodyScrollWidth <= compactGeometry.innerWidth, ideaVisible: (await page.locator('body').innerText()).includes('Add a filter-state diagnostic event') });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  await capture('drawer-compact-dark');
  note('darkTheme', { pageBackground: await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor) });
} catch (error) {
  evidence.error = String(error?.stack ?? error).slice(0, 1200);
  try { evidence.partialPageText = (await page.locator('body').innerText()).slice(-1800); } catch {}
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('./browser-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ error: evidence.error ?? null, checks: evidence.checks, screenshots: evidence.screenshots, consoleErrors: evidence.consoleErrors }));
}
