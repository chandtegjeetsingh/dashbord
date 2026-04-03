from __future__ import annotations

import logging
import os
from datetime import date, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.google_sheets_client import (
    _parse_money,
    _parse_sheet_date,
    fetch_sheet_rows,
    tq_datetime_range,
)
from app.models import DailySnapshot, PeriodDayMetric
from app.period_util import today_in_app_tz

logger = logging.getLogger(__name__)


def _in_period(d: date, p_from: date, p_to: date) -> bool:
    return p_from <= d <= p_to


def _parse_profit_sheet(
    rows: list[dict[str, Any]],
) -> tuple[dict[date, float], dict[date, float]]:
    """
    Лист `прибыльность`, колонки:
    A (0) — Дата
    B (1) — Сумма продаж
    F (5) — Себестоимость
    """
    sales_by_day: dict[date, float] = {}
    cost_by_day: dict[date, float] = {}

    for r in rows:
        # Колонки в вашем листе “прибыльность”:
        # A — Дата, B — Сумма продаж, F — Себестоимость.
        d = _parse_sheet_date(str(r.get("A") or ""))
        if d is None:
            continue
        sales = _parse_money(r.get("B"))
        cost = _parse_money(r.get("F"))
        sales_by_day[d] = sales_by_day.get(d, 0.0) + sales
        cost_by_day[d] = cost_by_day.get(d, 0.0) + cost

    return sales_by_day, cost_by_day


def _parse_purchase_sheet(
    rows: list[dict[str, Any]],
    *,
    p_from: date,
    p_to: date,
) -> tuple[dict[date, float], dict[date, float]]:
    """
    Лист `Закупка_товары`, колонки:
    C (2) — Дата
    E (4) — Сумма

    Для KPI «Закупки (итого)» учитываем каждую строку в диапазоне.
    Складываем в paymentout_by_day, чтобы сохранить текущую схему БД/API.
    """
    expense_by_day: dict[date, float] = {}
    paymentout_by_day: dict[date, float] = {}

    for r in rows:
        # Колонки в вашем листе “Закупка_товары”: C — Дата, E — Сумма.
        d = _parse_sheet_date(str(r.get("C") or ""))
        if d is None or not _in_period(d, p_from, p_to):
            continue

        amount = _parse_money(r.get("E"))
        if amount == 0.0:
            continue

        paymentout_by_day[d] = paymentout_by_day.get(d, 0.0) + amount

    return expense_by_day, paymentout_by_day


def _parse_raw_material_stock_sheet(
    rows: list[dict[str, Any]],
    *,
    p_from: date,
    p_to: date,
) -> tuple[float, dict[date, float]]:
    """
    Таблица остатков сырья, колонки:
    A (0) — Дата
    B (1) — Остаток

    Берём последнее значение остатка в выбранном диапазоне.
    """
    by_day: dict[date, float] = {}
    latest_date: date | None = None
    latest_value = 0.0
    for r in rows:
        d = _parse_sheet_date(str(r.get("A") or ""))
        if d is None or not _in_period(d, p_from, p_to):
            continue
        value = _parse_money(r.get("B"))
        by_day[d] = value
        if latest_date is None or d >= latest_date:
            latest_date = d
            latest_value = value
    return latest_value, by_day


