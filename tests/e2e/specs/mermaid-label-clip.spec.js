/* mermaid-label-clip.spec.js — mermaid 节点文字裁切回归
 *
 * 背景：#preview 的 line-height:1.6 与 p 外边距曾继承进 mermaid htmlLabels
 * （foreignObject 内的 span/div），而 mermaid 度量文本用浏览器 normal 行高，
 * 节点高度按度量分配 → 多行标签下半被裁切。修复：style.css 将 .mermaid-chart
 * svg 内行高钉为 normal（见 fix(ui) mermaid 裁切提交）。
 *
 * 本用例渲染两行中文标签的最小图表，逐 foreignObject 断言
 * 实际内容高度不超过 mermaid 分配高度 +1.5px。
 */
const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..', '..');
const pagePath = path.join(root, 'tests', '.tmp', 'index.html');

test.beforeAll(() => {
  if (!fs.existsSync(pagePath)) {
    execFileSync('python', [path.join(root, 'tools', 'build_test_page.py')], { cwd: root });
  }
});

const MERMAID_MD = [
  '# mermaid 裁切回归',
  '',
  '```mermaid',
  'flowchart TB',
  '  A["单点突破 + 梯次攻击链<br>先吃 controls / alternatives，再爬 unblocked / 主词"] --> B["卖线索<br>Affiliate / 邮箱 / 表单 · 流量精准、行业属性强"]',
  '```',
  '',
].join('\n');

test('mermaid 多行节点标签不被裁切：foreignObject 分配高度 ≥ 内容实际高度', async ({ page }) => {
  await page.goto(pathToFileURL(pagePath).href);
  await page.evaluate((src) => {
    const el = document.getElementById('editor');
    el.value = src;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, MERMAID_MD);
  await page.click('#btn-toggle');
  await page.waitForSelector('.mermaid-chart svg', { timeout: 20000 });
  await page.waitForTimeout(600);

  const report = await page.evaluate(() => {
    const svg = document.querySelector('.mermaid-chart svg');
    // 归一化：applyMermaidSvgSize + min-width:100% 会把小图等比放大，
    // getBoundingClientRect 返回变换后尺寸，而 foreignObject 的 height 属性
    // 是 viewBox 坐标——content 除以当前缩放比后再与 allotted 比较。
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/);
    const naturalW = vb.length === 4 && isFinite(parseFloat(vb[2])) ? parseFloat(vb[2]) : 0;
    const scale = naturalW > 0 ? svg.getBoundingClientRect().width / naturalW : 1;
    return Array.from(svg.querySelectorAll('foreignObject')).map((fo) => {
      const inner = fo.querySelector('div');
      return {
        allotted: parseFloat(fo.getAttribute('height') || '0'),
        content: inner ? inner.getBoundingClientRect().height / scale : 0,
        text: (fo.textContent || '').slice(0, 20),
      };
    });
  });

  // 标签已渲染
  expect(report.length).toBeGreaterThanOrEqual(2);
  expect(report.map(r => r.text).join('')).toContain('单点突破');

  // 无裁切：内容高度超出分配高度 1.5px 即视为被 foreignObject 截断
  const clipped = report.filter(r => r.content - r.allotted > 1.5);
  expect(clipped, `被裁切的标签: ${JSON.stringify(clipped)}`).toEqual([]);
});
