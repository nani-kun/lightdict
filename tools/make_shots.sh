#!/usr/bin/env bash
# 重新生成 README 里的截图（docs/screenshots/）。
#
# 用 headless Chrome 拍 demo/ 下的两个演示页——它们跑的是真实的 content.js 与
# page-translate.js，只是把后台换成了假数据，所以不联网也拍得出真实效果，
# 而且每次结果一模一样，改了样式重跑一遍就能看出差异。
#
#   bash tools/make_shots.sh
#
# 需要：本机装了 Chrome，以及 Python 的 Pillow（裁图用，pip install pillow）。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
tmp="$(mktemp -d)"
out="$root/docs/screenshots"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

[ -x "$chrome" ] || { echo "找不到 Chrome：$chrome（可用 CHROME=... 指定）" >&2; exit 1; }

# --force-device-scale-factor=2 出 2 倍图，README 在高分屏上才不糊。
# --virtual-time-budget 让 Chrome 把定时器快进完再拍，卡片有 0.4 秒的停留延迟。
shot () {
  "$chrome" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size="$2" --virtual-time-budget=6000 \
    --screenshot="$tmp/$1.png" "file://$root/$3" 2>/dev/null
}

shot word    760,620 'demo/preview.html?auto=word'
shot text    760,620 'demo/preview.html?auto=text'
shot zhword  760,620 'demo/preview.html?auto=zhword'
shot dark    760,620 'demo/preview.html?auto=word&theme=dark'
shot page    900,860 'demo/page.html?auto=1'

python3 - "$tmp" "$out" <<'PY'
import sys, os
from PIL import Image

tmp, out = sys.argv[1], sys.argv[2]

def crop_box(im, bg, pad=44):
    """裁到内容的包围盒：截图里大片留白对 README 是浪费。"""
    d = im.convert('RGB').load()
    w, h = im.size
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = d[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 24:
                xs.append(x); ys.append(y)
    return (max(0, min(xs) - pad), max(0, min(ys) - pad),
            min(w, max(xs) + pad), min(h, max(ys) + pad))

jobs = [
    ('word',   'word.png',     (255, 255, 255), None),
    ('text',   'sentence.png', (255, 255, 255), None),
    ('zhword', 'zh-word.png',  (255, 255, 255), None),
    ('dark',   'dark.png',     (16, 18, 22),    None),
    # 整页翻译整屏都是内容，不用找包围盒；底部切在第二个小标题下面，避开半截列表项
    ('page',   'page.png',     None,            (0, 0, 1800, 1640)),
]

for src, dst, bg, box in jobs:
    im = Image.open(os.path.join(tmp, src + '.png'))
    im.crop(box or crop_box(im, bg)).save(os.path.join(out, dst), optimize=True)
    print('  ' + dst, Image.open(os.path.join(out, dst)).size)
PY

echo "✓ 截图已更新：docs/screenshots/"
