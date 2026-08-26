# LightDict 展示页

一个静态页面，直接上传即可，没有构建步骤，也不依赖任何外部资源（无 CDN、无字体外链、无埋点）。

```
site/
  index.html      整个页面：HTML + 内联 CSS + 内联 JS
  assets/
    icon.png      128×128 图标（也用作 favicon）
    icon@2x.png   256×256，供 og:image 用
    word.webp     截图：选中单词
    sentence.webp 截图：选中句子
    zh-word.webp  截图：中译英
    dark.webp     截图：深色主题
    page.webp     截图：整页翻译
```

## 部署

把 `site/` 里的内容原样放到网站的某个目录下即可，`index.html` 用的都是相对路径。

- 放在网站根目录 → `https://你的域名/`
- 放在子目录 → `https://你的域名/lightdict/`
- GitHub Pages：把 `site/` 设为 Pages 的发布目录，或整个目录改名为 `docs/` 后在仓库设置里选 `docs/`

唯一需要改的是 `<head>` 里的 `og:image`——社交平台抓取时要求绝对地址：

```html
<meta property="og:image" content="https://你的域名/assets/icon@2x.png" />
```

## 发新版本时要改的地方

版本号和下载链接写死在页面里，发版后搜这几处替换：

| 位置 | 内容 |
| --- | --- |
| 页眉的 `<small>` | `v1.2.0` |
| 主视觉与安装区的下载按钮 | `releases/download/v1.2.0/lightdict-1.2.0.zip` 与文案里的体积 `91 KB` |
| 安装区按钮文字 | `lightdict-1.2.0.zip` |

截图要更新时，先跑 `bash tools/make_shots.sh` 重新生成 `docs/screenshots/`，再转成 WebP 覆盖 `site/assets/`。

## 页面上的划词演示

「试试看」一节是真的划词：选中文字后由页面自己的脚本弹出卡片，用的是和扩展同一套卡片样式与分批填充节奏。数据是写死在 `index.html` 里的几条词条（`WORDS` / `ZH_WORDS` / `SENTENCES` / `ZH_SENTENCES`），不联网。选中没有预置数据的文字时，卡片会说明这是静态演示并给出下载链接。

想增删演示词条，改那几个对象即可；带 `class="has-entry"` 的 `<span>` 是给读者看的虚线提示，记得同步。
