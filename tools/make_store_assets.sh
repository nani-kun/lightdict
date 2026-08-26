#!/usr/bin/env bash
# 生成 Chrome 应用商店要的宣传素材，输出到 docs/store/。
#
#   截图      1280×800，直角满幅，最多 5 张
#   小宣传图  440×280（必填）
#   Marquee   1400×560（选填）
#
# 分两步拍：先把 tools/store/stage.html（一个真实感的文章页，跑真正的内容脚本）
# 拍成 2 倍图，再把它嵌进 tools/store/slide.html 的版式里拍成 1280×800。
# 直接拍舞台也能出图，但商店列表里没有标题就看不出这一张想说什么。
#
#   bash tools/make_store_assets.sh
#
# 需要：本机装了 Chrome，以及 Python 的 Pillow。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
out="$root/docs/store"
shots="$root/tools/store/shots"
trap 'rm -rf "$shots"' EXIT
mkdir -p "$out" "$shots"

[ -x "$chrome" ] || { echo "找不到 Chrome：$chrome（可用 CHROME=... 指定）" >&2; exit 1; }

grab () {  # grab <输出名> <宽,高> <缩放> <url>
  "$chrome" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor="$3" --window-size="$2" --virtual-time-budget=6000 \
    --screenshot="$1" "$4" 2>/dev/null
}

stage="file://$root/tools/store/stage.html"
echo "· 拍舞台"
# 1160×620：版式头部占 208px，图那块只剩 592px，多拍 28px 让它从底部出画
grab "$shots/word.png"     1160,620 2 "$stage?card=word"
grab "$shots/sentence.png" 1160,620 2 "$stage?card=sentence"
grab "$shots/page.png"     1160,620 2 "$stage?page=1"
grab "$shots/zhword.png"   1160,620 2 "$stage?doc=zh&card=word"
grab "$shots/dark.png"     1160,620 2 "$stage?card=word&theme=dark"

echo "· 拍版式"
slide="file://$root/tools/store/slide.html"
for i in 1 2 3 4 5; do
  grab "$out/screenshot-$i.png" 1280,800 1 "$slide?i=$i"
done

echo "· 拍宣传图"
# 宣传图上的图标要放到近 200px，拿 icon128.png 放大会糊，按目标尺寸重画一张。
# ss=2：512 已经够大，再上超采样那个逐像素渐变要跑上千万次。
python3 -c "
import sys; sys.path.insert(0, '$root/tools')
import make_icons
make_icons.make(512, ss=2).save('$shots/icon512.png')
"
tile="file://$root/tools/store/tile.html"
grab "$out/promo-small.png"   440,280  1 "$tile?size=small"
grab "$out/promo-marquee.png" 1400,560 1 "$tile?size=marquee"

# 商店只收 JPEG 或 24 位 PNG。Chrome 拍出来的是带 alpha 的 32 位，
# 虽然整幅都不透明，也先摊到白底再存成 RGB，省得上传时被判格式不合。
python3 - "$out" <<'PY'
import sys, os
from PIL import Image

out = sys.argv[1]
want = {
    'screenshot-1.png': (1280, 800), 'screenshot-2.png': (1280, 800),
    'screenshot-3.png': (1280, 800), 'screenshot-4.png': (1280, 800),
    'screenshot-5.png': (1280, 800),
    'promo-small.png': (440, 280), 'promo-marquee.png': (1400, 560),
}
bad = []
for name, size in want.items():
    path = os.path.join(out, name)
    im = Image.open(path)
    if im.size != size:
        bad.append(f'{name} 是 {im.size}，应为 {size}')
        continue
    flat = Image.new('RGB', im.size, (255, 255, 255))
    flat.paste(im, mask=im.split()[3] if im.mode == 'RGBA' else None)
    flat.save(path, optimize=True)
    print(f'  {name}  {im.size[0]}×{im.size[1]}  {os.path.getsize(path) // 1024} KB')
if bad:
    raise SystemExit('尺寸不对：\n  ' + '\n  '.join(bad))
PY

echo "✓ 商店素材已生成：docs/store/"
