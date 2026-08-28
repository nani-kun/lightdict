#!/usr/bin/env bash
# 打出 Chrome 应用商店要上传的 zip，输出到 dist/lightdict-<版本>.zip。
#
#   bash tools/make_package.sh
#
# 只装扩展跑起来真正用得上的文件：manifest、icons/、src/，外加 LICENSE。
# demo/、docs/、site/、tools/ 与 .git 都不进包——商店按解压后的体积算，
# 也免得把演示页里的假数据当成扩展的一部分送去审核。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# 先跑一遍静态自检，manifest 里写错的路径、语法错的脚本别打进包里
node tools/check.mjs

version="$(node -p "require('./manifest.json').version")"
out="dist/lightdict-$version.zip"
mkdir -p dist
rm -f "$out"

# -X 不存 macOS 的扩展属性，-r 递归；只列白名单，不用 -x 排除
zip -q -r -X "$out" manifest.json icons src LICENSE

files="$(unzip -l "${out}" | tail -1 | awk '{print $2}')"
size="$(du -h "${out}" | cut -f1)"
echo "✓ ${out}（${size}，${files} 个文件）"
