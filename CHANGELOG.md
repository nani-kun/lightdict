# 更新日志

本文件记录 LightDict 轻词典的版本变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 开源准备：MIT 许可证、贡献指南、隐私政策、Issue / PR 模板与 CI。
- README 加上截图，并新增 `tools/make_shots.sh`：用 headless Chrome 拍 `demo/` 下的演示页，结果可复现。
- 修复 `demo/preview.html` 被误清空（内容自 `e1247e1` 起丢失），并补上它缺的 `common/voices.js`。
- 修复 `demo/preview.html` 的假后台把设置也延迟 260ms 返回，导致 `?auto=zhword` / `?auto=zhtext` 弹不出卡片。
- `demo/page.html` 的假译文换成手写的中文对照表：中英排版特性差别大，用「译：+ 原文」看不出译文插进去之后页面被撑成什么样。

## [1.1.0] - 2026-08-26

### 新增

- **整页翻译**：工具栏按钮或快捷键 `Alt+T`（macOS 上 `⌥ Option + T`）把当前英文网页就地变成中英对照，再按一次恢复原样。译文作为原文元素的最后一个子节点插入，因此继承原文的字体、字号、颜色与行高；只在主框架生效，靠 `activeTab` 触发，安装时不额外索要权限。
- 整页翻译支持独立选择引擎与译文样式（与原文一致 / 略淡 / 虚线下划线），译文按「引擎 + 原文」缓存在 `chrome.storage.session`。
- 新增内容（无限滚动、SPA 换页）由 `MutationObserver` 接住并补翻。
- **微软翻译引擎**：走 Bing 的免注册通道（`bing.com/ttranslatev3`），先从 `bing.com/translator` 刮取 `IG` 与防滥用令牌，会话复用一小时，过期自动重刮。同时可用于英译中与中译英。
- 调试工具：`node tools/test-query.mjs --page` 走一遍整页翻译的批量通道；`demo/page.html` 作为排版试验场（支持 `?auto=1`、`?lazy=1`、`?auto=roundtrip`、`?style=`）。

### 变更

- 设置页与弹窗上显示的快捷键改为向浏览器查询（`chrome.commands.getAll()`），在 `chrome://extensions/shortcuts` 改过之后两处显示同步更新。

### 说明

- 微软翻译是唯一使用 `credentials: 'include'` 的引擎（接口要求带 bing.com cookie），其余引擎一律 `'omit'`。介意的话换用其它引擎。

## [1.0.0] - 2026-08-25

### 新增

- 划词查询：选中英文单词弹出词典卡片（音标、中文释义按词性分组、可展开的英英解释与例句、发音、加入生词本）；选中句子弹出中文译文并附原文对照。
- **中译英**（设置页开关，默认关闭）：中文词给出拼音与英文对应词，中文句子译成英文，结果同样可发音。
- 引擎注册表 `src/common/engines.js`：五类引擎（翻译、英汉词典、英英词典、中译英、汉英词典）各自独立选择，全部为免登录公开接口；支持自动降级，卡片底部标注结果实际来自哪些引擎。
- 卡片渲染在 Shadow DOM 内，不受页面样式干扰，自动跟随系统深浅色，强制置顶以兼容模态框与全屏。
- 发音：优先真人录音（有道词典 / Free Dictionary），无录音时退回浏览器语音合成；英美音可分别试听，中文词点拼音朗读原词。
- 嗓音挑选规则集中在 `src/common/voices.js`，内容脚本与设置页共用；避开 macOS 自带的特效嗓音（Albert、Zarvox 等），也可在设置页直接指定嗓音并试听。
- 设置页：触发方式、停留延迟、卡片主题、英文释义开关、自动发音、嗓音、各类引擎、自动降级、长度上限、例外网站；设置存于 `chrome.storage.sync`，改动即时生效。
- 工具栏弹窗：快速开关、生词本、导出。
- 查询结果按「引擎组合 + 文本」本地缓存 7 天（最多 600 条），可在设置页清空。
- 调试入口：内容脚本加载时打印版本横幅，发音链路日志走 `console.warn`，控制台可用 `__lightdict.voices()` / `.speak()` / `.try()` / `.raw()`。

[Unreleased]: https://github.com/nani-kun/lightdict/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/nani-kun/lightdict/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nani-kun/lightdict/releases/tag/v1.0.0
