from __future__ import annotations

import base64
import gzip
import json
import os
import re
import time
from datetime import date, datetime, timedelta
from typing import Any
from urllib import error, parse, request


class MoySkladConfigError(RuntimeError):
    """Проблема конфигурации интеграции МойСклад."""


_MS_DT_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?"
)


def _base_url() -> str:
    url = os.getenv(
        "MOYSKLAD_API_URL",
        "https://api.moysklad.ru/api/remap/1.2",
    ).strip().rstrip("/")
    if not url:
        raise MoySkladConfigError(
            "Не задан MOYSKLAD_API_URL (по умолчанию https://api.moysklad.ru/api/remap/1.2)"
        )
    return url


def _auth_header() -> str:
    token = os.getenv("MOYSKLAD_TOKEN", "").strip()
    if token:
        return f"Bearer {token}"
    login = os.getenv("MOYSKLAD_LOGIN", "").strip()
    password = os.getenv("MOYSKLAD_PASSWORD", "").strip()
    if login and password:
        raw = f"{login}:{password}".encode("utf-8")
        return f"Basic {base64.b64encode(raw).decode('ascii')}"
    raise MoySkladConfigError(
        "Задайте MOYSKLAD_TOKEN или пару MOYSKLAD_LOGIN + MOYSKLAD_PASSWORD "
        "(токен/логин — в МойСклад: Настройки → Токены / пользователи API)."
    )


def _http_timeout_sec() -> float:
    raw = os.getenv("MOYSKLAD_HTTP_TIMEOUT", "45").strip()
    try:
        v = float(raw.replace(",", "."))
    except ValueError:
        return 45.0
    return max(5.0, min(v, 120.0))


def _http_retries() -> int:
    raw = os.getenv("MOYSKLAD_HTTP_RETRIES", "2").strip()
    try:
        n = int(raw)
    except ValueError:
        return 2
    return max(0, min(n, 8))


def _ship_buffer_days() -> int:
    raw = os.getenv("MOYSKLAD_SHIP_BUFFER_DAYS", "120").strip()
    try:
        n = int(raw)
    except ValueError:
        return 120
    return max(0, min(n, 365))


