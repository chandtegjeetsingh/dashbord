from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib import error, parse, request


class YougileConfigError(RuntimeError):
    """Проблема конфигурации интеграции YouGile."""


def _base_url() -> str:
    raw_url = os.getenv("YOUGILE_API_URL", "").strip().rstrip("/")
    url = raw_url
    if not url:
        raise YougileConfigError(
            "Не задан YOUGILE_API_URL (например: https://<ваш-домен>.yougile.com/api-v2)"
        )
    # Пользователи часто вставляют URL из раздела ключей:
    # .../api-v2/auth/keys. Для API нам нужен базовый .../api-v2.
    if "/api-v2" in url:
        url = url[: url.index("/api-v2") + len("/api-v2")]
    elif "/auth/keys" in url:
        url = url[: url.index("/auth/keys")]
        url = f"{url}/api-v2"
    return url


def _api_key() -> str:
    key = os.getenv("YOUGILE_API_KEY", "").strip()
    if not key:
        raise YougileConfigError("Не задан YOUGILE_API_KEY")
    return key


def _request_json(path: str, params: dict[str, Any] | None = None) -> Any:
    qs = f"?{parse.urlencode(params)}" if params else ""
    req = request.Request(
        f"{_base_url()}/{path.lstrip('/')}{qs}",
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", errors="replace")
            return json.loads(body) if body else {}
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"YouGile HTTP {e.code}: {body[:300]}") from e
    except error.URLError as e:
        raise RuntimeError(f"Ошибка сети YouGile: {e.reason}") from e


@dataclass
class YougileTask:
    id: str
    title: str
    status: str
    url: str | None = None
    deadline_at: str | None = None
    priority: str = "normal"


def _extract_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        if isinstance(payload.get("content"), list):
            return [x for x in payload["content"] if isinstance(x, dict)]
        if isinstance(payload.get("items"), list):
            return [x for x in payload["items"] if isinstance(x, dict)]
        if isinstance(payload.get("data"), list):
            return [x for x in payload["data"] if isinstance(x, dict)]
    return []


def _norm_text(v: Any) -> str:
    return str(v or "").strip()


def _norm_name(v: Any) -> str:
    return _norm_text(v).casefold().replace("ё", "е")


def _find_user_id_by_name(employee_name: str) -> str | None:
    users = _extract_items(_request_json("users"))
    target = _norm_name(employee_name)
    # Только точное совпадение, чтобы не подмешивать чужие задачи.
    for u in users:
        for key in ("name", "fullName", "realName", "email"):
            full_name = _norm_name(u.get(key))
            if full_name == target:
                return _norm_text(u.get("id"))
    return None


def _fetch_all_tasks() -> list[dict[str, Any]]:
    # YouGile v2 отдает paging/content, забираем все страницы.
    offset = 0
    limit = 100
    out: list[dict[str, Any]] = []
    while True:
        payload = _request_json("tasks", params={"limit": limit, "offset": offset})
        items = _extract_items(payload)
        out.extend(items)
        if not isinstance(payload, dict):
            break
        paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
        if not paging.get("next"):
            break
        got_limit = int(paging.get("limit") or limit)
        offset = int(paging.get("offset") or offset) + got_limit
    return out


def _is_task_active(task: dict[str, Any]) -> bool:
    if bool(task.get("archived")):
        return False
    if bool(task.get("completed")):
        return False
    if task.get("completedTimestamp") is not None:
        return False
    if task.get("deleted") is not None:
        return False
    return True


def _task_url(task: dict[str, Any]) -> str | None:
    direct = _norm_text(task.get("url"))
    if direct:
        return direct
    host = _base_url().split("/api-v2")[0]
    project_id = _norm_text(task.get("idTaskProject"))
    if project_id:
        return f"{host}/#/task/{project_id}"
    common_id = _norm_text(task.get("idTaskCommon"))
    if common_id:
        return f"{host}/#/task/{common_id}"
    task_id = _norm_text(task.get("id"))
    if task_id:
        return f"{host}/#/task/{task_id}"
    return None


def _task_status(task: dict[str, Any]) -> str:
    if task.get("completed") is True:
        return "Завершена"
    if task.get("completed") is False:
        return "В работе"
    for key in ("status", "state", "workflowState", "columnName"):
        val = task.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            name = _norm_text(val.get("name"))
            if name:
                return name
    return "Без статуса"


def _task_deadline_at(task: dict[str, Any]) -> str | None:
    deadline_raw: Any = None
    dl = task.get("deadline")
    if isinstance(dl, dict):
        deadline_raw = dl.get("deadline")
    elif isinstance(dl, (int, float)):
        deadline_raw = dl
    if not isinstance(deadline_raw, (int, float)):
        return None
    try:
        dt = datetime.fromtimestamp(float(deadline_raw) / 1000.0, tz=timezone.utc)
        return dt.isoformat()
    except Exception:
        return None


def _task_priority(task: dict[str, Any]) -> str:
    # Поддержка разных вариантов API.
    raw = task.get("priority")
    if isinstance(raw, str):
        p = raw.strip().lower()
        if p in {"high", "urgent", "critical", "medium", "low", "normal"}:
            return p
    if isinstance(raw, (int, float)):
        if raw >= 3:
            return "high"
        if raw <= 1:
            return "low"
    # Если есть дедлайн и он скоро, считаем высокой важностью.
    deadline_at = _task_deadline_at(task)
    if deadline_at:
        return "high"
    return "normal"


def _task_title(task: dict[str, Any]) -> str:
    for key in ("title", "name", "summary"):
        val = _norm_text(task.get(key))
        if val:
            return val
    return "Без названия"


def _task_assignee_ids(task: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for key in ("assigned", "assignedUserIds", "assigneeIds", "responsibleIds", "memberIds"):
        raw = task.get(key)
        if isinstance(raw, list):
            ids.update(_norm_text(x) for x in raw if _norm_text(x))
    for key in ("assignedTo", "responsible", "assignee"):
        raw = task.get(key)
        if isinstance(raw, dict):
            rid = _norm_text(raw.get("id"))
            if rid:
                ids.add(rid)
    return ids


def get_employee_tasks(
    employee_name: str,
    limit: int = 8,
    employee_id: str | None = None,
) -> list[YougileTask]:
    user_id = _norm_text(employee_id) or _find_user_id_by_name(employee_name)
    if not user_id:
        return []

    tasks_raw = _fetch_all_tasks()
    tasks: list[YougileTask] = []
    for t in tasks_raw:
        if user_id not in _task_assignee_ids(t):
            continue
        if not _is_task_active(t):
            continue
        tid = _norm_text(t.get("id"))
        tasks.append(
            YougileTask(
                id=tid or _task_title(t),
                title=_task_title(t),
                status=_task_status(t),
                url=_task_url(t),
                deadline_at=_task_deadline_at(t),
                priority=_task_priority(t),
            )
        )
        if len(tasks) >= max(1, limit):
            break
    return tasks
