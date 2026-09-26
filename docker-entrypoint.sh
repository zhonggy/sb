#!/bin/sh
# 容器启动入口：先起 Xvfb 虚拟显示（HEADLESS=false 的 headed 浏览器用），再执行 CMD
#
# 为什么不用 xvfb-run：它的就绪握手依赖 X server 启动完成时向父进程发 SIGUSR1，
# 而 X server 对 getppid()==1（父进程是容器 PID 1）的场景【不发送】该信号——
# xvfb-run 作为 PID 1 会永久卡在 wait()，Xvfb 起了但业务进程从未执行、容器无日志
# unhealthy。改用本脚本：后台起 Xvfb + 轮询 /tmp/.X11-unix/X99 socket 判就绪。
set -e

if command -v Xvfb >/dev/null 2>&1; then
  if [ ! -S /tmp/.X11-unix/X99 ]; then
    Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
    # 等就绪（最多 ~5s）：unix socket 出现即认为可用
    i=0
    while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    if [ ! -S /tmp/.X11-unix/X99 ]; then
      echo "[entrypoint] 警告: Xvfb 5s 内未就绪（/tmp/.X11-unix/X99 不存在），HEADLESS=false 的浏览器可能启动失败" >&2
    fi
  fi
  export DISPLAY=:99
fi

exec "$@"
