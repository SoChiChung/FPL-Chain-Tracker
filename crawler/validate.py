"""输出数据结构自校验。design.md §8/§14.2。

校验失败时 run.py 不写正式文件、不提交。结构断言为主（Python 标准库，
不引入第三方依赖）；完整 JSON Schema 文档见 schema/ 目录。
"""
from __future__ import annotations

STATUS_ENUM = ("upcoming", "live", "finished", "sealed")
POSITION_ENUM = ("GKP", "DEF", "MID", "FWD")
CHIP_ENUM = ("wildcard", "free_hit", "bench_boost", "triple_captain")


class ValidationError(Exception):
    pass


def _ok(cond: bool, msg: str) -> str | None:
    return None if cond else msg


def validate_meta(meta: dict) -> list[str]:
    checks = [
        _ok(isinstance(meta.get("season"), str), "meta.season 必须为字符串"),
        _ok(isinstance(meta.get("team", {}).get("id"), int), "meta.team.id 必须为整数"),
        _ok(
            meta.get("current_gw", {}).get("id") is None
            or isinstance(meta["current_gw"]["id"], int),
            "meta.current_gw.id 必须为整数或 null",
        ),
        _ok(
            meta.get("current_gw", {}).get("status") in ("pre_season", "live", "season_ended"),
            "meta.current_gw.status 非法",
        ),
        _ok(
            meta.get("next_deadline") is None or isinstance(meta["next_deadline"], dict),
            "meta.next_deadline 必须为对象或 null",
        ),
        _ok(isinstance(meta.get("events"), list) and len(meta["events"]) == 38,
            "meta.events 必须为 38 个事件"),
        _ok(
            all(isinstance(e, dict) and e.get("status") in STATUS_ENUM for e in meta.get("events", [])),
            "meta.events 存在非法 status",
        ),
        _ok(isinstance(meta.get("managers"), list) and meta["managers"],
            "meta.managers 不能为空"),
        _ok(isinstance(meta.get("data_version"), int), "meta.data_version 必须为整数"),
        _ok(isinstance(meta.get("generated_at_utc"), str), "meta.generated_at_utc 必须为字符串"),
        _ok(isinstance(meta.get("server_timestamp"), int), "meta.server_timestamp 必须为整数"),
    ]
    return [c for c in checks if c]


def validate_summary(summary: dict) -> list[str]:
    probs = [
        _ok(isinstance(summary.get("gw_list"), list), "summary.gw_list 必须为数组"),
        _ok(len(summary.get("gw_list", [])) == 38, "summary.gw_list 必须为 38 项"),
    ]
    for i, g in enumerate(summary.get("gw_list", []), start=1):
        if not isinstance(g, dict):
            probs.append(f"gw_list[{i}] 必须为对象")
            continue
        probs += [
            _ok(g.get("gw") == i, f"gw_list[{i}].gw 应为 {i}"),
            _ok(g.get("status") in STATUS_ENUM, f"gw{i} status 非法: {g.get('status')}"),
            _ok(g.get("manager") is None or isinstance(g["manager"], str),
                f"gw{i} manager 必须为字符串或 null"),
            _ok(g.get("score") is None or isinstance(g["score"], (int, float)),
                f"gw{i} score 类型非法"),
            _ok(g.get("total_points") is None or isinstance(g["total_points"], int),
                f"gw{i} total_points 类型非法"),
            _ok(g.get("overall_rank") is None or isinstance(g["overall_rank"], int),
                f"gw{i} overall_rank 类型非法"),
            _ok(isinstance(g.get("chips"), (list, type(None))), f"gw{i} chips 必须为数组或 null"),
            _ok(isinstance(g.get("transfers_count"), int), f"gw{i} transfers_count 必须为整数"),
            _ok(isinstance(g.get("transfers_cost"), (int, float)), f"gw{i} transfers_cost 类型非法"),
            _ok(isinstance(g.get("has_detail"), bool), f"gw{i} has_detail 必须为布尔"),
        ]
    return [c for c in probs if c]


