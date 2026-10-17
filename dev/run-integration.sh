#!/bin/sh
# 把端到端测试临时放进一个 dsh 源码 checkout 里跑，跑完删干净。
#
#   sh dev/run-integration.sh /Users/zhaoruizhe/Desktop/project/P/deepseek-harness
#
# 它做的唯一一件"侵入"的事：在 checkout 里建两个临时文件（spec + 插件 lib 的副本），
# 跑完就删——退出时会清理，哪怕 vitest 失败。
set -e

CHECKOUT=${1:?用法: sh dev/run-integration.sh <dsh 源码 checkout>}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TESTS="$CHECKOUT/packages/core/agent-loop/tests"
SPEC="$TESTS/message-edit.integration.spec.ts"
LIB="$TESTS/message-edit-lib"

[ -d "$TESTS" ] || { echo "找不到 $TESTS（这是 dsh 源码 checkout 吗？）" >&2; exit 1; }

cleanup() {
  rm -rf "$SPEC" "$LIB"
  echo "已清理临时文件"
}
trap cleanup EXIT INT TERM

mkdir -p "$LIB"
cp "$HERE"/lib/*.js "$LIB/"
cp "$HERE/dev/integration.spec.ts" "$SPEC"

cd "$CHECKOUT"
npx vitest run --project thread-safe packages/core/agent-loop/tests/message-edit.integration.spec.ts
