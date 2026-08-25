"""全量回填入口：等价于 crawler/run.py --full。design.md §10.4。

可选参数：本地 bootstrap JSON 路径（离线测试时传入）。
用法：
    python scripts/backfill.py
    python scripts/backfill.py D:/code/fpl/data/FPLstatic.json
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    cmd = [sys.executable, str(ROOT / "crawler" / "run.py"), "--full"]
    if len(sys.argv) > 1:
        cmd += ["--bootstrap-local", sys.argv[1]]
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
