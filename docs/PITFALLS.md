# DSH Desktop Pure · 踩坑指南

> 本文件记录本项目开发中**真实踩过、且易复发**的坑，供人阅读与 agent 规避。每个坑按 **现象 → 根因 → 规避 → 修复** 组织。
>
> 与 [DETAILS.md](./DETAILS.md)（行为 / 运行 / 打包）互补：DETAILS 讲"怎么用"，本文件讲"哪里会咬人"。
> 配套的可执行流程见项目 skill：`.dsh/skills/dsh-electron-dev/`（开发→验证→发布工作流）与 `.dsh/skills/electron-webcontentsview/`（多视图编排模式）。

## 主题一：Electron 31 API 陷阱

### 1.1 没有 `getContentView()` / `getChildViews()`

- **现象**：`win.getContentView()` / `win.contentView.getChildViews()` 报 `not a function`，崩溃发生在 `connectEndpoint` 早期 → 启动黑屏、页面出不来。
- **根因**：Electron 31 的 `BaseWindow` 没有 `getContentView()` 方法（应直接读 `win.contentView` 属性拿 `ContentView`）；`ContentView` 也**没有** `getChildViews()` 枚举接口。
- **规避**：取内容视图一律 `const cv = win.contentView`；不要试图枚举子视图。
- **修复/记忆**：要把某视图抬到顶层，用 `cv.removeChildView(v); cv.addChildView(v)`（remove + add 即 re-raise）。

### 1.2 `addChildView()` 永远追加到最顶层

- **现象**：新建端点 `WebContentsView` 后，标题栏 / 页面菜单**点不动**（被新视图盖住）。
- **根因**：`cv.addChildView(v)` 把 `v` 放到 z-order **最上面**。端点视图铺满窗口，会盖住其上此前加入的 `pureView` / `titlebarView` / `menuView`。
- **规避**：加完端点视图后，把 `pureView` / `titlebarView` / `menuView` **依次再 `addChildView` 一遍**（重新置顶），恢复正确层级：`端点视图 < pureView < titlebarView < menuView`。
- **修复**：`openMenuAt` 弹出菜单前同样先 `removeChildView(menuView); addChildView(menuView)` 强制菜单置顶——否则菜单被端点视图盖住、点了没反应。

## 主题二：文件编码与编辑陷阱

### 2.1 PowerShell 直接改写会破坏 UTF-8 中文

- **现象**：几行 pwsh 管道后 `main.js` 变成 0 / 135 / 175 行，中文变乱码（如 `杩炴帴澶辫触`），`node --check` 报 `SyntaxError: Unexpected token '}'`。
- **根因**：`Get-Content` / `Set-Content` 的默认编码处理会改动字节（换行、BOM、编码），对含中文的源文件极易破坏。
- **规避**：改**中文内容**一律用 edit 工具做目标替换，不要用 pwsh 重定向整文件。
- **修复**：文件被写坏时 `git checkout -- main.js` 恢复；或 `git show <sha>:main.js > main.js`（`>` 重定向也有编码风险，优先 `git checkout`）。**每次改完立即 `node --check main.js` 验证。**

### 2.2 PowerShell 字符串里的 `${}` 会插值

