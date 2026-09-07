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


def compute_scores(
    managers_stats: list[dict], gw_list: list[dict], rules: dict
) -> tuple[list[dict], bool]:
    """赛事积分计算（decide.md §2）。

    积分 = ① 平均OR排名 + ② 单周OR + ③ 转会奖励 + ④ Hit处罚 + ⑤ Chip处罚。
    ②④⑤ 逐轮实时累计；①③ 需 9 名经理全部 sealed 后结算；分数统一保留一位小数。
    返回 (追加 score/rank/points/score_details 等字段后的 managers, season_settled)。
    """
    by_gw = {g["gw"]: g for g in gw_list}
    penalizable = {"free_hit", "bench_boost", "triple_captain"}
    large_bgw = set(rules.get("large_bgw_gws") or [])
    tiers = rules["weekly_or_tiers"]
    avg_points = rules["avg_or_points"]
    transfer_pool = rules["transfer_pool"]
    chip_unit = rules["chip_penalty"]
    hit_per_4 = rules["hit_penalty_per_4"]

    def tier(rank):
        """单周 OR 分档：取最高档，rank 为 null 计 0。"""
        if rank is None:
            return 0
        for t in tiers:
            if rank <= t["max_rank"]:
                return t["points"]
        return 0

    # 第一步：逐经理计算可独立确定项
    computed: list[dict] = []
    for m in managers_stats:
        s, e = m["start_gw"], m["end_gw"]
        rows = [by_gw[g] for g in range(s, e + 1) if g in by_gw]
        sealed = [r for r in rows if r["status"] == "sealed"]

        weekly = sum(tier(r.get("overall_rank")) for r in sealed)

        # Hit：transfers_cost 为扣分（FPL 原生为负），用绝对值判断/计算，兼容正负约定
        hit_cost = sum(r.get("transfers_cost") or 0 for r in rows)
        hit_abs = abs(hit_cost)
        hit_penalty = round(-hit_abs / 4 * hit_per_4, 1) if hit_abs else 0

        used_chips = [c for r in rows for c in (r.get("chips") or []) if c in penalizable]
        chip_penalty = round(-chip_unit * len(used_chips), 1) if used_chips else 0

        hit_used = hit_abs > 0
        transfer_count = sum(r.get("transfers_count") or 0 for r in rows)

        ranks = [r["overall_rank"] for r in sealed if r.get("overall_rank") is not None]
        avg_or = round(sum(ranks) / len(ranks), 1) if ranks else None

        used_wildcard = any("wildcard" in (r.get("chips") or []) for r in rows)
        unauthorized = any(
            c in penalizable and r["gw"] not in large_bgw
            for r in rows for c in (r.get("chips") or [])
        )
        disqualified = used_wildcard or unauthorized
        reason = "wildcard" if used_wildcard else ("unauthorized_chip" if unauthorized else None)

        computed.append({
            "settled": bool(rows) and all(r["status"] == "sealed" for r in rows),
            "weekly": weekly,
            "hit_cost": hit_cost,
            "hit_penalty": hit_penalty,
            "used_chips": used_chips,
            "chip_penalty": chip_penalty,
            "hit_used": hit_used,
            "transfer_count": transfer_count,
            "avg_or": avg_or,
            "disqualified": disqualified,
            "reason": reason,
            "avg_or_award": None,
            "avg_or_position": None,
            "transfer_award": None,
        })

    season_settled = bool(computed) and all(c["settled"] for c in computed)

    # 第二步：赛季结算项（①③）
    if season_settled:
        ranked = [c for c in computed if c["avg_or"] is not None]
        ranked.sort(key=lambda c: c["avg_or"])
        for i, c in enumerate(ranked):
            c["avg_or_award"] = avg_points[i] if i < len(avg_points) else 0
            c["avg_or_position"] = i + 1
        for c in computed:
            if c["avg_or"] is None:
                c["avg_or_award"] = 0
                c["avg_or_position"] = None

        for c in computed:
            c["transfer_award"] = 0
        eligible = [c for c in computed if not c["hit_used"] and not c["disqualified"]]
        if eligible:
            min_count = min(c["transfer_count"] for c in eligible)
            winners = [c for c in eligible if c["transfer_count"] == min_count]
            award = round(transfer_pool / len(winners), 1)
            for c in winners:
                c["transfer_award"] = award

    # 第三步：组装输出（总分、明细）
    out: list[dict] = []
    for i, c in enumerate(computed):
        avg_award = c["avg_or_award"] if season_settled else None
        transfer_award = c["transfer_award"] if season_settled else None
        parts = [c["weekly"], c["hit_penalty"], c["chip_penalty"]]
        if season_settled:
            parts += [avg_award or 0, transfer_award or 0]
        score = round(sum(parts), 1)

        points = {
            "avg_or_award": avg_award,
            "avg_or_position": c["avg_or_position"],
            "weekly_or_award": c["weekly"],
            "transfer_award": transfer_award,
            "transfer_eligible": (not c["hit_used"]) and (not c["disqualified"]),
            "transfer_count": c["transfer_count"],
            "hit_penalty": c["hit_penalty"],
            "hit_cost": c["hit_cost"],
            "chip_penalty": c["chip_penalty"],
            "chips_penalized": c["used_chips"],
        }

        details: list[dict] = []
        if season_settled:
            details.append({"label": "平均 OR 排名奖励", "value": avg_award, "kind": "reward"})
        else:
            details.append({"label": "平均 OR 排名奖励", "value": "待结算", "kind": "pending"})
        details.append({"label": "单周 OR 奖励", "value": c["weekly"], "kind": "reward"})
        if season_settled:
            details.append({"label": "赛季末转会奖励", "value": transfer_award, "kind": "reward"})
        else:
            details.append({"label": "赛季末转会奖励", "value": "待结算", "kind": "pending"})
        if c["hit_penalty"] != 0:
            details.append({"label": "Hit 处罚", "value": c["hit_penalty"], "kind": "penalty"})
        if c["chip_penalty"] != 0:
            details.append({"label": "Chip 处罚", "value": c["chip_penalty"], "kind": "penalty"})

        merged = dict(managers_stats[i])
        merged.update({
            "score": score,
            "settled": c["settled"],
            "disqualified": c["disqualified"],
            "disqualify_reason": c["reason"],
            "points": points,
            "score_details": details,
        })
        out.append(merged)

    # 第四步：排名（score 降序，取消资格置后且无名次，同分并列）
    ordered = sorted(out, key=lambda x: (1 if x["disqualified"] else 0, -(x["score"] or 0)))
    active = [x for x in ordered if not x["disqualified"]]
    pos, prev = 0, None
    for i, x in enumerate(active):
        if x["score"] != prev:
            pos = i + 1
            prev = x["score"]
        x["rank"] = pos
    for x in ordered:
        if x["disqualified"]:
            x["rank"] = None

    return out, season_settled
