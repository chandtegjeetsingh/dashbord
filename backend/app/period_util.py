"""Вспомогательные функции периода для KPI (TZ приложения)."""

from __future__ import annotations

import calendar
import os
from datetime import date, datetime
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
    """По умолчанию: текущий календарный месяц целиком (в TZ приложения)."""
    now = datetime.now(_tz())
    y, m = now.year, now.month
    start_d = date(y, m, 1)
    last = calendar.monthrange(y, m)[1]
    end_d = date(y, m, last)
    return start_d, end_d


def today_in_app_tz() -> date:
    return datetime.now(_tz()).date()

