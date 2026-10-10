import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiApiResponse, uiUploadTasks } from '../tests/helpers/ui-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const output = process.env.UI_OUTPUT_DIR;
const pages = ['library', '', 'download', 'book?id=book-1', 'edit?id=book-1', 'users', 'tags', 'login'];
const widths = [320, 375, 768, 999, 1000, 1440, 1920];
const failures = [];
let checks = 0;

async function serve(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1) + (extname(path) ? '' : '.html');
  const target = resolve(ROOT, 'public', file);
  if (!target.startsWith(join(ROOT, 'public') + '/')) return response.writeHead(403).end();
  try {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end();
  }
}

async function seedStorage(context) {
  await context.addInitScript((tasks) => {
    localStorage.setItem('cf-book-download-history', JSON.stringify(tasks.map((item) => ({
      filename: item.filename, size: item.size, status: 'done', finishedAt: item.createdAt,
    }))));
    const open = indexedDB.open('cf-book-uploads', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('tasks', { keyPath: 'id' });
      open.result.createObjectStore('blobs');
    };
    open.onsuccess = () => {
      const transaction = open.result.transaction('tasks', 'readwrite');
      for (const task of tasks) transaction.objectStore('tasks').put(task);
      transaction.oncomplete = () => open.result.close();
    };
  }, uiUploadTasks);
}

