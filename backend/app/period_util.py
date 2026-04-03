"""Вспомогательные функции периода для KPI (TZ приложения)."""

from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


# Календарь дашборда и «дни» на графике (по умолчанию UTC+8).
_DEFAULT_APP_TZ = "Asia/Shanghai"


def _tz() -> ZoneInfo:
    tz_name = (os.environ.get("TZ") or _DEFAULT_APP_TZ).strip()
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo(_DEFAULT_APP_TZ)


def default_period_dates() -> tuple[date, date]:
    """По умолчанию: последние 30 календарных дней (включая сегодня, в TZ приложения)."""
    now = datetime.now(_tz())
    end_d = now.date()
    start_d = end_d - timedelta(days=29)
    return start_d, end_d


def today_in_app_tz() -> date:
    return datetime.now(_tz()).date()