def run_sync_from_sheets(db: Session, period_from: date, period_to: date) -> DailySnapshot:
    tz_today = today_in_app_tz()

    sheet_id = os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID", "").strip()
    profit_sheet_name = os.getenv("GOOGLE_SHEETS_PROFIT_SHEET_NAME", "прибыльность").strip()
    purchase_sheet_name = os.getenv("GOOGLE_SHEETS_PURCHASE_SHEET_NAME", "Закупка_товары").strip()
    raw_material_stock_sheet_id = os.getenv(
        "GOOGLE_SHEETS_RAW_MATERIAL_STOCK_SPREADSHEET_ID",
        "1bFU6x-4qm39wEM356ghETOdeozqTR2RdPRTIJWyAONE",
    ).strip()
    raw_material_stock_sheet_name = os.getenv(
        "GOOGLE_SHEETS_RAW_MATERIAL_STOCK_SHEET_NAME",
        "Остатки_I_Производство",
    ).strip()

    # Profit: только нужные колонки (A,B,F). Фильтруем по периоду в Python.
    profit_rows = fetch_sheet_rows(
        spreadsheet_id=sheet_id,
        sheet_name=profit_sheet_name,
        tq="select A, B, F",
    )

    # Purchase: берём C,E без where и фильтруем период в Python.
    # Для этого листа C содержит дату документа.
    purchase_rows = fetch_sheet_rows(
        spreadsheet_id=sheet_id,
        sheet_name=purchase_sheet_name,
        tq="select C, E",
    )
    raw_material_stock_rows: list[dict[str, Any]] = []
    stock_sheet_candidates = [
        raw_material_stock_sheet_name,
        "Лист1",
        "Sheet1",
    ]
    seen_names: set[str] = set()
    for candidate in stock_sheet_candidates:
        name = candidate.strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        try:
            rows = fetch_sheet_rows(
                spreadsheet_id=raw_material_stock_sheet_id,
                sheet_name=name,
                tq="select A, B",
            )
        except Exception:
            continue
        if rows:
            raw_material_stock_rows = rows
            break

    sales_by_day_raw, cost_by_day_raw = _parse_profit_sheet(profit_rows)

    # Фильтруем по периоду.
    sales_by_day: dict[date, float] = {
        d: v for d, v in sales_by_day_raw.items() if _in_period(d, period_from, period_to)
    }
    cost_by_day: dict[date, float] = {
        d: v for d, v in cost_by_day_raw.items() if _in_period(d, period_from, period_to)
    }

    expense_orders_by_day, paymentout_by_day = _parse_purchase_sheet(
        purchase_rows,
        p_from=period_from,
        p_to=period_to,
    )

    # Итого.
    shipments_total = sum(sales_by_day.values())
    cost_total = sum(cost_by_day.values())

    total_expense_orders = sum(expense_orders_by_day.values())
    total_paymentout = sum(paymentout_by_day.values())
    purchases_total = total_expense_orders + total_paymentout
    raw_material_stock_total, raw_material_stock_by_day = _parse_raw_material_stock_sheet(
        raw_material_stock_rows,
        p_from=period_from,
        p_to=period_to,
    )

    # Пересохраняем дневные метрики за период.
    db.execute(
        delete(PeriodDayMetric).where(
            PeriodDayMetric.period_from == period_from,
            PeriodDayMetric.period_to == period_to,
        ),
    )

    d = period_from
    current_raw_stock = 0.0
    while d <= period_to:
        if d in raw_material_stock_by_day:
            current_raw_stock = raw_material_stock_by_day[d]
        db.add(
            PeriodDayMetric(
                period_from=period_from,
                period_to=period_to,
                bucket_date=d,
                profit_sales_rub=sales_by_day.get(d, 0.0),
                cost_shipped_rub=cost_by_day.get(d, 0.0),
                expense_orders_rub=expense_orders_by_day.get(d, 0.0),
                paymentout_purchase_rub=paymentout_by_day.get(d, 0.0),
                raw_material_stock_rub=current_raw_stock,
            ),
        )
        d += timedelta(days=1)

    existing = db.scalar(
        select(DailySnapshot).where(
            DailySnapshot.snapshot_date == tz_today,
            DailySnapshot.period_from == period_from,
            DailySnapshot.period_to == period_to,
        ),
    )

    if existing:
        existing.shipments_sum_rub = shipments_total
        existing.cost_sum_rub = cost_total
        existing.expense_orders_sum_rub = total_expense_orders
        existing.purchase_payments_sum_rub = total_paymentout
        existing.purchases_sum_rub = purchases_total
        existing.raw_material_stock_sum_rub = raw_material_stock_total
        existing.sync_error = None
        db.commit()
        db.refresh(existing)
        return existing

    snap = DailySnapshot(
        snapshot_date=tz_today,
        period_from=period_from,
        period_to=period_to,
        shipments_sum_rub=shipments_total,
        cost_sum_rub=cost_total,
        expense_orders_sum_rub=total_expense_orders,
        purchase_payments_sum_rub=total_paymentout,
        purchases_sum_rub=purchases_total,
        raw_material_stock_sum_rub=raw_material_stock_total,
        sync_error=None,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap


__all__ = ["run_sync_from_sheets"]

