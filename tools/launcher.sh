#!/bin/bash
set -u
cd -- "$(dirname -- "$0")/.." || exit 1
MODE="${1:-doctor}"
shift || true
RESULT=0
finish() {
  if [ -t 0 ]; then
    if [ "${SIDE_KEEP_OPEN:-0}" = "1" ]; then
      printf '\n按回车结束（已选择保留结果）…'
      IFS= read -r _side_answer || true
    elif [ "$RESULT" -ne 0 ]; then
      printf '\n操作未完成。按回车结束，或等待 20 秒自动退出…'
      IFS= read -r -t 20 _side_answer || true
    else
      printf '\n操作已结束，脚本自动退出。\n'
    fi
  fi
  exit "$RESULT"
}
trap 'RESULT=130; exit "$RESULT"' INT
trap 'RESULT=143; exit "$RESULT"' TERM
if [ "$(uname -s)" != "Darwin" ]; then
  printf '第一版安装器仅支持 macOS。\n'
  RESULT=1; finish
fi
SIDE_APP="${DSH_SIDE_APP:-}"
if [ -z "$SIDE_APP" ]; then
  for candidate in '/Applications/DeepSeek Harness.app' "$HOME/Applications/DeepSeek Harness.app"; do
    if [ -d "$candidate" ]; then SIDE_APP="$candidate"; break; fi
  done
fi
if [ -z "$SIDE_APP" ] && [ -x /usr/bin/mdfind ]; then
  while IFS= read -r candidate; do
    if [ -d "$candidate/Contents" ]; then SIDE_APP="$candidate"; break; fi
  done < <(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.deepseek.dsh"' 2>/dev/null)
fi
if [ -z "$SIDE_APP" ]; then
  printf '未找到 DeepSeek Harness。请先安装并启动一次，再退出应用后重试。\n'
  RESULT=1; finish
fi
export DSH_SIDE_APP="$SIDE_APP"
SIDE_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SIDE_APP/Contents/Info.plist" 2>/dev/null || true)
SIDE_NODE="$SIDE_APP/Contents/MacOS/$SIDE_EXECUTABLE"
if [ -n "$SIDE_EXECUTABLE" ] && [ -x "$SIDE_NODE" ] && ELECTRON_RUN_AS_NODE=1 "$SIDE_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  ELECTRON_RUN_AS_NODE=1 "$SIDE_NODE" tools/entry.cjs "$MODE" "$@" || RESULT=$?
else
  SIDE_NODE=''
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then SIDE_NODE="$candidate"; break; fi
  done
  if [ -z "$SIDE_NODE" ]; then
    printf '应用运行环境不可用，也没有找到 Node 20 或更新版本。未修改任何配置。\n请查看使用说明中的运行环境章节。\n'
    RESULT=1
  else
    "$SIDE_NODE" tools/entry.cjs "$MODE" "$@" || RESULT=$?
  fi
fi
finish
