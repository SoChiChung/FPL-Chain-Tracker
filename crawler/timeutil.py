"""UTC 与配置时区（默认 Asia/Shanghai）之间的转换。design.md §9.3。

FPL API 一律返回 UTC（ISO 8601 带 Z）。输出同时保存三种表示：
deadline_utc（原始）/ deadline_beijing（+08:00 偏移 ISO）/ deadline_timestamp（Unix 毫秒）。
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_utc(iso: str) -> datetime:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def format_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def format_local(dt: datetime, tz_name: str) -> str:
    s = dt.astimezone(ZoneInfo(tz_name)).strftime("%Y-%m-%dT%H:%M:%S%z")
    return s[:-2] + ":" + s[-2:]  # %z 输出 +0800，补冒号成 ISO 规范的 +08:00


def to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def deadline_fields(iso: str, tz_name: str) -> dict:
    """一个 deadline 时间的三份结构化表示（§9.3）。"""
    dt = parse_utc(iso)
    return {
        "deadline_utc": format_utc(dt),
        "deadline_beijing": format_local(dt, tz_name),
        "deadline_timestamp": to_ms(dt),
    }


def derive_season(gw1_deadline_iso: str) -> str:
    """按 GW1 deadline 所在年份推导赛季标识，如 2026-08 的 GW1 → '2026-27'。"""
    dt = parse_utc(gw1_deadline_iso)
    year, month = dt.year, dt.month
    if month >= 7:
        return f"{year}-{(year + 1) % 100:02d}"
    return f"{year - 1}-{year % 100:02d}"
