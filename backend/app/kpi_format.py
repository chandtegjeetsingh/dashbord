from __future__ import annotations

from typing import Any

from app.models import DailySnapshot


def snapshot_to_payload(row: DailySnapshot | None) -> dict[str, Any]:
    if row is None:
        return {
            "message": "no_snapshot",
            "shipments_sum": None,
            "cost_shipped_sum": None,
            "expense_orders_sum": None,
            "purchase_payments_sum": None,
            "purchases_sum": None,
            "raw_material_stock_sum": None,
            "as_of": None,
            "snapshot_date": None,
            "period_from": None,
            "period_to": None,
            "sync_error": None,
        }
    as_of = row.created_at.isoformat() if row.created_at else None
    return {
        "message": None,
        "shipments_sum": round(row.shipments_sum_rub, 2),
        "cost_shipped_sum": round(row.cost_sum_rub, 2),
        "expense_orders_sum": round(row.expense_orders_sum_rub, 2),
        "purchase_payments_sum": round(row.purchase_payments_sum_rub, 2),
        "purchases_sum": round(row.purchases_sum_rub, 2),
        "raw_material_stock_sum": round(row.raw_material_stock_sum_rub, 2),
        "as_of": as_of,
        "snapshot_date": row.snapshot_date.isoformat(),
        "period_from": row.period_from.isoformat(),
        "period_to": row.period_to.isoformat(),
        "sync_error": row.sync_error,
    }


def snapshot_history_row(row: DailySnapshot) -> dict[str, Any]:
    return {
        "date": row.snapshot_date.isoformat(),
        "shipments_sum": round(row.shipments_sum_rub, 2),
        "cost_shipped_sum": round(row.cost_sum_rub, 2),
        "expense_orders_sum": round(row.expense_orders_sum_rub, 2),
        "purchase_payments_sum": round(row.purchase_payments_sum_rub, 2),
        "purchases_sum": round(row.purchases_sum_rub, 2),
        "raw_material_stock_sum": round(row.raw_material_stock_sum_rub, 2),
    }