def validate_gw_detail(gw: dict) -> list[str]:
    probs = [
        _ok(isinstance(gw.get("gw"), int), "gw.gw 必须为整数"),
        _ok(isinstance(gw.get("season"), str), "gw.season 必须为字符串"),
        _ok(gw.get("status") in STATUS_ENUM, f"gw{gw.get('gw')} status 非法"),
        _ok(isinstance(gw.get("summary"), dict), "gw.summary 必须为对象"),
    ]
    lineup = gw.get("lineup")
    if lineup is not None:
        starters, subs = lineup.get("starters") or [], lineup.get("subs") or []
        probs += [
            _ok(isinstance(lineup, dict), "gw.lineup 必须为对象或 null"),
            _ok(len(starters) == 11, f"gw{gw.get('gw')} 首发应为 11 人，实际 {len(starters)}"),
            _ok(len(subs) == 4, f"gw{gw.get('gw')} 替补应为 4 人，实际 {len(subs)}"),
        ]
        for slot, entries in (("starters", starters), ("subs", subs)):
            for j, e in enumerate(entries):
                if not isinstance(e, dict):
                    probs.append(f"gw{gw.get('gw')} {slot}[{j}] 必须为对象")
                    continue
                probs += [
                    _ok(isinstance(e.get("element"), int), f"gw{gw.get('gw')} {slot}[{j}] element 类型非法"),
                    _ok(e.get("position_type") in POSITION_ENUM, f"gw{gw.get('gw')} {slot}[{j}] position_type 非法"),
                    _ok(isinstance(e.get("is_captain"), bool), f"gw{gw.get('gw')} {slot}[{j}] is_captain 必须为布尔"),
                    _ok(isinstance(e.get("is_substitute"), bool), f"gw{gw.get('gw')} {slot}[{j}] is_substitute 必须为布尔"),
                ]
    transfers = gw.get("transfers")
    if transfers is not None:
        probs.append(_ok(isinstance(transfers, list), "gw.transfers 必须为数组或 null"))
        for j, t in enumerate(transfers if isinstance(transfers, list) else []):
            probs += [
                _ok(isinstance(t.get("element_in"), int), f"gw{gw.get('gw')} transfers[{j}] element_in 类型非法"),
                _ok(isinstance(t.get("element_out"), int), f"gw{gw.get('gw')} transfers[{j}] element_out 类型非法"),
                _ok(isinstance(t.get("cost"), (int, float)), f"gw{gw.get('gw')} transfers[{j}] cost 类型非法"),
            ]
    chips = gw.get("chips")
    if chips is not None:
        probs += [
            _ok(
                isinstance(chips, list) and all(c in CHIP_ENUM for c in chips),
                f"gw{gw.get('gw')} chips 存在非法值",
            )
        ]
    return [c for c in probs if c]


def validate_stats(stats: dict) -> list[str]:
    probs = [
        _ok(isinstance(stats.get("managers"), list) and stats["managers"],
            "stats.managers 不能为空"),
        _ok(isinstance(stats.get("season_totals"), dict), "stats.season_totals 必须为对象"),
    ]
    names: set[str] = set()
    for m in stats.get("managers", []):
        if not isinstance(m, dict):
            probs.append("stats.managers 元素必须为对象")
            continue
        name = m.get("name")
        probs += [
            _ok(isinstance(name, str) and name not in names, f"stats.managers 名字重复/非法: {name}"),
            _ok(isinstance(m.get("gw_count"), int), f"stats({name}) gw_count 必须为整数"),
            _ok(isinstance(m.get("completed"), bool), f"stats({name}) completed 必须为布尔"),
            _ok(isinstance(m.get("live"), bool), f"stats({name}) live 必须为布尔"),
            _ok(m.get("avg_rank") is None or isinstance(m["avg_rank"], (int, float)),
                f"stats({name}) avg_rank 类型非法"),
            _ok(m.get("rank_change") is None or isinstance(m["rank_change"], int),
                f"stats({name}) rank_change 类型非法"),
            _ok(isinstance(m.get("chips_used"), list), f"stats({name}) chips_used 必须为数组"),
        ]
        if isinstance(name, str):
            names.add(name)
    return [c for c in probs if c]


def validate_all(meta: dict, summary: dict, gw_details: dict[int, dict], stats: dict) -> None:
    probs = validate_meta(meta) + validate_summary(summary) + validate_stats(stats)
    for gw in gw_details.values():
        probs += validate_gw_detail(gw)
    if probs:
        raise ValidationError("\n".join(probs))