- **现象**：想写入 JS 模板串 `` `连接断开：${detail}` ``，结果 `${detail}` 被 PowerShell 当变量插值（变空串或报错）。
- **根因**：双引号字符串和 `@"..."@` here-string 会对 `${}` / `$var` 做 PowerShell 插值，与 JS 模板串语法撞车。
- **规避**：要写含 `${}` 的 JS 代码时，改用**字符串拼接**（`'连接断开：' + detail`）、单引号 here-string `@'...'@`（不插值），或转义 `` `$ ``。
- **记忆**：凡用 pwsh 生成含 JS 模板串的源码，先确认 `${}` 不会被 PowerShell 吃掉。

### 2.3 edit 的 `old_string` 猜错空白/编码就反复失配

- **现象**：edit 报"未找到唯一匹配"，反复失败（本项目曾对 `main.js` 连续 5 次 edit 失败）。
- **根因**：`old_string` 必须逐字节匹配（缩进、空行、全/半角、中文），凭记忆猜极易差一个字符。
- **规避**：改前先 `read` 精确区域（带 offset/limit），**复制原文**作为 `old_string`，不要手敲。
- **记忆**：`main.js` 约 2400+ 行，任何 edit 都先 read 目标行。

### 2.4 改大 block：临时文件 + 行号 splice，别整块 edit

- **现象**：对大函数做整块 edit 时 `old_string` 太长、极易失配或替换错位。
- **根因**：大段替换对 `old_string` 精确度要求过高。
- **规避**：写一个临时文件（如 `_new_layout.js`）放新 block，用 pwsh 按**行号**拼接替换（读原文件数组 → 切片 → 插入新行 → 写回），随后 `node --check`。
- **纪律**：临时文件用完**立即删除**，别让它进 commit（本项目 `_new_layout.js`、`_patch.txt` 曾误入 commit，靠后续 commit 清理）。

## 主题三：视图状态竞态陷阱

### 3.1 注册视图必须先于 z-order 重排

- **现象**：菜单里的 Windows / WSL / test 项**点了没反应**。
- **根因**：在 `getEndpointView` 里做 z-order 重排（`removeChildView` 端点视图后 re-add 其它视图）**之前**，没有把 `appState.views[epId] = v` 记上，导致刚被 remove 的端点视图没被加回 `contentView`——视图实际消失了。
- **规避**：顺序固定为 ① 建视图 → ② `appState.views[epId] = v` → ③ 做 z-order 重排。**注册永远在重排之前。**

### 3.2 后台连接结果是"过期的"，别覆盖当前视图

- **现象**：切到 A 端点（连接中）→ 切去 B，A 的连接完成时把 B 的页面冲掉。
- **根因**：连接是异步的，回调触发时 `appState.currentPage` 可能已不等于发起时的端点。
- **规避**：连接回调里**先判 `if (appState.currentPage === ep.id)`**，相等才 `loadWeb(url, {fade:true})` 更新视图；不等则**只更新 state**（`ep.status` / `ep.url`），绝不动视图。

### 3.3 `did-fail-load` 只在"该端点是当前显示页"时才切错误页

- **现象**：后台某端点掉线，把用户正在看的另一个正常页面刷成了错误页。
- **根因**：每个视图独立监听 `did-fail-load`；若不判断"是不是当前页"，任何视图失败都会去改当前显示。
- **规避**：handler 里同样先判 `currentPage === ep.id`，是才 `loadWeb(routerUrl(ep.id,'error',...))` 并置 `ep.status='offline'`；否则只更新 state。

### 3.4 programmatic `loadURL` 会绕过 `will-navigate`

- **现象**（预期外但可利用）：`file://` 的 router 状态页能正常加载，没被导航白名单拦。
- **根因**：`view.webContents.loadURL(...)` 是程序化导航，**不走** `will-navigate` 拦截器；只有**用户点击 / 链接**触发的导航才走。
- **用途**：router 层（`file://.../router.html?ep=&status=&name=&detail=`）全靠这一点才能把状态页注入视图。
- **记忆**：导航白名单（`isAllowedNavigation`：`about:blank` + loopback http(s) + 已注册端点 host）只约束用户触发的导航。

### 3.5 `insertCSS` 做"淡入"会在 file:// / about:blank 上失败 → 整片白屏

- **现象**：切换到 router 状态页 / `about:blank` 后内容区一直白屏（小组件都不出来），刷新也不恢复。
- **根因**：旧 `fadeWebViewIn()` 先 `insertCSS('html { opacity: 0; }')` 再定时恢复；`file://` / `about:blank` 上 `insertCSS` 会静默失败（Promise reject 被吞掉），opacity 永远停在 0——**整页透明，露出视图白底**。
- **规避**：**禁止**用 `insertCSS` 改已加载页面的可见性做过渡。跨 URL 导航的"白闪"防护改用 `view.setBackgroundColor(主题色)`（视图级背景，文档绘制前就生效；Electron 31 上该 API 在 **`WebContentsView`** 上，不在 `webContents` 上），主题切换时同步更新所有视图背景。

## 主题四：Windows 工作流陷阱

### 4.1 进程必须按 CommandLine 过滤

- **现象**：按进程名杀 electron 时误杀了别的 electron / 或根本没杀掉本项目的（3080 端口还被旧实例占着）。
- **根因**：`electron.exe` 进程名不唯一；机器上可能同时有多个 electron 实例。
- **规避**：用 `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ? { $_.CommandLine -match 'dsh-electron' }` 精确定位本项目实例，再 `Stop-Process -Id <pid> -Force`。
- **为什么要先杀干净**：旧实例占着 3080，新实例探测到占用会走"复用已有服务"逻辑——你以为在跑新代码，其实在看旧页面，这是"改动不生效"的常见真凶。

### 4.2 git push 的 schannel 抖动

- **现象**：Windows 上 HTTPS `git push` 偶发 schannel 错误，一次不总成功。
- **规避**：用重试循环 + 指数退避：
  ```powershell
  for ($i = 1; $i -le 8; $i++) {
    git push
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds (2 * $i)
  }
  ```
  实测 ≤3 次基本成功。

### 4.3 后台 job 用 `job_output` 收集，不要轮询

- **现象**：反复 `Get-Content app-run.log` 或忙等，浪费回合。
- **规避**：`npm start` 用后台 job 拿 job id；需要日志时 `job_output`（仅在真正阻塞结果时才 `wait:true`）；job 结束会有通知，收到再收集；结束前把仍相关的 job 都 `job_output` 收一遍。

### 4.4 端口纪律

- **现象**：测试把 3080 占住，干扰真实 `dsh web`。
- **规避**：真实服务用 3080；自测 / 桩一律用 **3987**（`npm run selftest`、`npm start -- --port=3987 --dsh=tools\fake-dsh.cmd`），**不碰 3080**。
