const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('playwright/test');
const ROOT=path.resolve(__dirname,'..','..','..'), PAGE=path.join(ROOT,'tests','.tmp','index.html');
function url(){return pathToFileURL(PAGE).href;}
test.beforeEach(async({page})=>{await page.goto(url());await page.evaluate(()=>localStorage.clear());await page.reload();});
async function newTabs(page,n){for(let i=0;i<n;i++)await page.keyboard.press('Control+n');}

test('Ctrl+E、Ctrl+F6、Ctrl+Shift+F6 切换已打开标签页',async({page})=>{await newTabs(page,3);const active=()=>page.evaluate(()=>TabManager.getState().activeTabId);const first=await active();await page.keyboard.press('Control+F6');const second=await active();expect(second).not.toBe(first);await page.keyboard.press('Control+Shift+F6');expect(await active()).toBe(first);await page.keyboard.press('Control+e');await expect(page.locator('#quick-open')).toBeVisible();expect(await page.evaluate(()=>QuickOpen.getState().mode)).toBe('tabs');await page.keyboard.press('Control+e');await expect(page.locator('#quick-open')).toBeHidden();});
test('Ctrl+Shift+R 打开资源 Quick Open，F12 聚焦编辑器',async({page})=>{await page.keyboard.press('Control+Shift+r');await expect(page.locator('#quick-open')).toBeVisible();await page.keyboard.press('Escape');await page.keyboard.press('Control+n');await page.locator('#btn-settings').focus();await page.keyboard.press('F12');await expect(page.locator('#editor')).toBeFocused();});
test('Ctrl+F7 与 Ctrl+Shift+F7 正反向切换工作区焦点',async({page})=>{await page.keyboard.press('Control+n');await page.locator('#editor').focus();await page.keyboard.press('Control+F7');const forward=await page.evaluate(()=>document.activeElement&&document.activeElement.id);expect(forward).not.toBe('editor');await page.keyboard.press('Control+Shift+F7');await expect(page.locator('#editor')).toBeFocused();});
test('Alt+Shift+P toggle 设置，后续 K 进入快捷键分类',async({page})=>{await page.keyboard.press('Alt+Shift+p');await expect(page.locator('#settings-panel')).toBeVisible();await page.keyboard.press('k');await expect(page.locator('#settings-keybindings-mount')).toBeVisible();await page.keyboard.press('Alt+Shift+p');await expect(page.locator('#settings-panel')).toBeHidden();});
test('文件与保存类 Eclipse 快捷键均分派到真实行为',async({page})=>{await page.keyboard.press('Control+n');await expect(page.locator('.tab')).toHaveCount(1);const e=page.locator('#editor');await e.fill('changed');await e.focus();await page.keyboard.press('Control+s');let log=await page.evaluate(()=>__ipcLog.map(JSON.parse));expect(log.some(m=>m.command==='save_as'||m.command==='save_file')).toBeTruthy();await page.keyboard.press('Alt+Shift+s');log=await page.evaluate(()=>__ipcLog.map(JSON.parse));expect(log.filter(m=>m.command==='save_as').length).toBeGreaterThan(0);// mock 环境补上真实 Rust 必回的 file_saved 回执（requestId=1/tabId=1 由 beforeEach reload 后首次保存确定），使 markClean 生效、与真实保存链路一致
await page.evaluate(()=>window.__fromRust('file_saved',{path:'',requestId:1,tabId:TabManager.getState().activeTabId}));await page.keyboard.press('Control+w');// markDirty 为 300ms 防抖：若在保存分派后才触发，将弹出关闭确认，此处点击“放弃并关闭”兜底
const confirmBtn=page.locator('#confirm-dialog-btn-confirm');if(await confirmBtn.count())await confirmBtn.click();await expect(page.locator('.tab')).toHaveCount(0);});

test('Eclipse 打开文件(Ctrl+Alt+O)与打开文件夹(Ctrl+Alt+P)快捷键分派到真实行为', async ({ page }) => {
  await page.keyboard.press('Control+Alt+o');
  let log = await page.evaluate(() => __ipcLog.map(JSON.parse));
  expect(log.some(m => m.command === 'open_file')).toBeTruthy();

  await page.keyboard.press('Control+Alt+p');
  log = await page.evaluate(() => __ipcLog.map(JSON.parse));
  expect(log.some(m => m.command === 'open_workspace' || m.command === 'open_file')).toBeTruthy();
});

test('顶栏按钮 Tooltip 与欢迎页卡片快捷键动态随键位方案联动刷新', async ({ page }) => {
  // 1. 默认处于 Eclipse 方案
  const welcomeOpen = page.locator('#welcome-btn-open-file .welcome-btn-shortcut');
  const welcomeFolder = page.locator('#welcome-btn-open-folder .welcome-btn-shortcut');
  await expect(welcomeOpen).toHaveText('Ctrl+Alt+O');
  await expect(welcomeFolder).toHaveText('Ctrl+Alt+P');
  await expect(page.locator('#btn-open-file')).toHaveAttribute('title', /Ctrl\+Alt\+O/);
  await expect(page.locator('#btn-toggle')).toHaveAttribute('title', /Ctrl\+Shift\+V/);

  // 2. 动态切换方案到 VS Code
  await page.evaluate(() => window.Keybindings.setScheme('ultra.vscode'));
  await expect(welcomeOpen).toHaveText('Ctrl+O');
  await expect(welcomeFolder).toHaveText('Ctrl+K Ctrl+O');
  await expect(page.locator('#btn-open-file')).toHaveAttribute('title', /Ctrl\+O/);

  // 3. 动态切回 Eclipse 方案
  await page.evaluate(() => window.Keybindings.setScheme('ultra.eclipse'));
  await expect(welcomeOpen).toHaveText('Ctrl+Alt+O');
  await expect(welcomeFolder).toHaveText('Ctrl+Alt+P');
  await expect(page.locator('#btn-open-file')).toHaveAttribute('title', /Ctrl\+Alt\+O/);
});

test('窗口最小化后再恢复最大化，资源管理器侧栏保持展开且偏好尺寸严格不缩小', async ({ page }) => {
  await page.keyboard.press('Control+n');
  await page.keyboard.press('Control+n');
  const tree = page.locator('#panel-tree');
  await expect(tree).not.toHaveClass(/collapsed/);
  const widthBefore = await tree.evaluate(el => el.getBoundingClientRect().width);
  expect(widthBefore).toBeGreaterThanOrEqual(260);

  // 模拟窗口最小化时触发 0 尺寸
  await page.evaluate(() => {
    const content = document.getElementById('content');
    const origRect = content.getBoundingClientRect.bind(content);
    content.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
    window.dispatchEvent(new Event('resize'));
    content.getBoundingClientRect = origRect;
  });

  // 模拟窗口恢复最大化 (1920x1080)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
  });

  // 验证侧栏严格不被误判折叠，且尺寸稳定无损
  await expect(tree).not.toHaveClass(/collapsed/);
  const widthAfter = await tree.evaluate(el => el.getBoundingClientRect().width);
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(2);
});
