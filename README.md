# LightDict 轻词典

一个轻量的 Chrome 划词词典扩展（Manifest V3，零依赖、无需构建）。

- **选中单词** → 停留片刻，弹出卡片：中英音标、中文释义（按词性分组）、可展开的英英解释与例句、发音、加入生词本。
- **选中句子** → 停留片刻，弹出中文译文，并附原文对照。
- **中译英**（设置页开关，默认关闭）→ 打开后选中中文也响应：中文词给出拼音与英文对应词，中文句子译成英文；关闭时中文选区一律不弹卡片。
- 卡片上的 🔈 读的始终是英文那一侧：英文词读词，中文词读它的英文对应词，句子读英文原文或英文译文。
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
| 选中一个中文词（≤6 字，需开启中译英） | 汉英卡片：拼音 + 英文对应词 |
| 选中一句中文（需开启中译英） | 英文翻译卡片 |
| `Esc` / 点击卡片外部 | 关闭卡片 |
| 卡片上的 🔈 / ☆ / ⧉ | 发音 / 加入生词本 / 复制 |
| 点卡片上的音标（英 / 美）或拼音 | 分别试听英音 / 美音 / 中文原词 |
| 卡片底部的「来源」 | 本次结果实际来自哪些引擎 |
| 点击工具栏图标 | 快速开关、生词本、导出 |

设置页（工具栏图标 → 打开设置）可调整：触发方式（直接划词 / 按住 Shift、Ctrl、Alt）、停留延迟、卡片主题、是否显示英文释义、自动发音、语音合成的中英文嗓音（可试听）、翻译引擎、英汉词典、英英词典、自动降级、长度上限、中译英开关及其两个引擎、例外网站。设置存于 `chrome.storage.sync`，改动即时生效，无需刷新页面。

「中译英」默认关闭：关闭时选中中文什么都不会发生（选中英文照常查），打开后中文选区才会走汉英词典与中译英引擎。

单词卡片上英文释义默认展开，点标题行的「英文释义 ▴」可以就地折叠；不想每次都看到，就在设置页关掉「显示英文释义」。

## 目录结构

```
manifest.json              扩展清单（MV3）
src/
  background/service-worker.js   所有网络请求、结果缓存、生词本存取
  content/content.js             划词监听 + Shadow DOM 卡片（样式内联在文件顶部 CSS 常量）
  common/settings.js             默认配置与读写封装
  common/voices.js               语音合成的嗓音挑选规则（内容脚本与设置页共用的普通脚本）
  common/engines.js              查词 / 翻译引擎注册表（新增引擎只改这里）
  options/                       设置页
  popup/                         工具栏弹窗（开关 + 生词本）
icons/                     图标（由 tools/make_icons.py 生成）
demo/preview.html          卡片预览页，用假数据跑真实 content.js，可直接用浏览器打开
tools/test-query.mjs       在 Node 里跑一遍后台查询逻辑（真实联网），用于排查数据源
tools/make_icons.py        重新生成图标
```

## 引擎

共五类引擎，各自独立选择，全部是免登录的公开接口。英文方向三类：**翻译引擎**出整句译文，**英汉词典**出中文释义（顺带音标与发音），**英英词典**出英文释义与例句；查一个英文单词时三类并行请求，结果合并进同一张卡片。中文方向两类：**中译英引擎**把中文句子译成英文，**汉英词典**给中文词的英文对应词与拼音，两者同样并行。

**翻译引擎**

| 引擎 | 接口 | 特点 |
| --- | --- | --- |
| Google 翻译（默认） | `clients5.google.com`（失败切 `translate.googleapis.com`） | 综合最好，单词还会附带中文词性释义 |
| 有道翻译 | `aidemo.youdao.com/trans` | 中文译文更自然，国内网络可直连 |
| MyMemory | `api.mymemory.translated.net` | 开放翻译记忆库，匿名每日有免费额度 |
| SimplyTranslate | `simplytranslate.org/api/translate` | Google 的公共镜像，直连被拦时的备胎；上游限流较紧，建议配合自动降级 |

**英汉词典**

| 引擎 | 接口 | 特点 |
| --- | --- | --- |
| 有道词典（默认） | `dict.youdao.com/jsonapi` | 中文释义 + 英美音标 + 真人发音，覆盖最全 |
| 金山词霸 | `dict-mobile.iciba.com` | 按词性分组的短词条，一眼扫得完 |
| 有道联想 | `dict.youdao.com/suggest` | 接口最轻，响应最快，也收派生词 |

**英英词典**

| 引擎 | 接口 | 特点 |
| --- | --- | --- |
| Free Dictionary（默认） | `api.dictionaryapi.dev` | 英文释义带例句，另有音标与真人发音 |
| Wiktionary | `en.wiktionary.org/api/rest_v1` | 维基词典，冷僻词和短语也查得到 |
| Datamuse | `api.datamuse.com/words` | 轻量英文释义，响应最快 |

**中译英引擎**（同一批服务换个目标语言）

| 引擎 | 接口 | 特点 |
| --- | --- | --- |
| Google 翻译（默认） | `clients5.google.com` | 综合最好，单词还会附带英文对应词与拼音 |
| 有道翻译 | `aidemo.youdao.com/trans` | 中文原文理解得更准，国内网络可直连 |
| MyMemory | `api.mymemory.translated.net` | 开放翻译记忆库，匿名每日有免费额度 |
| SimplyTranslate | `simplytranslate.org/api/translate` | Google 的公共镜像，直连被拦时的备胎 |

**汉英词典**

