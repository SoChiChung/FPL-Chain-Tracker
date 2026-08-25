"""FPL Chain Tracker 采集入口。design.md §4/§9/§10。

用法：
    python crawler/run.py [--config config.json] [--full] [--bootstrap-local PATH]

退出码：0 成功；1 配置错误；2 抓取失败；3 校验失败。
所有输出先写 data/.tmp/，全部校验通过后原子替换正式文件；任一步失败不触碰旧数据。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from api_client import ApiClient, ApiError
from config import load_config
from enrich import build_maps, enrich_pick
from stats import compute_manager_stats, compute_season_totals
from timeutil import deadline_fields, derive_season, parse_utc, to_ms, utc_now, format_utc
from validate import validate_all, ValidationError

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
TMP_DIR = DATA_DIR / ".tmp"
AVATAR_DIR = ROOT / "assets" / "avatar"

GW_TOTAL = 38
CANONICAL_CHIP = {
    "wildcard": "wildcard",
    "freehit": "free_hit",
    "bbooster": "bench_boost",
    "3xc": "triple_captain",
}
ACTIVE_STATUS = ("live", "finished")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="FPL Chain Tracker 采集程序")
    ap.add_argument("--config", default=str(ROOT / "config.json"), help="config.json 路径")
    ap.add_argument("--full", action="store_true",
                    help="全量回填：无视封印，重抓 started_event..当前 GW 全部轮次")
    ap.add_argument("--bootstrap-local", metavar="PATH",
                    help="用本地 bootstrap JSON 代替网络请求（离线测试用）")
    return ap.parse_args(argv)


def load_bootstrap(client: ApiClient, local_path: str | None) -> dict:
    if local_path:
        path = Path(local_path)
        if not path.is_file():
            raise ApiError(f"本地 bootstrap 文件不存在: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ApiError(f"本地 bootstrap JSON 解析失败: {exc}") from exc
        for key in ("events", "teams", "elements"):
            if key not in data:
                raise ApiError(f"本地 bootstrap 缺少 '{key}' 字段")
        print(f"[run] 使用本地 bootstrap: {path}")
        return data
    return client.bootstrap_static()


def classify_event(ev: dict, now, seal_hours: float, sealed_eligible) -> str:
    """design.md §9.1 GW 状态机。"""
    deadline = parse_utc(ev["deadline_time"])
    if deadline > now:
        return "upcoming"
    if bool(ev.get("finished")) and (now - deadline).total_seconds() > seal_hours * 3600 \
            and sealed_eligible(ev["id"]):
        return "sealed"
    if bool(ev.get("finished")):
        return "finished"
    return "live"


def build_transfer_entries(trs: list[dict], players: dict[int, dict]) -> list[dict]:
    out = []
    for t in trs:
        out.append({
            "element_in": t.get("element_in"),
            "element_in_name": players.get(t.get("element_in"), {}).get("name"),
            "element_out": t.get("element_out"),
            "element_out_name": players.get(t.get("element_out"), {}).get("name"),
            "cost": t.get("cost"),
            "gw": t.get("event"),
            "time_utc": t.get("time"),
        })
    return out


def serialize(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)
    tz = cfg["timezone"]
    seal_hours = float(cfg["crawl"]["seal_after_hours"])
    team_id = cfg["team_id"]
    managers = cfg["managers"]

    client = ApiClient(
        user_agent=cfg["crawl"]["user_agent"],
        delay=cfg["crawl"]["request_delay_seconds"],
        timeout=cfg["crawl"]["request_timeout_seconds"],
        max_retries=cfg["crawl"]["max_retries"],
    )

    bootstrap = load_bootstrap(client, args.bootstrap_local)
    entry = client.entry(team_id)
    history = client.history(team_id)
    transfers_data = client.transfers(team_id)

    now = utc_now()
    events = sorted(bootstrap["events"], key=lambda e: e["id"])
    season = cfg.get("season") or derive_season(events[0]["deadline_time"])
    started_event = entry.get("started_event") or 1

    # ---- GW 状态机（§9.1/§9.2）----
    current_gw_id = max(
        (e["id"] for e in events if parse_utc(e["deadline_time"]) <= now),
        default=None,
    )
    if entry.get("current_event") and current_gw_id \
            and entry["current_event"] != current_gw_id:
        print(f"[run] WARNING: API current_event={entry['current_event']} "
              f"与判定 current_gw={current_gw_id} 不一致（以判定结果为准）")

    def file_exists(eid: int) -> bool:
        return (DATA_DIR / f"gw-{eid:02d}.json").is_file()

    def sealed_eligible(eid: int) -> bool:
        return current_gw_id is not None and eid <= current_gw_id and file_exists(eid)

    statuses = {e["id"]: classify_event(e, now, seal_hours, sealed_eligible) for e in events}

    # 抓取集合：live/finished；--full 时扩展到 started_event..当前 GW（无视封印）
    picks_set = {eid for eid, st in statuses.items() if st in ACTIVE_STATUS}
    if args.full:
        if current_gw_id is None:
            picks_set = set()
        else:
            picks_set = set(range(started_event, current_gw_id + 1))

    # ---- 抓取 picks（增量集合，§10.3）----
    picks_data: dict[int, dict] = {}
    for gw in sorted(picks_set):
        picks_data[gw] = client.picks(team_id, gw)

    # ---- history（§5.2：chips 赛季权威源，overall_rank 缺失回退 rank）----
    hist_by_gw: dict[int, dict] = {}
    for h in history.get("current") or []:
        g = h.get("event")
        hist_by_gw[g] = {
            "score": h.get("points"),
            "total_points": h.get("total_points"),
            "overall_rank": h.get("overall_rank") if h.get("overall_rank") is not None else h.get("rank"),
            "gw_rank": h.get("rank"),
        }
    chips_by_gw: dict[int, str] = {}
    for c in history.get("chips") or []:
        chips_by_gw[c.get("event")] = CANONICAL_CHIP.get(c.get("name"), c.get("name"))

    # ---- transfers（按 event 归组，§5.2；无转会时 API 可能返回 [] 而非对象）----
    transfers_raw = (
        transfers_data
        if isinstance(transfers_data, list)
        else (transfers_data or {}).get("transfers") or []
    )
    transfers_by_gw: dict[int, list[dict]] = {}
    for t in transfers_raw:
        transfers_by_gw.setdefault(t.get("event"), []).append(t)
    for lst in transfers_by_gw.values():
        lst.sort(key=lambda t: t.get("time") or "")

    players, _teams = build_maps(bootstrap)

    def manager_for(gw: int) -> dict | None:
        for m in managers:
            if m["start_gw"] <= gw <= m["end_gw"]:
                return m
        return None

    def avatar_path(m: dict | None) -> str | None:
        if m is None:
            return None
        # 前端用相对路径（design.md §6.4），兼容 user.github.io/repo/ 子路径部署
        return f"assets/avatar/{m['avatar']}"

    # ---- 组装 gw_list（§8.2）----
    gw_list: list[dict] = []
    for gw in range(1, GW_TOTAL + 1):
        status = statuses[gw]
        manager = manager_for(gw)
        hist = hist_by_gw.get(gw, {})
        has_detail = gw in picks_set
        chips_picks = None
        if gw in picks_data:
            active = picks_data[gw].get("active_chip")
            chips_picks = CANONICAL_CHIP.get(active, active) if active else None
        chips_hist = chips_by_gw.get(gw)
        chips_list: list[str] = []
        if chips_hist or chips_picks:
            if chips_hist and chips_picks and chips_hist != chips_picks:
                print(f"[run] WARNING: gw{gw} 芯片不一致 history={chips_hist} "
                      f"picks={chips_picks}，以 picks 为准")
                chips_list = [chips_picks]
            else:
                chips_list = [chips_picks or chips_hist]
        trs = transfers_by_gw.get(gw, []) if has_detail else []
        gw_list.append({
            "gw": gw,
            "status": status,
            "manager": manager["name"] if manager else None,
            "manager_avatar": avatar_path(manager),
            "score": hist.get("score"),
            "total_points": hist.get("total_points"),
            "overall_rank": hist.get("overall_rank"),
            "gw_rank": hist.get("gw_rank"),
            "chips": chips_list if status != "upcoming" else None,
            "transfers_count": len(trs) if has_detail else 0,
            "transfers_cost": round(sum(t.get("cost") or 0 for t in trs), 1) if has_detail else 0,
            "has_detail": has_detail,
        })

    # ---- gw 详情（§8.3）----
    gw_details: dict[int, dict] = {}
    for gw in sorted(picks_set):
        raw_picks = sorted(picks_data[gw].get("picks") or [], key=lambda p: p.get("position", 99))
        starters, subs = [], []
        for p in raw_picks:
            item = enrich_pick(p, players)
            (subs if item["is_substitute"] else starters).append(item)
        summary = next(g for g in gw_list if g["gw"] == gw)
        gw_details[gw] = {
            "season": season,
            "gw": gw,
            "status": summary["status"],
            "summary": summary,
            "lineup": {"starters": starters, "subs": subs},
            "transfers": build_transfer_entries(transfers_by_gw.get(gw, []), players),
            "chips": summary["chips"] or [],
        }

    # ---- 全局状态与 meta（§8.1）----
    global_status = (
        "season_ended" if statuses[GW_TOTAL] == "sealed"
        else ("pre_season" if current_gw_id is None else "live")
    )
    next_gw = None
    if global_status == "pre_season":
        next_gw = events[0]
    elif global_status != "season_ended":
        next_gw = next((e for e in events if e["id"] > (current_gw_id or 0)), None)
    next_deadline = (
        {"gw": next_gw["id"], **deadline_fields(next_gw["deadline_time"], tz)}
        if next_gw else None
    )

    meta_events = []
    for e in events:
        meta_events.append({
            "id": e["id"],
            "name": e.get("name"),
            **deadline_fields(e["deadline_time"], tz),
            "finished": bool(e.get("finished")),
            "status": statuses[e["id"]],
        })

    stats_managers = compute_manager_stats(managers, gw_list)
    season_totals = compute_season_totals(gw_list)

    # ---- 内容文件（§8.2/§8.3/§8.4）----
    summary_obj = {
        "season": season,
        "data_version": 0,      # 占位，比较后替换
        "updated_at_utc": "",   # 占位
        "gw_list": gw_list,
    }
    stats_obj = {
        "season": season,
        "data_version": 0,
        "updated_at_utc": "",
        "managers": stats_managers,
        "season_totals": season_totals,
    }
    content_files: dict[str, dict] = {
        "summary.json": summary_obj,
        "stats.json": stats_obj,
    }
    content_files.update({f"gw-{gw:02d}.json": d for gw, d in sorted(gw_details.items())})

    # ---- data_version：仅内容真实变化时 +1（§12.5）----
    prev_meta = read_json(DATA_DIR / "meta.json") or {}
    prev_version = prev_meta.get("data_version", 0) if isinstance(prev_meta, dict) else 0
    prev_updated = (read_json(DATA_DIR / "summary.json") or {}).get("updated_at_utc")

    def significant(obj: dict) -> dict:
        return {k: v for k, v in obj.items() if k not in ("data_version", "updated_at_utc")}

    changed = False
    for name, obj in content_files.items():
        old = read_json(DATA_DIR / name)
        if not isinstance(old, dict) or significant(old) != significant(obj):
            changed = True
            break
    data_version = prev_version + 1 if changed else prev_version
    updated_at = format_utc(now) if changed else prev_updated or format_utc(now)
    summary_obj["data_version"] = data_version
    summary_obj["updated_at_utc"] = updated_at
    stats_obj["data_version"] = data_version
    stats_obj["updated_at_utc"] = updated_at

    meta = {
        "season": season,
        "team": {
            "id": team_id,
            "name": entry.get("name"),
            "player_first_name": entry.get("player_first_name"),
            "player_last_name": entry.get("player_last_name"),
            "started_event": started_event,
            "current_event": entry.get("current_event"),
        },
        "current_gw": {"id": current_gw_id, "status": global_status},
        "next_deadline": next_deadline,
        "events": meta_events,
        "managers": [
            {
                "name": m["name"],
                "start_gw": m["start_gw"],
                "end_gw": m["end_gw"],
                "avatar": avatar_path(m),
                "active": m["start_gw"] <= (current_gw_id or 0) <= m["end_gw"],
            }
            for m in managers
        ],
        "data_version": data_version,
        "generated_at_utc": format_utc(now),
        "server_timestamp": to_ms(now),
    }

    payloads: dict[str, str] = {name: serialize(obj) for name, obj in content_files.items()}
    payloads["meta.json"] = serialize(meta)

    # ---- 校验（§14.2：失败不写正式文件）----
    validate_all(meta, summary_obj, gw_details, stats_obj)

    # ---- 原子写入（§4.3）----
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    for name, content in payloads.items():
        (TMP_DIR / name).write_text(content, encoding="utf-8")
    # 清理上一赛季遗留、且本赛季仍未开始的 gw 文件
    for f in DATA_DIR.glob("gw-*.json"):
        eid = int(f.stem.split("-")[1])
        if statuses[eid] == "upcoming":
            f.unlink()
    for name in payloads:
        os.replace(TMP_DIR / name, DATA_DIR / name)

    print(f"[run] season={season} current_gw={current_gw_id} status={global_status}")
    print(f"[run] picks 抓取 {len(picks_set)} 轮: {sorted(picks_set)}")
    print(f"[run] api 请求数: {client.requests}")
    print(f"[run] data_version={data_version} 内容变更={changed}"
          + ("" if changed else "（无变化，不产生提交）"))
    print(f"[run] 已写入 {len(payloads)} 个文件")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ApiError as exc:
        print(f"[run] FAILED: {exc}", file=sys.stderr)
        sys.exit(2)
    except ValidationError as exc:
        print(f"[run] VALIDATION FAILED:\n{exc}", file=sys.stderr)
        sys.exit(3)
