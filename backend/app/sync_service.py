"""Синхронизация агрегатов с Google Sheets за выбранный период (от — до)."""

from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from app.models import DailySnapshot


def run_sync(db: Session, period_from: date, period_to: date) -> DailySnapshot:
    """
    Заполняет `DailySnapshot` и `PeriodDayMetric` данными из Google Sheets.

    Логика маппинга:
    - лист `прибыльность`: A=Дата, B=Сумма продаж, C=Себестоимость
    - лист `Закупка_товары`: A=Дата, E=Сумма
      закупки = сумма по колонке E за выбранный период
    """
    from app.sheets_sync_service import run_sync_from_sheets

    return run_sync_from_sheets(db, period_from, period_to)

