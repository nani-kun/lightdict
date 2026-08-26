## 改了什么

<!-- 一两句话说清这个 PR 做了什么 -->

## 为什么这么改

<!-- 背景与取舍。绕过上游怪癖的地方，请把原因写清楚——将来看代码的人会感谢你 -->

关联 issue：<!-- Fixes #123，没有就删掉这行 -->

## 怎么验证的

<!-- 跑了哪些命令、在哪些页面上试过 -->

- [ ] `node tools/check.mjs` 通过
- [ ] 相关的 `node tools/test-query.mjs ...` 跑过（写明参数）
- [ ] 在 Chrome 里实际加载试过（重载扩展后**也刷新了页面**）
- [ ] 改了 UI：深色与浅色主题各看过一遍（请附截图）

## 检查清单

- [ ] 只做了一件事
- [ ] 没有引入 npm 依赖或构建步骤
- [ ] 新增引擎时：域名已加进 `manifest.json` 的 `host_permissions`，README 的引擎表格已补行
- [ ] 有行为变更时：README 与 `CHANGELOG.md` 的 `Unreleased` 一节已更新
- [ ] 提交信息符合 Conventional Commits（见 [CONTRIBUTING](../CONTRIBUTING.md#提交与-pr)）
- [ ] 没有夹带 `.DS_Store`、打包产物或编辑器配置
