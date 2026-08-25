"""玩家接龙统计计算。design.md §11。

完全由 summary 的 gw_list 派生，每次运行重算，不单独采集。
"""
from __future__ import annotations

ACTIVE_STATUS = ("live", "finished", "sealed")


def _mean(values: list[float | int]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def compute_manager_stats(managers: list[dict], gw_list: list[dict]) -> list[dict]:
    by_gw = {g["gw"]: g for g in gw_list}
    out: list[dict] = []
    for m in managers:
        rows = [by_gw[g] for g in range(m["start_gw"], m["end_gw"] + 1) if g in by_gw]
        scores = [r["score"] for r in rows if r.get("score") is not None]
        ranks = [r["overall_rank"] for r in rows if r.get("overall_rank") is not None]
        stats = {
            "name": m["name"],
            "start_gw": m["start_gw"],
            "end_gw": m["end_gw"],
            "gw_count": len(rows),
            "completed": bool(rows) and all(r["status"] == "sealed" for r in rows),
            "live": any(r["status"] in ("live", "finished") for r in rows),
            "avg_rank": _mean(ranks),
            "best_rank": min(ranks) if ranks else None,
            "avg_score": _mean(scores),
            "best_score": max(scores) if scores else None,
            "worst_score": min(scores) if scores else None,
            "total_score": sum(scores) if scores else None,
            "rank_change": None,
            "chips_used": sorted({c for r in rows for c in (r.get("chips") or [])}),
            "total_transfers": sum(r.get("transfers_count") or 0 for r in rows),
            "total_transfers_cost": round(
                sum(r.get("transfers_cost") or 0 for r in rows), 1
            ),
        }
        if rows and m["start_gw"] > 1:
            prev = by_gw.get(m["start_gw"] - 1)
            current_rank = rows[-1].get("overall_rank")
            if prev and prev.get("overall_rank") is not None and current_rank is not None:
                # 负值 = 排名上升（design.md §11.2）
                stats["rank_change"] = current_rank - prev["overall_rank"]
        out.append(stats)
    return out


def compute_season_totals(gw_list: list[dict]) -> dict:
    active = [g for g in gw_list if g.get("status") in ACTIVE_STATUS]
    ranks = [g["overall_rank"] for g in active if g.get("overall_rank") is not None]
    totals = [g["total_points"] for g in active if g.get("total_points") is not None]
    return {
        "total_points": totals[-1] if totals else None,
        "best_rank": min(ranks) if ranks else None,
        "current_rank": ranks[-1] if ranks else None,
        "gw_played": len(active),
        "total_transfers": sum(g.get("transfers_count") or 0 for g in active),
        "total_transfers_cost": round(
            sum(g.get("transfers_cost") or 0 for g in active), 1
        ),
    }
