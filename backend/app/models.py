from datetime import date, datetime
from typing import Optional

from sqlalchemy import Date, DateTime, Float, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class DailySnapshot(Base):
    """Снимок агрегатов за выбранный период (дата снимка = день синхронизации)."""

    __tablename__ = "daily_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_date",
            "period_from",
            "period_to",
            name="uq_snap_period",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    period_from: Mapped[date] = mapped_column(Date, index=True)
    period_to: Mapped[date] = mapped_column(Date, index=True)
    shipments_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # Себестоимость отгрузок (sum cost по позициям demand).
    cost_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # Расходные ордера (cashout).
    expense_orders_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # Исходящие платежи со статьёй «Закупка товаров».
    purchase_payments_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # expense_orders + purchase_payments.
    purchases_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # Остаток сырья на складе (лист `Остатки_I_Производство`, колонка D).
    raw_material_stock_sum_rub: Mapped[float] = mapped_column(Float, default=0.0)
    sync_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
    )


class PeriodDayMetric(Base):
    """Показатели по календарным дням внутри выбранного периода (после синхронизации)."""

    __tablename__ = "period_day_metrics"
    __table_args__ = (
        UniqueConstraint(
            "period_from",
            "period_to",
            "bucket_date",
            name="uq_period_day_metric",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    period_from: Mapped[date] = mapped_column(Date, index=True)
    period_to: Mapped[date] = mapped_column(Date, index=True)
    bucket_date: Mapped[date] = mapped_column(Date, index=True)
    # Продажи (sellSum) из отчёта прибыльности, по дням пропорционально весу отгрузок.
    profit_sales_rub: Mapped[float] = mapped_column(Float, default=0.0)
    # Себестоимость продаж (sellCostSum) из того же отчёта.
    cost_shipped_rub: Mapped[float] = mapped_column(Float, default=0.0)
    expense_orders_rub: Mapped[float] = mapped_column(Float, default=0.0)
    paymentout_purchase_rub: Mapped[float] = mapped_column(Float, default=0.0)
    raw_material_stock_rub: Mapped[float] = mapped_column(Float, default=0.0)
