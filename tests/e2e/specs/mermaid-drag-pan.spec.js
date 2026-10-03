/* mermaid-drag-pan.spec.js — mermaid 图表手掌拖拽平移回归
 *
 * 行为（preview.js mermaid pan + style.css .mermaid-chart）：
 * - 图表溢出容器（宽图横向 / 高图受 max-height:70vh 约束纵向）时标记
 *   .pannable，svg 显示 grab 手掌光标
 * - 左键按住拖动：scrollLeft/scrollTop 跟随位移反向滚动，拖动中 .panning
 *   （grabbing 光标）
 * - 无溢出的小图不可拖（无 .pannable）
 * - 纯点击（位移 ≤2px）不产生滚动突变
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('playwright/test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, 'tests', '.tmp', 'index.html');

function url() {
  return pathToFileURL(PAGE).href;
}

test.beforeAll(() => {
  if (!fs.existsSync(PAGE)) {
    execBuild();
  }
});

function execBuild() {
  const { execFileSync } = require('node:child_process');
  execFileSync('python', [path.join(ROOT, 'tools', 'build_test_page.py')], { cwd: ROOT });
}

const WIDE_MD = [
  '# 宽图拖拽',
  '',
  '```mermaid',
  'flowchart LR',
  '  A["节点A"] --> B["节点B"] --> C["节点C"] --> D["节点D"] --> E["节点E"] --> F["节点F"] --> G["节点G 很长很长很长的一段文字标签"] --> H["节点H"] --> I["节点I"]',
  '```',
  '',
].join('\n');

const TALL_MD = [
  '# 高图拖拽',
  '',
  '```mermaid',
  'flowchart TB',
  '  N1["一层"] --> N2["二层"] --> N3["三层"] --> N4["四层"] --> N5["五层"] --> N6["六层"] --> N7["七层"] --> N8["八层"] --> N9["九层"] --> N10["十层"]',
  '```',
  '',
].join('\n');

const SMALL_MD = [
  '# 小图',
  '',
  '```mermaid',
  'flowchart LR',
  '  A["A"] --> B["B"]',
  '```',
  '',
].join('\n');

async function renderMermaid(page, md) {
  await page.goto(url());
  await page.evaluate((src) => {
    const el = document.getElementById('editor');
    el.value = src;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, md);
  await page.click('#btn-toggle');
  await page.waitForSelector('.mermaid-chart svg', { timeout: 20000 });
  await page.waitForTimeout(400);
  /* 测试直灌 editor 不建 tab：切模式后欢迎页会重新显示并盖住预览拦截鼠标
   * 命中，必须在渲染完成后再隐藏（提前隐藏会被 toggle 逻辑撤销） */
  await page.evaluate(() => {
    const wv = document.getElementById('welcome-view');
    if (wv) wv.style.display = 'none';
  });
  await page.waitForTimeout(80);
}

async function dragOnChart(page, chart, dx, dy) {
  /* 并行 worker 抢 CPU 时测量与落地间布局可能漂移：验证命中点确实在图表上，
   * 不在则重取 box 重试；拖完用 expect.poll 容忍事件落地延迟 */
  let box = await chart.boundingBox();
  for (let i = 0; i < 6; i++) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return !!el && !!el.closest('.mermaid-chart');
    }, [cx, cy]);
    if (hit) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
      await page.mouse.up();
      return;
    }
    await page.waitForTimeout(150);
    box = await chart.boundingBox();
  }
  throw new Error('拖拽点始终未命中 .mermaid-chart');
}

test('宽图：pannable 标记 + grab 光标，左键拖动平移 scrollLeft', async ({ page }) => {
  await renderMermaid(page, WIDE_MD);
  const chart = page.locator('.mermaid-chart');
  await expect(chart).toHaveClass(/pannable/);
  await expect(chart.locator('svg')).toHaveCSS('cursor', 'grab');

  const before = await chart.evaluate((el) => el.scrollLeft);
  expect(before).toBe(0);

  await dragOnChart(page, chart, -260, 0);

  await expect.poll(async () => chart.evaluate((el) => el.scrollLeft), { timeout: 3000 })
    .toBeGreaterThan(150); /* 向左拖 → 内容左移（scrollLeft 增大） */
  await expect(chart.locator('svg')).toHaveCSS('cursor', 'grab'); /* 松手后恢复 */
});

test('高图：max-height 约束出纵向溢出，拖动平移 scrollTop', async ({ page }) => {
  await renderMermaid(page, TALL_MD);
  const chart = page.locator('.mermaid-chart');
  await expect(chart).toHaveClass(/pannable/);

  const vh = page.viewportSize().height;
  const height = await chart.evaluate((el) => el.clientHeight);
  expect(height).toBeLessThanOrEqual(Math.round(vh * 0.7) + 2);

  await dragOnChart(page, chart, 0, -200);

  await expect.poll(async () => chart.evaluate((el) => el.scrollTop), { timeout: 3000 })
    .toBeGreaterThan(100); /* 向上拖 → 内容上移（scrollTop 增大） */
});

test('拖动中 .panning（grabbing 光标），松手移除', async ({ page }) => {
  await renderMermaid(page, WIDE_MD);
  const chart = page.locator('.mermaid-chart');
  const box = await chart.boundingBox();
  await page.waitForTimeout(100); /* 布局稳定后再验证拖动中光标 */

  await page.mouse.move(box.x + 200, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 3 });
  await expect(chart).toHaveClass(/panning/);
  await expect(chart.locator('svg')).toHaveCSS('cursor', 'grabbing');
  await page.mouse.up();
  await expect(chart).not.toHaveClass(/panning/);
});

test('小图无溢出：无 pannable，拖动不产生滚动', async ({ page }) => {
  await renderMermaid(page, SMALL_MD);
  const chart = page.locator('.mermaid-chart');
  await expect(chart).not.toHaveClass(/pannable/);

  await dragOnChart(page, chart, -120, -60);
  const scroll = await chart.evaluate((el) => ({ l: el.scrollLeft, t: el.scrollTop }));
  expect(scroll.l).toBe(0);
  expect(scroll.t).toBe(0);
});

test('纯点击（位移 ≤2px）不产生滚动突变', async ({ page }) => {
  await renderMermaid(page, WIDE_MD);
  const chart = page.locator('.mermaid-chart');
  await dragOnChart(page, chart, -2, 1);
  const scroll = await chart.evaluate((el) => el.scrollLeft);
  expect(Math.abs(scroll)).toBeLessThanOrEqual(2);
});
