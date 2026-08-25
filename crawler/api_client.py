"""FPL 官方公开 API 客户端。design.md §5。

行为：必须携带自定义 User-Agent；请求间隔限速；超时重试（5s/10s/20s 退避）；
429 按 Retry-After 等待；403/404 等客户端错误直接失败。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

BASE_URL = "https://fantasy.premierleague.com/api"


class ApiError(Exception):
    pass


class ApiClient:
    def __init__(
        self,
        user_agent: str,
        delay: float = 0.4,
        timeout: int = 10,
        max_retries: int = 3,
    ):
        self.user_agent = user_agent
        self.delay = delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.requests = 0

    def _get(self, path: str):  # noqa: ANN201 — 响应可能是 dict（多数接口）或 list（空 transfers）
        req = urllib.request.Request(
            f"{BASE_URL}/{path}",
            headers={"User-Agent": self.user_agent, "Accept": "application/json"},
        )
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            time.sleep(self.delay)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    self.requests += 1
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    wait = self._retry_after_seconds(exc)
                    print(f"[api] 429 on {path}; wait {wait:.0f}s")
                    time.sleep(wait)
                    last_error = ApiError(f"HTTP 429 {path}（触发限流）")
                    continue
                if exc.code >= 500:
                    backoff = 5 * (attempt + 1)
                    print(f"[api] HTTP {exc.code} on {path}; retry in {backoff}s")
                    time.sleep(backoff)
                    last_error = ApiError(f"HTTP {exc.code} {path}")
                    continue
                raise ApiError(f"HTTP {exc.code} {path}") from exc
            except urllib.error.URLError as exc:
                backoff = 5 * (attempt + 1)
                print(f"[api] network error on {path} ({exc.reason}); retry in {backoff}s")
                time.sleep(backoff)
                last_error = ApiError(f"network error {path}: {exc.reason}")
            except json.JSONDecodeError as exc:
                last_error = ApiError(f"invalid JSON from {path}: {exc}")
                time.sleep(5 * (attempt + 1))
        assert last_error is not None
        raise last_error

    @staticmethod
    def _retry_after_seconds(exc: urllib.error.HTTPError) -> float:
        raw = exc.headers.get("Retry-After") if exc.headers else None
        if raw:
            try:
                return float(raw)
            except ValueError:
                pass
            try:
                return max(0.0, (parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError):
                pass
        return 60.0

    def bootstrap_static(self) -> dict:
        return self._get("bootstrap-static/")

    def entry(self, team_id: int) -> dict:
        return self._get(f"entry/{team_id}/")

    def history(self, team_id: int) -> dict:
        return self._get(f"entry/{team_id}/history/")

    def transfers(self, team_id: int) -> dict:
        return self._get(f"entry/{team_id}/transfers/")

    def picks(self, team_id: int, gw: int) -> dict:
        return self._get(f"entry/{team_id}/event/{gw}/picks/")