| 引擎 | 接口 | 特点 |
| --- | --- | --- |
| 有道汉英（默认） | `dict.youdao.com/jsonapi`（`ce` 词典） | 英文对应词按词性分组，另有拼音，覆盖最全 |
| 金山词霸 | `dict-mobile.iciba.com` | 词条短，常用义项覆盖得不错，不给拼音 |
| 有道联想 | `dict.youdao.com/suggest`（`le=en`） | 接口最轻，响应最快，也收词组 |

没有真人录音时会退回浏览器自带的语音合成。嗓音由 `src/common/voices.js` 挑：先按语言与口音过滤，再从推荐名单里选（en-US 优先 Ava / Allison / Samantha / Alex，en-GB 优先 Daniel / Kate / Serena，中文优先 Ting-Ting），并避开 macOS 自带的一堆特效嗓音（Albert、Bad News、Bells、Boing、Bubbles、Zarvox……全都标着「本地」，不挡掉的话默认就会挑中排在最前的 Albert）。不满意可以在设置页「发音」一节直接指定嗓音，旁边有试听；这份规则被内容脚本与设置页共用，所以试听听到的就是卡片上会读出来的那个。

音标和发音取两本词典里先给出的那份（英汉优先）；两边都没有时，退回 Google 翻译给的音译。中文词卡片上标的是拼音，🔈 读的是排在最前的那个英文对应词（走有道通用发音接口，失败则退回浏览器语音合成），点拼音本身则用系统的中文嗓音念一遍中文原词；整句卡片没有现成录音，直接用浏览器语音合成朗读英文那一侧。

设置页的「自动降级」默认开启：首选引擎失败时按注册表顺序依次尝试其余引擎；关掉则只用选中的那一个，失败即报错。

卡片底部会标出这次结果实际来自哪些引擎（例如 `来源 Google 翻译 + 有道词典`），降级发生时显示的是真正出结果的那个而不是你选的那个；命中本地缓存时会额外标注「本地缓存」。

请求只在后台 service worker 发出，只携带选中的文本，不发送页面地址或身份信息。查询结果按「引擎组合 + 文本」在本地缓存 7 天（最多 600 条），可在设置页清空。

> 新增引擎只需在 `src/common/engines.js` 的 `TRANSLATE_ENGINES` / `CN_DICT_ENGINES` / `EN_DICT_ENGINES` / `ZH_TRANSLATE_ENGINES` / `ZH_DICT_ENGINES` 里加一项，设置页的下拉框会自动出现；别忘了把域名加进 `manifest.json` 的 `host_permissions`。

## 自测

```bash
node tools/test-query.mjs                 # 跑默认样例
node tools/test-query.mjs ubiquitous "It works."   # 指定内容
node tools/test-query.mjs --engines       # 逐个体检所有引擎（看谁还活着）
node tools/test-query.mjs --engine=youdao --cn=iciba --en=wiktionary book   # 指定引擎组合
node tools/test-query.mjs --zh-engine=youdao --zh=iciba 人工智能    # 指定中译英引擎组合
node tools/test-query.mjs --no-zh 人工智能        # 模拟关掉中译英（应报「未开启中译英」）
node tools/test-query.mjs --no-fallback --cn=iciba book            # 关掉降级，只用指定的那个
open demo/preview.html                    # 肉眼检查卡片样式与定位（?auto=word|text|zhword|zhtext 自动弹卡片）
python3 tools/make_icons.py               # 重新生成图标（需要 Pillow）
```

**排查发音问题**：点卡片上的 🔈 / 音标 / 拼音时，内容脚本会把整条发音链路打进页面控制台
（录音候选、逐个播放成败、最终选中的嗓音、utterance 的 lang 与语速、朗读事件、队列状态，
外加一张 `console.table` 列出系统所有嗓音）。日志前缀是 `[LightDict 发音]`，走的是
`console.warn`——`console.log` 属于 Info 级，容易被控制台的级别过滤悄悄吞掉。内容脚本
加载时还会打一行 `[LightDict] 内容脚本已加载 vX.Y.Z`：看不到它就说明页面上跑的还是旧代码
（在 `chrome://extensions/` 重新加载扩展后，页面本身也要刷新一次）。

把 DevTools 控制台左上角的执行环境从 `top` 切到 `LightDict 轻词典`，还能手动试：

```js
__lightdict.voices()                // 列出系统所有嗓音
__lightdict.speak('hello', 'en')    // 用扩展的挑嗓音逻辑念（可加第三个参数 'uk' / 'us'）
__lightdict.speak('你好', 'zh')
__lightdict.try('Alex', 'hello')    // 指定嗓音名试念，用来横向比较
__lightdict.raw('hello', 'en-GB')   // 绕过扩展逻辑，直接交给系统念，用来对比
```

## 已知限制

- 这些公开端点都没有 SLA，高频使用可能被临时限流或下线；开启自动降级可以顶住单个引擎失效。
- MyMemory 免费额度按 IP 计算（约每天 5000 词），超出后返回错误提示。
- 只有有道词典和 Free Dictionary 提供真人发音音频；两本词典都换成别的之后，🔈 会退化为浏览器自带的语音合成。
- 嗓音是各台电脑自己安装的，设置里存的是嗓音名：换一台机器若没有同名嗓音，会自动退回推荐名单，设置页里会把它标成「本机不可用」。
- 有道词典对词组（如 `give up`）给的是整句式解释而不是短词条，卡片会偏长；想要短词条可以换成金山词霸。
- 中译英是按「选区里出现汉字」判定方向的，中英混排的选区会整段译成英文。
- 汉英词典给的是对应词而不是英文释义，中文词卡片上没有英英解释；中文句子也没有真人录音，只能用浏览器语音合成朗读。
- 除中文外的其它语言（日文、法文……）仍按原来的方式处理：整段译成中文。