async function mockApi(context) {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), 'GET', '布局验收不得发起业务写入');
    await route.fulfill({ json: uiApiResponse(url.pathname, url.searchParams, new URL(route.request().frame().url()).pathname) });
  });
  await context.route('**/__ui__/**', async (route) => {
    const index = Number(route.request().url().match(/cover-(\d)/)?.[1]) || 0;
    const palettes = ['#a74532', '#526c62', '#bd9b6b', '#445669', '#827158', '#776156'];
    await route.fulfill({ contentType: 'image/svg+xml', body:
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="${palettes[index]}"/><rect x="18" y="18" width="204" height="324" fill="none" stroke="#e9dfc8"/><text x="120" y="150" text-anchor="middle" fill="#fff6e4" font-size="24" font-family="serif">${['山河之间', '长夜书简', '海风与旅人', '时间的纹理', '自然与万物', '城市漫游'][index]}</text><text x="120" y="290" text-anchor="middle" fill="#fff6e4" font-size="14">CF-Book</text></svg>` });
  });
}

async function record(name, fn) {
  checks += 1;
  try { await fn(); } catch (error) { failures.push(`${name}：${error.message}`); }
}

async function assertLayout(page) {
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    outside: [...document.querySelectorAll('main input, main select, main button, .task-item, .panel')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
      }).slice(0, 4).map((element) => element.id || element.className),
  }));
  assert.ok(layout.scroll <= layout.width + 1 && !layout.outside.length, JSON.stringify(layout));
}

async function checkTableCards(page, name, width) {
  const table = { download: '#tasks', users: '#user-table', tags: '#tag-table' }[name];
  if (!table || width > 700) return;
  const labels = await page.locator(`${table} tbody tr`).first().locator('td').evaluateAll((cells) =>
    cells.every((cell) => cell.getAttribute('data-label')));
  assert.equal(labels, true, '手机卡片必须标注每一项字段');
}

async function waitForContent(page, name) {
  const ready = { library: '#books .book-card', '': '#upload-queue .task-item', download: '#tasks tbody tr',
    book: '#shelf-picker .shelf-check', edit: '#tag-type option:nth-child(2)',
    users: '#user-table tbody tr', tags: '#tag-table tbody tr', login: '#auth-form' }[name];
  await page.locator(ready).first().waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
}

async function checkPage(browser, base, route, width) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce',
    isMobile: width < 700, hasTouch: width < 700 });
  await seedStorage(context);
  await mockApi(context);
  const page = await context.newPage();
  const errors = [];
  const recommendationRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/books' && url.searchParams.get('recommended') === '1') {
      recommendationRequests.push(url.href);
    }
  });
  page.setDefaultTimeout(5000);
  const name = route.split('?')[0];
  await page.goto(`${base}/${route}`);
  await waitForContent(page, name);
  const label = `${name || 'upload'} @ ${width}`;
  await record(`${label} 页面无横向溢出`, () => assertLayout(page));
  await record(`${label} 无脚本异常`, () => assert.deepEqual(errors, []));
  await record(`${label} 手机字段标签`, () => checkTableCards(page, name, width));
  if (width <= 999) await record(`${label} 触摸操作区域`, () => checkTouchTargets(page));
  if (name === 'library') {
    await checkLibrary(page, label);
    await checkRecommendationStability(page, label, width, recommendationRequests);
    if (width === 1440) await checkPendingRecommendation(page, label, recommendationRequests);
  }
  if (name === 'tags') await checkTagEditor(page, label);
  if (name === '') await checkImportFilter(page, label);
  if (name === 'download') await checkTaskFilter(page, label);
  if (output && [375, 1440].includes(width)) {
    await page.screenshot({ path: join(output, `${name || 'upload'}-${width}.png`), fullPage: true });
    await page.screenshot({ path: join(output, `${name || 'upload'}-${width}-viewport.png`) });
  }
  if (name !== 'login') await checkNavigation(page, label, width);
  await context.close();
}

async function checkLibrary(page, label) {
  await record(`${label} 推荐与馆藏列数一致`, async () => {
    const size = await page.locator('#books').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.equal(await page.locator('#recommend-books .book-card').count(), size);
    assert.equal(await page.locator('#books .book-card').count(), size * 4);
  });
  await record(`${label} 书架管理展开不溢出`, async () => {
    await page.locator('.shelf-manager > summary').click();
    await assertLayout(page);
    await page.locator('.shelf-manager > summary').click();
  });
}

async function recommendationIds(page) {
  return page.locator('#recommend-books .book-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')));
}

async function checkRecommendationStability(page, label, width, requests) {
  await page.locator('#refresh-recommendations').waitFor();
  await page.waitForFunction(() => !document.querySelector('#refresh-recommendations').disabled);
  const original = await recommendationIds(page);
  const before = requests.length;
  await record(`${label} 滚动与高度变化不重抽推荐`, async () => {
    await page.mouse.wheel(0, 500);
    await page.setViewportSize({ width, height: 720 });
    await page.waitForTimeout(350);
    assert.equal(requests.length, before, '地址栏或软键盘导致的高度变化不得重抽推荐');
    assert.deepEqual(await recommendationIds(page), original);
  });
  await record(`${label} 横竖屏切换不重抽推荐`, async () => {
    await page.setViewportSize({ width: width < 1000 ? 1440 : 375, height: 960 });
    await page.waitForTimeout(350);
    assert.equal(requests.length, before, '跨列数断点只重排现有推荐');
    assert.deepEqual(await recommendationIds(page), original);
    await assertLayout(page);
  });
  await page.setViewportSize({ width, height: 960 });
  await page.waitForTimeout(350);
  await record(`${label} 主动换一批仍可用`, async () => {
    const count = requests.length;
    await page.locator('#refresh-recommendations').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-recommendations').disabled);
    assert.equal(requests.length, count + 1);
  });
  await record(`${label} 刷新页面重新请求推荐`, async () => {
    const count = requests.length;
    await page.reload();
    await waitForContent(page, 'library');
    await page.waitForFunction(() => document.querySelectorAll('#recommend-books .book-card').length > 0);
    assert.equal(requests.length, count + 1);
  });
}

async function checkPendingRecommendation(page, label, requests) {
  const pattern = '**/api/books?*';
  await page.route(pattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('recommended') !== '1') return route.fallback();
    await new Promise((done) => setTimeout(done, 700));
    await route.fulfill({ json: uiApiResponse(url.pathname, url.searchParams, '/library') });
  });
  await record(`${label} 推荐加载中切换宽度不新增请求`, async () => {
    const count = requests.length;
    await page.reload();
    await page.setViewportSize({ width: 375, height: 960 });
    await page.waitForFunction(() => !document.querySelector('#refresh-recommendations').disabled &&
      document.querySelectorAll('#recommend-books .book-card').length > 0);
    assert.equal(requests.length, count + 1);
    assert.equal(await page.locator('#recommend-books .book-card').count(), 6, '推荐保留首次加载时抽取的书籍');
    await assertLayout(page);
  });
  await page.unroute(pattern);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForFunction(() => document.querySelectorAll('#recommend-books .book-card').length === 6 &&
    document.querySelector('.library-menu').open);
}

async function checkTouchTargets(page) {
  const small = await page.locator('main button, main select, label[role="button"], .shelf-check, .theme-toggle').evaluateAll((elements) =>
    elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.height < 44 || rect.width < 44);
    }).map((element) => element.id || element.className));
  assert.deepEqual(small, [], '手机操作区域至少 44px');
}

async function checkImportFilter(page, label) {
  await record(`${label} 导入报告筛选接线`, async () => {
    await page.getByRole('button', { name: '失败', exact: true }).click();
    assert.equal(await page.locator('#upload-queue .task-item').count(), 1);
    assert.equal(await page.getByRole('button', { name: '失败', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '全部', exact: true }).click();
    assert.equal(await page.locator('#upload-queue .task-item').count(), 3);
  });
}

async function checkTaskFilter(page, label) {
  await record(`${label} 下载列表筛选接线`, async () => {
    await page.locator('#task-status').selectOption('completed');
    assert.equal(await page.locator('#tasks tbody tr').count(), 2);
    await page.locator('#task-status').selectOption('');
    assert.equal(await page.locator('#tasks tbody tr').count(), 4);
  });
}

async function checkTagEditor(page, label) {
  await record(`${label} 标签编辑不溢出`, async () => {
    await page.locator('#tag-table button[data-action="edit"]').first().click();
    await assertLayout(page);
    await page.locator('#tag-table button[data-action="cancel"]').click();
  });
}

async function checkNavigation(page, label, width) {
  await record(`${label} 导航可达`, async () => {
    if (width < 1000) await page.locator('.library-menu > summary').click();
    await assertLayout(page);
    assert.equal(await page.locator('.library-menu-list > a[href="/download"]').isVisible(), true);
    if (width < 1000) {
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.library-menu').getAttribute('open'), null, 'Esc 应关闭菜单');
    }
  });
  if (width >= 1000) await checkNavigationResize(page, label, width);
  const fileButton = page.locator('label[role="button"]').first();
  if (await fileButton.count()) await record(`${label} 文件选择键盘可达`, async () => {
    await fileButton.focus();
    await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  });
  await page.locator('#theme-toggle').click();
  await checkDarkTheme(page, label);
  if (output && width === 375) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(output, `${label.split(' @')[0]}-375-dark.png`) });
  }
}

async function checkNavigationResize(page, label, width) {
  await record(`${label} 导航切换宽度`, async () => {
    await page.setViewportSize({ width: 375, height: 960 });
    await page.waitForFunction(() => !document.querySelector('.library-menu').open);
    await page.setViewportSize({ width, height: 960 });
    await page.waitForFunction(() => document.querySelector('.library-menu').open);
    await assertLayout(page);
  });
}

async function checkDarkTheme(page, label) {
  await record(`${label} 深色表单无白底`, async () => {
    const lightInputs = await page.locator('main input:not([type="checkbox"]):not([type="file"]), main select, main textarea')
      .evaluateAll((inputs) => inputs.filter((element) => {
        if (!element.getBoundingClientRect().width) return false;
        const rgb = getComputedStyle(element).backgroundColor.match(/\d+/g).map(Number);
        return Math.max(...rgb.slice(0, 3)) >= 100;
      }).map((element) => element.id));
    assert.deepEqual(lightInputs, [], '深色输入控件不得出现浅底');
    await assertLayout(page);
  });
  await record(`${label} 深色面板无浅底`, async () => {
    const panel = page.locator('main > .panel').first();
    if (!await panel.count()) return;
    const color = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
    const rgb = color.match(/\d+/g).map(Number);
    assert.ok(Math.max(...rgb.slice(0, 3)) < 100, `深色面板底色为 ${color}`);
  });
}

const server = createServer(serve);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const width of widths) for (const route of pages) await checkPage(browser, base, route, width);
  console.log(`响应式验收：${checks - failures.length}/${checks} 项通过，8 个页面 × ${widths.length} 个宽度。`);
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
