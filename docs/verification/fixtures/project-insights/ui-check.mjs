import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';

const dir = new URL('./', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const evidence = { startedAt: new Date().toISOString(), method: 'Playwright headless Chromium 1.63, isolated context, local-network-access granted only to https://app.paseo.sh', checks: {}, screenshots: [], consoleErrors: [], pageErrors: [] };
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await context.grantPermissions(['local-network-access'], { origin: 'https://app.paseo.sh' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('console', (m) => { if (m.type() === 'error') evidence.consoleErrors.push(m.text().slice(0, 500)); });
page.on('pageerror', (e) => evidence.pageErrors.push(String(e).slice(0, 500)));
const body = () => page.locator('body').innerText();
const has = async (locator) => (await locator.count()) > 0;
const shot = async (name, fullPage = false) => { const path = new URL(`${name}.png`, dir); await page.screenshot({ path: path.pathname, fullPage }); evidence.screenshots.push(name + '.png'); };
const note = (key, value) => { evidence.checks[key] = value; };
const openFixture = async () => {
  await page.goto('https://app.paseo.sh', { waitUntil: 'networkidle', timeout: 45000 });
  const plugin = page.getByText('Ultra Kanban', { exact: true });
  await plugin.first().click();
  await page.getByText(fixture.project.title, { exact: true }).waitFor();
  await page.getByText(fixture.project.title, { exact: true }).click();
  await page.getByRole('button', { name: /Open task Insights urgent next card/ }).waitFor();
};

try {
  await openFixture();
  await shot('board-desktop-light');
  const entry = page.getByRole('button', { name: /Project insights/ });
  note('overviewChipVisible', await has(entry));
  await entry.click();
  await page.getByText('Waiting on you', { exact: true }).waitFor();
  await page.getByText('Last 7 days', { exact: true }).waitFor();
  await shot('insights-desktop-light', true);
  let text = await body();
  const expected = { Done: '1', New: '4', Rework: '1', Turns: '1', Commits: '3' };
  const tiles = Object.fromEntries(Object.entries(expected).map(([label, value]) => [label, new RegExp(`${label}\\s+${value}(?:\\s+avg|\\s+\\+\\d)`, 'i').test(text)]));
  const tileLabels = await page.locator('[aria-label*="7-day average"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  note('tiles', { expected, matched: tiles, agentTimeShown: /Agent time\s+\S+\s+avg/i.test(text), sevenDayAveragesShown: tileLabels.length === 6, accessibilityTileLabels: tileLabels, text: text.slice(0, 1400) });
  note('waitingRows', { reviewCard: text.includes('Insights review flow card'), secondReviewCard: text.includes('Insights second review card'), waitedDuration: /In Review[\s\S]{0,140}(?:\d+m|\d+h|now)/i.test(text) });
  note('r7', { expected: 'Nothing is running. Next up: “Insights urgent next card”.', matched: text.includes('Nothing is running. Next up: “Insights urgent next card”.'), urgentCardListed: text.includes('Insights urgent next card') });
  const reviewRow = page.getByText('Insights review flow card', { exact: true }).last();
  note('waitingRowVisible', await has(reviewRow));
  if (await has(reviewRow)) {
    await reviewRow.click();
    await page.getByText('Insights review flow card', { exact: true }).last().waitFor();
    note('waitingRowOpensCard', true);
    await shot('waiting-card-drawer-desktop-light');
    await page.keyboard.press('Escape');
    await page.getByText('Waiting on you', { exact: true }).waitFor();
  }
  const r7Text = page.getByText('Nothing is running. Next up:', { exact: false });
  const openUrgent = page.getByRole('button', { name: 'Open Insights urgent next card' });
  if (await has(openUrgent)) {
    await openUrgent.click();
    await page.getByText('Insights urgent next card', { exact: true }).last().waitFor();
    note('r7OpensCard', true);
    await shot('r7-card-drawer-desktop-light');
    await page.keyboard.press('Escape');
    await page.getByText('Waiting on you', { exact: true }).waitFor();
  } else note('r7OpensCard', { unrun: true, reason: await r7Text.count() });

  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByText('Yesterday', { exact: true }).waitFor();
  const yesterdayText = await body();
  note('dayNavigationYesterday', { showsYesterday: yesterdayText.includes('Yesterday'), waitingHidden: !yesterdayText.includes('Waiting on you'), suggestionsHidden: !yesterdayText.includes('Suggestions') });
  await page.getByRole('button', { name: 'Next day' }).click();
  await page.getByText('Today', { exact: true }).first().waitFor();
  note('dayNavigationToday', { returnedToToday: true, nextDisabled: await page.getByRole('button', { name: 'Next day' }).isDisabled() });

  const digestPreText = await body();
  const digestNeedsGeneration = digestPreText.includes('Generate a summary of today so far.');
  if (digestNeedsGeneration) {
    await page.getByText('Generate', { exact: true }).click();
    await page.getByText('Generating…', { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    note('digestGeneratingObserved', await has(page.getByText('Generating…', { exact: true })));
    await page.waitForFunction(() => !document.body.innerText.includes('Generating…'), { timeout: 125000 }).catch(() => {});
  } else {
    note('digestGeneratingObserved', 'UNRUN this pass; summary had already been generated in the previous run.');
  }
  text = await body();
  note('digest', { headlineOrError: text.match(/Last attempt failed:[^\n]+/)?.[0] ?? text.match(/Updated[^\n]+/)?.[0] ?? null, groupedBullets: ['Done', 'Progressed', 'Issues', 'Next'].filter((x) => text.includes(x)), updatedModel: /Updated .* · .+/.test(text), generatingEnded: !text.includes('Generating…'), emptyNoActivity: text.includes('No activity on this day.'), generatedInThisPass: digestNeedsGeneration, tail: text.slice(-1300) });
  await shot('digest-desktop-light', true);
  const digestLink = page.getByRole('link', { name: 'Open Insights completed card' });
  note('digestCardLinkVisible', await has(digestLink));
  if (await has(digestLink)) {
    await digestLink.click();
    await page.getByText('Insights completed card', { exact: true }).last().waitFor();
    note('digestCardLinkOpensCard', true);
    await shot('digest-card-drawer-desktop-light');
    await page.keyboard.press('Escape');
    await page.getByText('Summary', { exact: true }).waitFor();
  }
  // The session is archived in the digest service's finally block; captured by cleanup script via agent list.

  await page.getByText('Last 7 days', { exact: true }).click();
  await page.getByText('Most changed files', { exact: true }).waitFor();
  text = await body();
  note('lastSevenDays', { sectionOpen: true, topFiles: text.includes('src.txt') && text.includes('README.md'), medians: /Median time in each lane/.test(text), bars: (await page.locator('[aria-label*="2026-"]').count()) >= 7, tail: text.slice(-1000) });
  await shot('trend-desktop-light', true);

  await page.getByRole('button', { name: /Back to board/ }).click();
  await page.getByText('Insights review flow card', { exact: true }).last().waitFor();
  note('boardReturnButton', true);
  await page.evaluate(() => {
    const root = [...document.querySelectorAll('div[tabindex="0"]')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.x >= 300 && r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.8;
    });
    root?.focus();
  });
  await page.keyboard.press('i');
  await page.getByText('Waiting on you', { exact: true }).waitFor();
  note('keyboardIToggle', true);
  await page.keyboard.press('Escape');
  await page.getByText('Insights review flow card', { exact: true }).last().waitFor();
  note('escapeReturn', true);
  await shot('keyboard-board-return-desktop-light');

  await page.setViewportSize({ width: 390, height: 844 });
  await entry.click().catch(async () => page.getByRole('button', { name: /Project insights/ }).click());
  await page.getByText('Waiting on you', { exact: true }).waitFor();
  const geometryLight = await page.evaluate(() => ({ innerWidth, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  const collapsedLight = !(await has(page.getByText('Most changed files', { exact: true })));
  note('compactLight', { geometry: geometryLight, noHorizontalOverflow: geometryLight.docWidth <= geometryLight.innerWidth && geometryLight.bodyWidth <= geometryLight.innerWidth, trendCollapsedByDefault: collapsedLight });
  await shot('insights-compact-light', true);
  await page.getByText('Last 7 days', { exact: true }).click();
  await page.getByText('Most changed files', { exact: true }).waitFor();
  await shot('trend-compact-light', true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  const geometryDark = await page.evaluate(() => ({ innerWidth, docWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  note('compactDark', { geometry: geometryDark, noHorizontalOverflow: geometryDark.docWidth <= geometryDark.innerWidth && geometryDark.bodyWidth <= geometryDark.innerWidth });
  await shot('trend-compact-dark', true);
  note('compactControlsVisible', { back: await has(page.getByRole('button', { name: /Back to board/ })), previous: await has(page.getByRole('button', { name: 'Previous day' })), next: await has(page.getByRole('button', { name: 'Next day' })) });
} catch (error) {
  evidence.error = String(error?.stack ?? error).slice(0, 2000);
  try { evidence.pageTail = (await body()).slice(-2500); } catch {}
  await shot('ui-error-state').catch(() => {});
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('./ui-evidence.json', dir), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ error: evidence.error ?? null, checks: evidence.checks, screenshots: evidence.screenshots, consoleErrors: evidence.consoleErrors, pageErrors: evidence.pageErrors }, null, 2));
}
