import os
from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base

_BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _default_sqlite_url() -> str:
    data_dir = _BACKEND_ROOT / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{data_dir / 'dashboard.db'}"


DATABASE_URL = os.getenv("DATABASE_URL", _default_sqlite_url())

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db() -> None:
    """Создаёт таблицы. Для SQLite при устаревшей схеме daily_snapshots — пересоздаёт её."""
    if DATABASE_URL.startswith("sqlite"):
        try:
            insp = inspect(engine)
            if insp.has_table("daily_snapshots"):
                cols = {c["name"] for c in insp.get_columns("daily_snapshots")}
                need = {"period_from", "period_to", "snapshot_date"}
                if not need.issubset(cols):
                    with engine.begin() as conn:
                        conn.execute(text("DROP TABLE daily_snapshots"))
        except Exception:
            pass
    Base.metadata.create_all(bind=engine)
    if DATABASE_URL.startswith("sqlite"):
        try:
            insp = inspect(engine)
            if insp.has_table("daily_snapshots"):
                cols = {c["name"] for c in insp.get_columns("daily_snapshots")}
                with engine.begin() as conn:
                    if "expense_orders_sum_rub" not in cols:
                        conn.execute(
                            text(
                                "ALTER TABLE daily_snapshots "
                                "ADD COLUMN expense_orders_sum_rub FLOAT DEFAULT 0"
                            ),
                        )
                    if "purchase_payments_sum_rub" not in cols:
                        conn.execute(
                            text(
                                "ALTER TABLE daily_snapshots "
                                "ADD COLUMN purchase_payments_sum_rub FLOAT DEFAULT 0"
                            ),
                        )
                    if "raw_material_stock_sum_rub" not in cols:
                        conn.execute(
                            text(
                                "ALTER TABLE daily_snapshots "
                                "ADD COLUMN raw_material_stock_sum_rub FLOAT DEFAULT 0"
                            ),
                        )
            if insp.has_table("period_day_metrics"):
                pm_cols = {c["name"] for c in insp.get_columns("period_day_metrics")}
                with engine.begin() as conn:
                    if "profit_sales_rub" not in pm_cols:
                        conn.execute(
                            text(
                                "ALTER TABLE period_day_metrics "
                                "ADD COLUMN profit_sales_rub FLOAT DEFAULT 0"
                            ),
                        )
                        conn.execute(
                            text(
                                "UPDATE period_day_metrics SET profit_sales_rub = 0 "
                                "WHERE profit_sales_rub IS NULL"
                            ),
                        )
                    if "raw_material_stock_rub" not in pm_cols:
                        conn.execute(
                            text(
                                "ALTER TABLE period_day_metrics "
                                "ADD COLUMN raw_material_stock_rub FLOAT DEFAULT 0"
                            ),
                        )
                        conn.execute(
                            text(
                                "UPDATE period_day_metrics SET raw_material_stock_rub = 0 "
                                "WHERE raw_material_stock_rub IS NULL"
                            ),
                        )
        except Exception:
            pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
