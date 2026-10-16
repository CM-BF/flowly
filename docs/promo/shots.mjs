// Release screenshots of the Tinylink demo project. Crops away the host sidebar (personal workspaces)
// and hides every other project's tab (any element whose text is exactly one of HIDE).
// Usage: node docs/promo/shots.mjs [names…]   (no names = all)
import { mkdir } from 'node:fs/promises';
import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';
const out = new URL('./screenshots/', import.meta.url).pathname;
await mkdir(out + 'i18n/', { recursive: true });
await mkdir(out + 'settings/', { recursive: true });
const HIDE = ['Ultra Kanban'];
const only = process.argv.slice(2).length ? new Set(process.argv.slice(2)) : null;
const want = (n) => !only || only.has(n);
const browser = await chromium.launch({ headless: true });

async function hidePrivate(page) {
  await page.evaluate((hide) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n;
      if (!el.children.length && hide.includes(el.textContent.trim()) && el.getBoundingClientRect().x > 300) hits.push(el);
    }
    for (const el of hits) {
      let top = el;
      while (top.parentElement && top.parentElement.textContent.trim() === el.textContent.trim()) top = top.parentElement;
      top.style.display = 'none';
    }
  }, HIDE);
}
async function open({ w, h, scheme = 'light', locale = 'en-US' }) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, locale });
  await context.grantPermissions(['local-network-access'], { origin: 'https://app.paseo.sh' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto('https://app.paseo.sh', { waitUntil: 'networkidle', timeout: 45000 });
  await page.getByText('Flowly', { exact: true }).first().click();
  await page.getByText('Tinylink', { exact: true }).first().click();
  if (locale.startsWith('en')) await page.getByRole('button', { name: /Open task/ }).first().waitFor();
  await page.waitForTimeout(3500);
  await hidePrivate(page);
  return { page, context, errors, clip: { x: 320, y: 0, width: w - 320, height: h } };
}
const shot = async (s, name, clip = s.clip) => { await hidePrivate(s.page); await s.page.screenshot({ path: out + name + '.png', clip }); };
const button = (p, re) => p.getByRole('button', { name: re }).first();

if (want('board')) {
  for (const scheme of ['light', 'dark']) {
    const s = await open({ w: 2300, h: 820, scheme });
    await shot(s, scheme === 'light' ? '01-board-auto-status' : '01-board-auto-status-dark');
    await s.context.close();
  }
}
if (want('drawers')) {
  const s = await open({ w: 1700, h: 1000 });
  await button(s.page, /^Open task Expired links/).click(); await s.page.waitForTimeout(2500); await shot(s, '02-needs-you-drawer');
  await s.page.keyboard.press('Escape'); await s.page.waitForTimeout(700);
  await button(s.page, /^Open task Add rate limiting/).click(); await s.page.waitForTimeout(2500);
  await s.page.getByText('Show more', { exact: true }).first().click().catch(() => {}); await s.page.waitForTimeout(800); await shot(s, '03-card-summary');
  await s.context.close();
}
if (want('ideas')) {
  const s = await open({ w: 1700, h: 1000 });
  await button(s.page, /Project ideas/).click(); await s.page.waitForTimeout(2500); await shot(s, '04-ideas-inbox');
  await s.page.getByText('Good idea', { exact: true }).first().click(); await s.page.waitForTimeout(1200); await shot(s, '04b-good-idea-two-paths');
  await s.context.close();
}
if (want('insights')) {
  for (const scheme of ['light', 'dark']) {
    const s = await open({ w: 1700, h: 1500, scheme });
    await button(s.page, /Project insights/).click(); await s.page.waitForTimeout(3500);
    await shot(s, scheme === 'light' ? '05-insights' : '05-insights-dark');
    await s.context.close();
  }
}
if (want('settings')) {
  const s = await open({ w: 1700, h: 1000 });
  await s.page.locator('[aria-label="Flowly settings"]').last().click(); await s.page.waitForTimeout(1200);
  const box = { x: 320, y: 50, width: 1060, height: 880 };
  await s.page.getByRole('button', { name: 'Models', exact: true }).first().click(); await s.page.waitForTimeout(6000); await shot(s, 'settings/models', box);
  await s.page.getByRole('button', { name: 'Workflow', exact: true }).first().click(); await s.page.waitForTimeout(1500); await shot(s, 'settings/workflow', box);
  await s.context.close();
}
if (want('i18n')) {
  for (const locale of ['ja-JP', 'de-DE', 'zh-CN', 'ru-RU']) {
    const s = await open({ w: 1700, h: 1000, locale });
    await shot(s, `i18n/${locale}-board`);
    await s.context.close();
  }
}
await browser.close();
console.log('done');
