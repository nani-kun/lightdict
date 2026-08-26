# 贡献指南

欢迎参与 LightDict 轻词典。这是一个**零依赖、无构建**的 Chrome MV3 扩展——克隆下来就能直接加载调试，不需要 `npm install`。

## 目录

- [本地开发](#本地开发)
- [自测](#自测)
- [新增一个引擎](#新增一个引擎)
- [代码风格](#代码风格)
- [提交与 PR](#提交与-pr)
- [报告问题](#报告问题)

## 本地开发

```bash
git clone https://github.com/nani-kun/lightdict.git
cd lightdict
```

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择仓库根目录
4. 改完代码后，回到 `chrome://extensions/` 点扩展卡片上的刷新按钮

**改了内容脚本（`src/content/`）时，被测试的网页也要刷新一次**——重载扩展只换掉后台那份，页面上跑的还是旧代码。判断依据是页面控制台里的那行 `[LightDict] 内容脚本已加载 vX.Y.Z`：看不到新版本号就说明还没生效。

调试各部分的控制台分别在：

| 改哪里 | 去哪看日志 |
| --- | --- |
| `src/content/` | 目标网页的 DevTools 控制台（执行环境切到 `LightDict 轻词典`） |
| `src/background/` | `chrome://extensions/` → 扩展卡片上的「Service Worker」链接 |
| `src/options/`、`src/popup/` | 对应页面自己的 DevTools |

## 自测

改动至少要跑一遍相关的检查。这些都不需要装依赖（`make_icons.py` 除外，它要 Pillow）。

```bash
node tools/test-query.mjs                 # 跑默认样例
node tools/test-query.mjs --engines       # 逐个体检所有引擎（看谁还活着）
node tools/test-query.mjs --page          # 走一遍整页翻译的批量通道（英文 + 日文两组），看分段对不对得上
open demo/preview.html                    # 肉眼检查卡片样式与定位
open 'demo/page.html?auto=roundtrip'      # 翻一遍再恢复，检查页面是否原样还原
```

完整的参数列表见 [README 的「自测」一节](README.md#自测)。

`tools/test-query.mjs` 是**真实联网**的：某个引擎报错，先确认是代码问题还是上游临时不可用（换个网络或过一会儿再试）。公开接口没有 SLA，偶发失败很正常。

改动涉及 UI 时，请一并在**深色与浅色**两种系统主题下看一眼——卡片会自动跟随系统配色。

改动涉及卡片或整页翻译的样式时，跑一遍 `bash tools/make_shots.sh` 重新生成 README 里的截图（需要本机有 Chrome 和 Pillow）。它拍的是 `demo/` 下的演示页，喂的是固定的假数据，所以两次结果可比——`git diff` 一看就知道样式动了哪里。

## 新增一个引擎

引擎全部集中在 `src/common/engines.js`，加一个引擎通常只改这一个文件：

1. 写一个 `async` 函数发请求并把响应整理成本项目的统一结构（照抄邻近的引擎实现最快）。
2. 在对应的注册表数组里加一项。五个注册表分别是 `TRANSLATE_ENGINES`（英译中）、`ZH_TRANSLATE_ENGINES`（中译英）、`CN_DICT_ENGINES`（英汉）、`ZH_DICT_ENGINES`（汉英）、`EN_DICT_ENGINES`（英英）：

   ```js
   {
     id: 'myengine',              // 唯一标识，会被写进用户设置，定下就别再改
     name: '我的引擎',             // 设置页下拉框里显示的名字
     note: '一句话说清它的取舍',    // 划词场景的说明
     pageNote: '整页场景的说明',    // 仅 TRANSLATE_ENGINES 需要
     run: (t) => myengine(t, 'zh-CN'),
     lines: linesVia((t) => myengine(t, 'zh-CN'))  // 仅 TRANSLATE_ENGINES 需要
   }
   ```

   设置页的下拉框由注册表生成，**不用改 `options.html`**。

3. **把域名加进 `manifest.json` 的 `host_permissions`**，否则请求会被直接拦掉。请写具体域名，不要用通配符——权限列得越窄，用户装的时候越放心。
4. 在 [README](README.md#引擎) 对应的引擎表格里补一行。
5. 跑 `node tools/test-query.mjs --engines` 确认它能出结果。

`lines(texts)` 是整页翻译的批量入口：一次送多段，返回**等长**的译文数组。上游没有批量接口时，用现成的 `linesVia()` 包一层即可（它靠换行拼接与拆分）。

**只收免登录、无需 API Key 的公开接口。** 需要注册、需要付费、需要用户自备密钥的服务不在本项目范围内。

## 代码风格

没有 linter，也不打算加。照着周围的代码写就对了：

- 原生 ES modules，不引入任何运行时依赖。**请不要提交引入 npm 依赖或构建步骤的 PR。**
- 2 空格缩进，单引号，语句结尾带分号。
- **注释用中文，解释「为什么」而不是「做了什么」。** 本项目的注释密度偏高且刻意如此——尤其是绕过上游怪癖的地方，请把原因写下来。
- 内容脚本的 CSS 内联在 `src/content/content.js` 顶部的常量里（卡片渲染在 Shadow DOM 内，样式必须跟着一起注入）。
- 提交里不要夹带 `.DS_Store`、打包产物或编辑器配置。

## 提交与 PR

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，**正文用中文**，和现有历史保持一致：

```
feat(engine): 翻译引擎加入微软翻译，走 Bing 的免注册通道
fix(speak): 换掉自动挑中的特效嗓音，并让嗓音可在设置里指定
docs(page): 快捷键改成向浏览器问，并注明 macOS 上的按法
```

常用类型：`feat` / `fix` / `docs` / `refactor` / `perf` / `chore`。作用域用模块名（`engine`、`content`、`page`、`speak`、`options`、`popup`）。

PR 请说明：改了什么、为什么这么改、怎么验证的（跑了哪些自测命令）。UI 改动请附截图，深浅色各一张更好。

一个 PR 只做一件事。行为变更请顺手更新 README 与 [CHANGELOG](CHANGELOG.md) 的 `Unreleased` 一节。

## 报告问题

提 Issue 时请带上：Chrome 版本、操作系统、扩展版本（`chrome://extensions/` 上能看到）、当前选用的引擎、复现步骤，以及相关控制台日志。发音问题请附上带 `[LightDict 发音]` 前缀的那几行——它把整条链路都打出来了。

**上游接口挂掉不算 bug**，但**欢迎报告**：这类问题往往需要改抓取逻辑或把某个引擎标为不可用。请先用 `node tools/test-query.mjs --engines` 确认是哪一个不行。

## 许可

提交贡献即表示同意你的代码以 [MIT 许可证](LICENSE)发布。
