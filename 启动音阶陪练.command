#!/bin/bash
# 双击启动：在本机开一个小网页服务器，用浏览器打开音阶陪练
cd "$(dirname "$0")"
PORT=8765
if ! lsof -i :$PORT >/dev/null 2>&1; then
  python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER=$!
  sleep 1
fi
open "http://localhost:$PORT/"
echo "音阶陪练已在浏览器打开（第一次会询问麦克风权限，请点允许）。"
echo "练完后关掉这个窗口即可。"
[ -n "$SERVER" ] && wait $SERVER
