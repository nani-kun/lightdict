# LightDict 轻词典

一个轻量的 Chrome 划词词典扩展（Manifest V3，零依赖、无需构建）。

- **选中单词** → 停留片刻，弹出卡片：中英音标、中文释义（按词性分组）、可展开的英英解释与例句、发音、加入生词本。
- **选中句子** → 停留片刻，弹出中文译文，并附原文对照。
- 卡片渲染在 **Shadow DOM** 内，不受页面样式干扰，也不会污染页面；自动跟随系统深浅色。

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录
4. 任意网页刷新后即可划词（首次安装会自动打开设置页）

## 使用

| 操作 | 效果 |
| --- | --- |
| 选中一个英文单词 / 短语（≤4 词） | 词典卡片 |
| 选中一句话或一段话 | 中文翻译卡片 |
| `Esc` / 点击卡片外部 | 关闭卡片 |
| 卡片上的 🔈 / ☆ / ⧉ | 发音 / 加入生词本 / 复制 |
| 点击工具栏图标 | 快速开关、生词本、导出 |

设置页（工具栏图标 → 打开设置）可调整：触发方式（直接划词 / 按住 Shift、Ctrl、Alt）、停留延迟、卡片主题、是否显示英文释义、自动发音、翻译引擎、长度上限、例外网站。设置存于 `chrome.storage.sync`，改动即时生效，无需刷新页面。

## 目录结构

```
manifest.json              扩展清单（MV3）
src/
  background/service-worker.js   所有网络请求、结果缓存、生词本存取
  content/content.js             划词监听 + Shadow DOM 卡片（样式内联在文件顶部 CSS 常量）
  common/settings.js             默认配置与读写封装
  options/                       设置页
  popup/                         工具栏弹窗（开关 + 生词本）
icons/                     图标（由 tools/make_icons.py 生成）
demo/preview.html          卡片预览页，用假数据跑真实 content.js，可直接用浏览器打开
tools/test-query.mjs       在 Node 里跑一遍后台查询逻辑（真实联网），用于排查数据源
tools/make_icons.py        重新生成图标
```

## 数据来源

| 用途 | 接口 |
| --- | --- |
| 中文释义 / 整句翻译 / 音标兜底 | `clients5.google.com/translate_a/single`（失败时自动切 `translate.googleapis.com`） |
| 音标、发音音频、英英释义与例句 | `api.dictionaryapi.dev` |
| 备用翻译引擎 | `api.mymemory.translated.net` |

均为免登录的公开接口，请求只在后台 service worker 发出，只携带选中的文本，不发送页面地址或身份信息。查询结果在本地缓存 7 天（最多 600 条），可在设置页清空。

> 若所在网络无法访问 Google，可在设置页把首选引擎切到 MyMemory；此时单词的中文释义会退化为整句翻译结果，英文释义与发音不受影响。

## 自测

```bash
node tools/test-query.mjs                 # 跑默认样例
node tools/test-query.mjs ubiquitous "It works."   # 指定内容
open demo/preview.html                    # 肉眼检查卡片样式与定位
python3 tools/make_icons.py               # 重新生成图标（需要 Pillow）
```

## 已知限制

- Google 的公开翻译端点没有 SLA，高频使用可能被临时限流；扩展会自动降级到备用主机 / 备用引擎。
- MyMemory 免费额度按 IP 计算（约每天 5000 词），超出后返回错误提示。
- 只处理「英文 → 简体中文」；选中中文会按整句翻译走同一条链路，结果未必理想。
