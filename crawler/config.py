"""config.json 加载与自检。对应 design.md §6。

与 design.md §6.6 的一个刻意偏差：头像文件缺失在采集运行时只是 WARNING 而非
硬错误（前端有 default.png 兜底，头像可以后补）；scripts/check_config.py 提供
严格校验模式。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parent.parent
AVATAR_DIR = ROOT / "assets" / "avatar"
GW_MIN, GW_MAX = 1, 38
AVATAR_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

CRAWL_DEFAULTS = {
    "request_delay_seconds": 0.4,
    "max_retries": 3,
    "request_timeout_seconds": 10,
    "seal_after_hours": 48,
    "user_agent": "Mozilla/5.0 (compatible; FPLChainTracker/1.0)",
}


def check_config(cfg: dict) -> tuple[list[str], list[str]]:
    """返回 (errors, warnings)。errors 非空时采集不应继续。"""
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(cfg.get("team_id"), int):
        errors.append("team_id 必须为整数")
    if not isinstance(cfg.get("timezone"), str):
        errors.append("timezone 必须为字符串（IANA 时区名）")
    else:
        try:
            ZoneInfo(cfg["timezone"])
        except ZoneInfoNotFoundError:
            errors.append(f"timezone 不是合法 IANA 时区: {cfg['timezone']}")
    if cfg.get("season") is not None and not isinstance(cfg["season"], str):
        errors.append("season 必须为字符串（如 2026-27）")

    crawl = cfg.get("crawl") or {}
    for key in ("request_delay_seconds", "request_timeout_seconds", "seal_after_hours"):
        value = crawl.get(key)
        if not (isinstance(value, (int, float)) and value > 0):
            errors.append(f"crawl.{key} 必须为正数")
    if not (isinstance(crawl.get("max_retries"), int) and crawl["max_retries"] >= 0):
        errors.append("crawl.max_retries 必须为非负整数")

    managers = cfg.get("managers")
    if not isinstance(managers, list) or not managers:
        errors.append("managers 必须为非空数组")
        return errors, warnings

    seen: set[str] = set()
    intervals: list[tuple[int, int, str]] = []
    for i, m in enumerate(managers):
        tag = f"managers[{i}]"
        name = m.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{tag}.name 必须为非空字符串")
            continue
        if name in seen:
            errors.append(f"玩家 name 重复: {name}")
        seen.add(name)

        start_gw, end_gw = m.get("start_gw"), m.get("end_gw")
        if not (isinstance(start_gw, int) and isinstance(end_gw, int)):
            errors.append(f"{tag}({name}) start_gw/end_gw 必须为整数")
        elif not (GW_MIN <= start_gw <= end_gw <= GW_MAX):
            errors.append(
                f"{tag}({name}) 接管区间非法: {start_gw}-{end_gw}"
                f"（须 {GW_MIN} ≤ start_gw ≤ end_gw ≤ {GW_MAX}）"
            )
        else:
            intervals.append((start_gw, end_gw, name))

        avatar = m.get("avatar")
        if avatar is None:
            m["avatar"] = f"{name}.png"
        elif not (isinstance(avatar, str) and Path(avatar).suffix.lower() in AVATAR_EXTS):
            errors.append(
                f"{tag}({name}) avatar 必须为图片文件名（png/jpg/jpeg/webp/gif），"
                f"当前: {avatar!r}"
            )
        if isinstance(m.get("avatar"), str) and not (AVATAR_DIR / m["avatar"]).is_file():
            warnings.append(
                f"{tag}({name}) 缺少头像文件: assets/avatar/{m['avatar']}（前端将使用 default.png 兜底）"
            )

    intervals.sort()
    for (prev_end, _, prev_name), (next_start, _, next_name) in zip(intervals, intervals[1:]):
        if next_start <= prev_end:
            errors.append(
                f"接管区间重叠: {prev_name} 结束 GW{prev_end}，{next_name} 起始 GW{next_start}"
            )
    return errors, warnings


def load_config(path: str | Path) -> dict:
    cfg_path = Path(path)
    if not cfg_path.is_file():
        print(f"[config] ERROR: config 文件不存在: {cfg_path}", file=sys.stderr)
        raise SystemExit(1)
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[config] ERROR: config JSON 解析失败: {exc}", file=sys.stderr)
        raise SystemExit(1)
    if not isinstance(cfg, dict):
        print("[config] ERROR: config 顶层必须是 JSON 对象", file=sys.stderr)
        raise SystemExit(1)

    cfg["crawl"] = {**CRAWL_DEFAULTS, **(cfg.get("crawl") or {})}
    errors, warnings = check_config(cfg)
    for w in warnings:
        print(f"[config] WARNING: {w}", file=sys.stderr)
    if errors:
        for e in errors:
            print(f"[config] ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
    return cfg
