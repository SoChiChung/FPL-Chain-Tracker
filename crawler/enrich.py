"""bootstrap-static → 球员/球队映射与阵容丰富。design.md §5.2/§5.5。

快照原则：球员名称/球队/位置在采集当日由 bootstrap 映射写入并固化，
历史 GW 文件写入后不再用最新 bootstrap 重算。
"""
from __future__ import annotations

POSITION_BY_ELEMENT_TYPE = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def build_maps(bootstrap: dict) -> tuple[dict[int, dict], dict[int, str]]:
    teams = {t["id"]: t.get("short_name") for t in bootstrap.get("teams") or []}
    players: dict[int, dict] = {}
    for el in bootstrap.get("elements") or []:
        pid = el.get("id")
        name = (
            el.get("web_name")
            or " ".join(filter(None, [el.get("first_name"), el.get("second_name")]))
            or f"player-{pid}"
        )
        players[pid] = {
            "name": name,
            "team": teams.get(el.get("team")),
            "position_type": POSITION_BY_ELEMENT_TYPE.get(el.get("element_type")),
        }
    return players, teams


def enrich_pick(pick: dict, players: dict[int, dict]) -> dict:
    player = players.get(pick.get("element"), {})
    position = pick.get("position", 99)
    return {
        "element": pick.get("element"),
        "name": player.get("name"),
        "team": player.get("team"),
        "position_type": player.get("position_type"),
        "is_captain": bool(pick.get("is_captain")),
        "is_vice_captain": bool(pick.get("is_vice_captain")),
        "multiplier": pick.get("multiplier"),
        "is_substitute": position > 11,
    }