def _parse_moysklad_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    m = _MS_DT_RE.match(s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hh = int(m.group(4) or 0)
    mm = int(m.group(5) or 0)
    ss = int(m.group(6) or 0)
    try:
        return datetime(y, mo, d, hh, mm, ss)
    except ValueError:
        return None


def _period_filter_value(d: date, *, end_of_day: bool) -> str:
    if end_of_day:
        return f"{d.isoformat()} 23:59:59"
    return f"{d.isoformat()} 00:00:00"


def _request_json(path: str, params: dict[str, Any] | None = None) -> Any:
    qs = f"?{parse.urlencode(params)}" if params else ""
    url = f"{_base_url()}/{path.lstrip('/')}{qs}"
    req = request.Request(
        url,
        headers={
            "Authorization": _auth_header(),
            "Accept": "application/json;charset=utf-8",
            "Accept-Encoding": "gzip",
            "User-Agent": "dashboard-kpi/1.0",
        },
        method="GET",
    )
    timeout = _http_timeout_sec()
    attempts = 1 + _http_retries()
    last_err: Exception | None = None
    for attempt in range(attempts):
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                body = raw.decode("utf-8", errors="replace")
                return json.loads(body) if body else {}
        except error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"МойСклад HTTP {e.code}: {err_body[:400]}") from e
        except (error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt + 1 < attempts:
                time.sleep(0.6 * (attempt + 1))
                continue
            raise RuntimeError(f"МойСклад: сеть или ответ API: {e!s}") from e
    raise RuntimeError(f"МойСклад: {last_err!s}" if last_err else "МойСклад: неизвестная ошибка")


def _paginate_entity(entity: str, *, params: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    offset = 0
    limit = 100
    while True:
        page_params = {**params, "limit": str(limit), "offset": str(offset)}
        data = _request_json(f"entity/{entity}", page_params)
        rows = data.get("rows") or []
        if not isinstance(rows, list):
            break
        out.extend(r for r in rows if isinstance(r, dict))
        size = int((data.get("meta") or {}).get("size") or 0)
        offset += limit
        if offset >= size or not rows:
            break
    return out


def _counterparty_name(entity: dict[str, Any] | None) -> str:
    if not isinstance(entity, dict):
        return ""
    return str(entity.get("name") or "").strip()


def _norm_counterparty_label(name: str) -> str:
    return name.strip().casefold().replace("ё", "е")


def is_marketplace_counterparty(name: str) -> bool:
    """
    Маркетплейсы: Ozon (ООО «ИНТЕРНЕТ РЕШЕНИЯ») и Wildberries / РВБ.
    """
    n = _norm_counterparty_label(name)
    if not n:
        return False
    if "озон" in n or "ozon" in n:
        return True
    if "интернет решения" in n:
        return True
    if "рвб" in n or "wildberries" in n:
        return True
    return False


def _store_name(entity: dict[str, Any] | None) -> str:
    if not isinstance(entity, dict):
        return ""
    return str(entity.get("name") or "").strip()


def _excluded_shipping_store_label() -> str:
    """Склад, отгрузки с которого не входят в среднее время отгрузки (по умолчанию «Магазин»)."""
    return os.getenv("MOYSKLAD_EXCLUDE_SHIPPING_STORE", "Магазин").strip()


def is_excluded_shipping_store(name: str) -> bool:
    """Отгрузка со склада розничного магазина — не участвует в статистике времени отгрузки."""
    label = _excluded_shipping_store_label()
    if not label:
        return False
    n = _norm_counterparty_label(name)
    return bool(n) and _norm_counterparty_label(label) in n


def _norm_comment(text: object) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold().replace("ё", "е")


def _excluded_order_comment_label() -> str:
    """Комментарий заказа, по которому он не входит в среднее время отгрузки (по умолчанию «отсрочка отгрузки»)."""
    return os.getenv("MOYSKLAD_EXCLUDE_ORDER_COMMENT", "отсрочка отгрузки").strip()


def is_excluded_order_comment(description: object) -> bool:
    """Заказ с комментарием об отсрочке отгрузки — не участвует в статистике времени отгрузки."""
    label = _excluded_order_comment_label()
    if not label:
        return False
    return _norm_comment(label) in _norm_comment(description)


def compute_avg_customer_shipping_days(
    period_from: date,
    period_to: date,
    *,
    include_marketplaces: bool = True,
) -> dict[str, object]:
    """
    Заказы покупателей (customerorder): среднее число календарных дней от created
    до первой проведённой отгрузки (demand.moment).

    Отгрузки читаем из entity/demand с expand=customerOrder — у customerorder
    нет рабочего подресурса /demands в API 1.2.
    """
    orders_filt = (
        f"created>={_period_filter_value(period_from, end_of_day=False)};"
        f"created<={_period_filter_value(period_to, end_of_day=True)}"
    )
    orders = _paginate_entity(
        "customerorder",
        params={"filter": orders_filt, "order": "created,asc", "expand": "agent"},
    )
    order_agents: dict[str, str] = {}
    excluded_comment_ids: set[str] = set()
    orders_in_period = 0
    for order in orders:
        oid = str(order.get("id") or "").strip()
        if not oid:
            continue
        agent_name = _counterparty_name(order.get("agent"))
        order_agents[oid] = agent_name
        if not include_marketplaces and is_marketplace_counterparty(agent_name):
            continue
        if is_excluded_order_comment(order.get("description")):
            excluded_comment_ids.add(oid)
            continue
        orders_in_period += 1

    demand_to = period_to + timedelta(days=_ship_buffer_days())
    demands_filt = (
        f"moment>={_period_filter_value(period_from, end_of_day=False)};"
        f"moment<={_period_filter_value(demand_to, end_of_day=True)}"
    )
    demands = _paginate_entity(
        "demand",
        params={
            "filter": demands_filt,
            "expand": "customerOrder,agent,store",
            "order": "moment,asc",
        },
    )

    first_shipment: dict[str, datetime] = {}
    order_meta: dict[str, dict[str, Any]] = {}
    agent_by_order: dict[str, str] = {}
    store_by_order: dict[str, str] = {}

    for dem in demands:
        if dem.get("applicable") is False:
            continue
        co = dem.get("customerOrder")
        if not isinstance(co, dict):
            continue
        created = _parse_moysklad_datetime(co.get("created"))
        if created is None:
            continue
        created_day = created.date()
        if created_day < period_from or created_day > period_to:
            continue
        oid = str(co.get("id") or "").strip()
        shipped_at = _parse_moysklad_datetime(dem.get("moment"))
        if not oid or shipped_at is None:
            continue
        order_meta.setdefault(oid, co)
        agent_by_order.setdefault(oid, _counterparty_name(dem.get("agent")))
        prev = first_shipment.get(oid)
        if prev is None or shipped_at < prev:
            first_shipment[oid] = shipped_at
            store_by_order[oid] = _store_name(dem.get("store"))

    shipping_days: list[int] = []
    samples: list[dict[str, object]] = []
    store_excluded = 0

    for oid, shipped_at in first_shipment.items():
        co = order_meta.get(oid) or {}
        agent_name = agent_by_order.get(oid, _counterparty_name(co.get("agent")))
        if not include_marketplaces and is_marketplace_counterparty(agent_name):
            continue
        if oid in excluded_comment_ids:
            continue
        store_name = store_by_order.get(oid, "")
        if is_excluded_shipping_store(store_name):
            store_excluded += 1
            continue
        created = _parse_moysklad_datetime(co.get("created"))
        if created is None:
            continue
        days = (shipped_at.date() - created.date()).days
        if days < 0:
            continue
        shipping_days.append(days)
        if len(samples) < 12:
            samples.append(
                {
                    "name": str(co.get("name") or "").strip(),
                    "agent": agent_by_order.get(oid, _counterparty_name(co.get("agent"))),
                    "store": store_name,
                    "created": created.isoformat(sep=" ", timespec="seconds"),
                    "shipped_at": shipped_at.isoformat(sep=" ", timespec="seconds"),
                    "days": days,
                }
            )

    samples.sort(key=lambda x: int(x["days"]), reverse=True)

    avg_days: float | None = None
    if shipping_days:
        avg_days = round(sum(shipping_days) / len(shipping_days), 1)

    orders_shipped = len(shipping_days)
    # Заказы, отгруженные со склада магазина, исключаем и из знаменателя «X из Y».
    orders_in_period = max(0, orders_in_period - store_excluded)
    return {
        "avg_days": avg_days,
        "orders_shipped": orders_shipped,
        "orders_in_period": orders_in_period,
        "orders_pending": orders_in_period - orders_shipped,
        "store_excluded": store_excluded,
        "comment_excluded": len(excluded_comment_ids),
        "period_from": period_from.isoformat(),
        "period_to": period_to.isoformat(),
        "source": "moysklad",
        "include_marketplaces": include_marketplaces,
        "samples": samples,
    }


__all__ = [
    "MoySkladConfigError",
    "compute_avg_customer_shipping_days",
    "is_marketplace_counterparty",
]
