"""config.json 一致性检查（本地开发用）。design.md §6.6。

与 crawler 运行时不同，这里是严格模式：头像文件缺失按错误处理。
用法：python scripts/check_config.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from crawler.config import AVATAR_DIR, load_config  # noqa: E402


def main() -> int:
    cfg = load_config(str(ROOT / "config.json"))
    missing = [m["name"] for m in cfg["managers"] if not (AVATAR_DIR / m["avatar"]).is_file()]
    code = 0
    if missing:
        print(f"[check_config] ERROR: 缺少头像文件: {missing}")
        code = 1
    else:
        print(f"[check_config] 全部 {len(cfg['managers'])} 位玩家头像齐全")
    print(f"[check_config] OK: team_id={cfg['team_id']} timezone={cfg['timezone']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
