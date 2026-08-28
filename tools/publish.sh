#!/usr/bin/env bash
# 通过 Chrome Web Store API 上传 / 发布扩展。
#
#   bash tools/publish.sh auth        一次性：换取 refresh token（会开浏览器）
#   bash tools/publish.sh status      看后台那边当前是什么状态
#   bash tools/publish.sh upload      把 dist/ 里的 zip 传上去（覆盖草稿，不发布）
#   bash tools/publish.sh publish     把草稿提交审核 / 发布
#
# 凭据放在仓库外的 ~/.config/lightdict/cws.env，格式：
#
#   CWS_CLIENT_ID=xxx.apps.googleusercontent.com
#   CWS_CLIENT_SECRET=xxx
#   CWS_REFRESH_TOKEN=xxx          # 由 auth 子命令生成后填回来
#   CWS_ITEM_ID=xxx                # 条目建好后从后台地址栏抄，首次上传可留空
#
# 注意：商店文案、截图、权限理由、数据用途声明没有接口，只能在开发者后台填。
# 这些必填项没补齐时 publish 会回 ITEM_NOT_READY——那不是脚本的问题。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
env_file="${CWS_ENV:-$HOME/.config/lightdict/cws.env}"
scope="https://www.googleapis.com/auth/chromewebstore"
redirect="http://localhost:8080"

# auth 只要 client id / secret，其余子命令要凭据齐全
load_env () {
  [ -f "$env_file" ] || { echo "找不到凭据文件：$env_file（见本脚本开头的格式说明）" >&2; exit 1; }
  set -a; . "$env_file"; set +a
}

json () {  # json <字段> —— 从标准输入的 JSON 里取一个顶层字段
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    let j; try { j = JSON.parse(s) } catch { console.error(s); process.exit(1) }
    if (j.error) { console.error(JSON.stringify(j, null, 2)); process.exit(1) }
    console.log(j['$1'] ?? '')
  })"
}

cmd_auth () {
  load_env
  local url="https://accounts.google.com/o/oauth2/auth?response_type=code&access_type=offline&prompt=consent"
  url="$url&scope=$scope&client_id=$CWS_CLIENT_ID&redirect_uri=$redirect"
  echo "· 浏览器里授权（用注册了开发者账号的那个 Google 账号）"
  open "$url" 2>/dev/null || echo "  手动打开：$url"
  echo "· 等回调（授权完这个页面会转到 localhost:8080，浏览器显示打不开是正常的）"
  # 授权后浏览器会请求 localhost:8080/?code=...，用 nc 接住那一行请求把 code 抠出来
  local code
  code="$(nc -l 8080 | head -1 | sed -n 's/.*[?&]code=\([^& ]*\).*/\1/p')"
  [ -n "$code" ] && echo "· 拿到授权码" || { echo "没接到授权码" >&2; exit 1; }
  local token
  token="$(curl -s https://oauth2.googleapis.com/token \
    -d "client_id=$CWS_CLIENT_ID" -d "client_secret=$CWS_CLIENT_SECRET" \
    -d "code=$code" -d "grant_type=authorization_code" \
    -d "redirect_uri=$redirect" | json refresh_token)"
  [ -n "$token" ] || { echo "没换到 refresh token" >&2; exit 1; }
  echo
  echo "把这一行写进 $env_file ："
  echo "CWS_REFRESH_TOKEN=$token"
}

access_token () {
  curl -s https://oauth2.googleapis.com/token \
    -d "client_id=$CWS_CLIENT_ID" -d "client_secret=$CWS_CLIENT_SECRET" \
    -d "refresh_token=$CWS_REFRESH_TOKEN" -d "grant_type=refresh_token" | json access_token
}

api () {  # api <方法> <地址> [curl 的其余参数...]
  local method="$1" url="$2"; shift 2
  curl -s -X "$method" "$url" \
    -H "Authorization: Bearer $(access_token)" -H "x-goog-api-version: 2" "$@"
}

cmd_status () {
  load_env
  api GET "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_ITEM_ID?projection=DRAFT" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
}

cmd_upload () {
  load_env
  local version zip
  version="$(node -p "require('./manifest.json').version")"
  zip="dist/lightdict-$version.zip"
  [ -f "$zip" ] || bash tools/make_package.sh
  echo "· 上传 $zip"
  if [ -n "${CWS_ITEM_ID:-}" ]; then
    api PUT "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$CWS_ITEM_ID" \
      -T "$zip" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
  else
    # 没有 item id 就是新建条目，返回里的 id 要填回 cws.env
    echo "  （CWS_ITEM_ID 为空，按新建条目处理）"
    api POST "https://www.googleapis.com/upload/chromewebstore/v1.1/items" \
      -T "$zip" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
  fi
}

cmd_publish () {
  load_env
  [ -n "${CWS_ITEM_ID:-}" ] || { echo "CWS_ITEM_ID 为空，先 upload 建条目" >&2; exit 1; }
  echo "· 提交发布（default 渠道，全量）"
  api POST "https://www.googleapis.com/chromewebstore/v1.1/items/$CWS_ITEM_ID/publish?publishTarget=default" \
    -H "Content-Length: 0" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s))"
}

case "${1:-}" in
  auth)    cmd_auth ;;
  status)  cmd_status ;;
  upload)  cmd_upload ;;
  publish) cmd_publish ;;
  *) awk 'NR>1 && !/^#/ { exit } NR>1 { sub(/^# ?/, ""); print }' "$0"; exit 1 ;;
esac
