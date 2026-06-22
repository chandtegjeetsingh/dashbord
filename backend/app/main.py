from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Annotated, Dict, Optional

from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db, init_db
from app.google_sheets_client import _parse_money, _parse_sheet_date, fetch_sheet_rows
from app.kpi_format import snapshot_history_row, snapshot_to_payload
from app.moysklad_client import MoySkladConfigError, compute_avg_customer_shipping_days
from app.models import DailySnapshot, DashboardSetting, PeriodDayMetric
from app.period_util import default_period_dates
from app.yougile_client import (
    YougileConfigError,
    _extract_items,
    _norm_text,
    _request_json,
    _task_assignee_ids,
    get_employee_tasks,
)

_backend_dir = Path(__file__).resolve().parent.parent
load_dotenv(_backend_dir.parent / ".env")
load_dotenv(_backend_dir / ".env")
_yougile_employee_default = os.getenv("YOUGILE_EMPLOYEE", "Татьяна Живетьева").strip()
_yougile_employee_id_default = os.getenv("YOUGILE_EMPLOYEE_ID", "").strip()
_YOUGILE_DEFAULT_LIMIT = 8

# Кэш задач YouGile: запрос к API медленный (сотни задач), поэтому отдаём
# из памяти мгновенно, а в фоне периодически обновляем (подтягиваем новые задачи).
_yougile_cache: dict[str, dict] = {}
_yougile_cache_lock = threading.Lock()
_yougile_stop = threading.Event()


def _yougile_refresh_sec() -> int:
    raw = os.getenv("YOUGILE_REFRESH_SEC", "90").strip()
    try:
        n = int(raw)
    except ValueError:
        return 90
    return max(20, min(n, 3600))


def _yougile_cache_key(employee: str, limit: int) -> str:
    return f"{employee.strip().casefold()}|{limit}"


def _yougile_build_payload(employee: str, limit: int) -> dict:
    items = get_employee_tasks(
        employee_name=employee,
        limit=limit,
        employee_id=_yougile_employee_id_default or None,
    )
    return {
        "employee": employee,
        "items": [
            {
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "url": t.url,
                "deadline_at": t.deadline_at,
                "priority": t.priority,
            }
            for t in items
        ],
    }


def _yougile_refresh(employee: str, limit: int) -> dict:
    """Тянем задачи из YouGile и кладём в кэш. Возвращаем payload."""
    payload = _yougile_build_payload(employee, limit)
    with _yougile_cache_lock:
        _yougile_cache[_yougile_cache_key(employee, limit)] = {
            "payload": payload,
            "fetched_at": time.time(),
            "error": None,
        }
    return payload


def _yougile_bg_loop() -> None:
    """Фоновое обновление кэша задач сотрудника по умолчанию."""
    while not _yougile_stop.is_set():
        try:
            _yougile_refresh(_yougile_employee_default, _YOUGILE_DEFAULT_LIMIT)
        except Exception as e:  # сеть/конфиг — не роняем поток, пишем ошибку в кэш
            with _yougile_cache_lock:
                key = _yougile_cache_key(_yougile_employee_default, _YOUGILE_DEFAULT_LIMIT)
                entry = _yougile_cache.get(key) or {"payload": None, "fetched_at": 0.0}
                entry["error"] = str(e)
                _yougile_cache[key] = entry
        _yougile_stop.wait(_yougile_refresh_sec())


# ===== Кэш среднего времени отгрузки (МойСклад) =====
# Расчёт тяжёлый (~10 c: пагинация отгрузок по всем заказам периода). Держим
# результат в памяти и обновляем в фоне — карточка/дашборд открываются мгновенно.
_shipping_cache: dict[str, dict] = {}
_shipping_cache_lock = threading.Lock()


def _shipping_refresh_sec() -> int:
    raw = os.getenv("SHIPPING_REFRESH_SEC", "180").strip()
    try:
        n = int(raw)
    except ValueError:
        return 180
    return max(30, min(n, 3600))


def _shipping_cache_key(p_from: date, p_to: date, include_marketplaces: bool) -> str:
    return f"{p_from.isoformat()}|{p_to.isoformat()}|{int(include_marketplaces)}"


def _shipping_refresh(p_from: date, p_to: date, include_marketplaces: bool) -> dict:
    payload = compute_avg_customer_shipping_days(
        p_from, p_to, include_marketplaces=include_marketplaces
    )
    with _shipping_cache_lock:
        _shipping_cache[_shipping_cache_key(p_from, p_to, include_marketplaces)] = {
            "payload": payload,
            "fetched_at": time.time(),
            "error": None,
        }
    return payload


def _shipping_bg_loop() -> None:
    """Фоновое обновление среднего времени отгрузки за текущий месяц (без маркетплейсов)."""
    while not _yougile_stop.is_set():
        try:
            p_from, p_to = default_period_dates()
            _shipping_refresh(p_from, p_to, False)
        except Exception:
            pass  # сеть/конфиг МойСклад — не роняем поток, повторим позже
        _yougile_stop.wait(_shipping_refresh_sec())


# ===== Фоновая синхронизация снимка KPI (Google Sheets + МойСклад → SQLite) =====
# Цифры блока «Продажи · Себестоимость · Закупки» лежат в БД; обновляем их в фоне,
# чтобы при открытии отдавать готовый снимок мгновенно, без ожидания POST /api/sync.
def _sync_refresh_sec() -> int:
    raw = os.getenv("SYNC_REFRESH_SEC", "300").strip()
    try:
        n = int(raw)
    except ValueError:
        return 300
    return max(60, min(n, 3600))


def _sync_bg_loop() -> None:
    while not _yougile_stop.is_set():
        try:
            from app.sync_service import run_sync

            p_from, p_to = default_period_dates()
            db = SessionLocal()
            try:
                run_sync(db, p_from, p_to)
            finally:
                db.close()
        except Exception:
            pass  # источник недоступен — повторим на следующей итерации
        _yougile_stop.wait(_sync_refresh_sec())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Фоновый прогрев кэшей — чтобы дашборд открывался мгновенно, а цифры
    # подтягивались в фоне (YouGile, среднее время отгрузки, снимок KPI).
    if os.getenv("YOUGILE_API_KEY", "").strip():
        threading.Thread(target=_yougile_bg_loop, name="yougile-refresh", daemon=True).start()
    if os.getenv("MOYSKLAD_TOKEN", "").strip() or os.getenv("MOYSKLAD_LOGIN", "").strip():
        threading.Thread(target=_shipping_bg_loop, name="shipping-refresh", daemon=True).start()
    threading.Thread(target=_sync_bg_loop, name="kpi-sync-refresh", daemon=True).start()
    try:
        yield
    finally:
        _yougile_stop.set()


app = FastAPI(
    title="Хозяйка закромов",
    description="API дашборда KPI (Google Sheets, план, снимки).",
    version="0.1.0",
    lifespan=lifespan,
)


@app.exception_handler(SQLAlchemyError)
async def _db_error_handler(_request, exc: SQLAlchemyError):
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"Ошибка базы данных: {exc!s}. "
            "Если недавно менялась схема — удалите файл SQLite и перезапустите API.",
        },
    )


_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DbSession = Annotated[Session, Depends(get_db)]

_COST_RATIO_PLAN_KEY = "cost_ratio_plan_percent"
_DELIVERY_AVG_PLAN_KEY = "delivery_avg_plan_rub_per_kg"
_LOGISTICS_SHARE_PLAN_KEY = "logistics_share_plan_percent"
_SHIPPING_AVG_PLAN_DAYS_KEY = "shipping_avg_plan_days"
_TASKS_BONUS_PERCENT_KEY = "tasks_bonus_plan_percent"


def _monthly_plan_settings_key(ym: str) -> str:
    """ym в формате YYYY-MM → ключ в dashboard_settings."""
    return f"monthly_plan_{ym.replace('-', '_')}"


def _validate_plan_month(ym: str) -> str:
    if not re.match(r"^\d{4}-\d{2}$", ym):
        raise HTTPException(
            status_code=400,
            detail="month ожидается в формате YYYY-MM",
        )
    y, mo = int(ym[:4]), int(ym[5:7])
    if mo < 1 or mo > 12:
        raise HTTPException(status_code=400, detail="некорректный месяц")
    return f"{y:04d}-{mo:02d}"


def _month_from_monthly_plan_settings_key(key: str) -> Optional[str]:
    """Ключ `monthly_plan_YYYY_MM` → `YYYY-MM` или None."""
    m = re.match(r"^monthly_plan_(\d{4})_(\d{2})$", key)
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    if mo < 1 or mo > 12:
        return None
    return f"{y:04d}-{mo:02d}"


def _list_months_with_saved_plan_overrides(db: Session) -> list[str]:
    """Месяцы YYYY-MM, для которых в БД есть непустой JSON переопределений."""
    keys = db.scalars(
        select(DashboardSetting.key).where(DashboardSetting.key.startswith("monthly_plan_"))
    ).all()
    yms: list[str] = []
    for key in keys:
        ym = _month_from_monthly_plan_settings_key(key)
        if ym is None:
            continue
        if _load_monthly_plan_overrides(db, ym):
            yms.append(ym)
    yms.sort()
    return yms


def _iter_plan_months(month_a: str, month_b: str) -> list[str]:
    """Последовательность YYYY-MM от month_a до month_b включительно (month_a ≤ month_b)."""
    y1, m1 = int(month_a[:4]), int(month_a[5:7])
    y2, m2 = int(month_b[:4]), int(month_b[5:7])
    out: list[str] = []
    y, m = y1, m1
    while True:
        out.append(f"{y:04d}-{m:02d}")
        if y == y2 and m == m2:
            break
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _load_monthly_plan_overrides(db: Session, ym: str) -> dict:
    key = _monthly_plan_settings_key(ym)
    row = db.get(DashboardSetting, key)
    if not row or not row.value.strip():
        return {}
    try:
        data = json.loads(row.value)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _save_monthly_plan_overrides(db: Session, ym: str, data: dict) -> None:
    key = _monthly_plan_settings_key(ym)
    row = db.get(DashboardSetting, key)
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if row is None:
        db.add(DashboardSetting(key=key, value=blob))
    else:
        row.value = blob


def _get_delivery_avg_global(db: Session) -> Optional[float]:
    avg = _get_setting_float(db, _DELIVERY_AVG_PLAN_KEY)
    if avg is None:
        avg = _parse_percent_env(os.getenv("KPI_DELIVERY_AVG_PLAN_RUB_PER_KG", ""))
    return avg


def _get_shipping_avg_plan_days_global(db: Session) -> Optional[float]:
    days = _get_setting_float(db, _SHIPPING_AVG_PLAN_DAYS_KEY)
    if days is None:
        days = _parse_percent_env(os.getenv("KPI_SHIPPING_AVG_PLAN_DAYS", ""))
    return days


def _get_logistics_share_global(db: Session) -> Optional[float]:
    sh = _get_setting_float(db, _LOGISTICS_SHARE_PLAN_KEY)
    if sh is None:
        sh = _parse_percent_env(os.getenv("KPI_LOGISTICS_SHARE_PLAN_PERCENT", ""))
    return sh


def _get_tasks_bonus_global(db: Session) -> Optional[float]:
    v = _get_setting_float(db, _TASKS_BONUS_PERCENT_KEY)
    if v is None:
        v = _parse_percent_env(os.getenv("KPI_TASKS_BONUS_PERCENT", ""))
    return v


def _parse_float_from_override(raw: object) -> Optional[float]:
    if raw is None or raw == "":
        return None
    try:
        return float(str(raw).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _resolve_monthly_plan(db: Session, ym: str) -> Dict[str, object]:
    """Планы для календарного месяца: переопределения из JSON + глобальные настройки/env."""
    raw = _load_monthly_plan_overrides(db, ym)
    cr_o = _parse_float_from_override(raw.get("cost_ratio_plan_percent"))
    cr = cr_o if cr_o is not None else _get_cost_ratio_plan_percent(db)
    da_o = _parse_float_from_override(raw.get("delivery_avg_rub_per_kg"))
    da = da_o if da_o is not None else _get_delivery_avg_global(db)
    ls_o = _parse_float_from_override(raw.get("logistics_share_plan_percent"))
    ls = ls_o if ls_o is not None else _get_logistics_share_global(db)
    sh_o = _parse_float_from_override(raw.get("shipping_avg_plan_days"))
    sh = sh_o if sh_o is not None else _get_shipping_avg_plan_days_global(db)
    tb_o = _parse_float_from_override(raw.get("tasks_bonus_percent"))
    tb = tb_o if tb_o is not None else _get_tasks_bonus_global(db)
    return {
        "month": ym,
        "cost_ratio_plan_percent": round(cr, 4) if cr is not None else None,
        "delivery_avg_rub_per_kg": round(da, 2) if da is not None else None,
        "logistics_share_plan_percent": round(ls, 4) if ls is not None else None,
        "shipping_avg_plan_days": round(sh, 1) if sh is not None else None,
        "tasks_bonus_percent": round(tb, 2) if tb is not None else None,
    }


def _parse_percent_env(raw: str) -> Optional[float]:
    t = raw.strip().replace(",", ".")
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _get_cost_ratio_plan_percent(db: Session) -> Optional[float]:
    row = db.get(DashboardSetting, _COST_RATIO_PLAN_KEY)
    if row and row.value.strip():
        v = _parse_percent_env(row.value)
        if v is not None:
            return v
    return _parse_percent_env(os.getenv("KPI_COST_RATIO_PLAN_PERCENT", ""))


def _parse_period(
    date_from: Optional[date],
    date_to: Optional[date],
) -> tuple[date, date]:
    df_def, dt_def = default_period_dates()
    a = date_from if date_from is not None else df_def
    b = date_to if date_to is not None else dt_def
    if a > b:
        raise HTTPException(
            status_code=400,
            detail="Параметр date_from не может быть позже date_to",
        )
    return a, b


@app.get("/health")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/kpi/period-defaults")
def kpi_period_defaults() -> dict[str, str]:
    df, dt = default_period_dates()
    return {"date_from": df.isoformat(), "date_to": dt.isoformat()}


@app.get("/api/settings/cost-ratio-plan")
def get_cost_ratio_plan(db: DbSession) -> Dict[str, Optional[float]]:
    """Целевой % (себестоимость отгрузок / сумма отгрузок * 100), задаётся на странице «План»."""
    v = _get_cost_ratio_plan_percent(db)
    return {"percent": round(v, 4) if v is not None else None}


@app.put("/api/settings/cost-ratio-plan")
def put_cost_ratio_plan(
    db: DbSession,
    body: Annotated[dict, Body(...)],
) -> Dict[str, float]:
    raw = body.get("percent")
    if raw is None:
        raise HTTPException(status_code=400, detail="Нужно поле percent")
    try:
        pct = float(str(raw).strip().replace(",", "."))
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail="percent должен быть числом") from e
    if pct < 0 or pct > 500:
        raise HTTPException(
            status_code=400,
            detail="percent вне допустимого диапазона (0…500)",
        )
    row = db.get(DashboardSetting, _COST_RATIO_PLAN_KEY)
    if row is None:
        row = DashboardSetting(key=_COST_RATIO_PLAN_KEY, value=str(pct))
        db.add(row)
    else:
        row.value = str(pct)
    db.commit()
    return {"percent": round(pct, 4)}


def _get_setting_float(db: Session, key: str) -> Optional[float]:
    row = db.get(DashboardSetting, key)
    if row and row.value.strip():
        v = _parse_percent_env(row.value)
        if v is not None:
            return v
    return None


def _put_setting_float(db: Session, key: str, value: float) -> None:
    row = db.get(DashboardSetting, key)
    if row is None:
        db.add(DashboardSetting(key=key, value=str(value)))
    else:
        row.value = str(value)


@app.get("/api/settings/delivery-logistics-plan")
def get_delivery_logistics_plan(db: DbSession) -> Dict[str, Optional[float]]:
    """Плановые: средняя доставка ₽/кг и среднее время отгрузки, дн. (для бонуса и «План»)."""
    avg = _get_setting_float(db, _DELIVERY_AVG_PLAN_KEY)
    if avg is None:
        avg = _parse_percent_env(os.getenv("KPI_DELIVERY_AVG_PLAN_RUB_PER_KG", ""))
    sh = _get_setting_float(db, _SHIPPING_AVG_PLAN_DAYS_KEY)
    if sh is None:
        sh = _parse_percent_env(os.getenv("KPI_SHIPPING_AVG_PLAN_DAYS", ""))
    return {
        "delivery_avg_rub_per_kg": round(avg, 2) if avg is not None else None,
        "shipping_avg_plan_days": round(sh, 1) if sh is not None else None,
        "logistics_share_plan_percent": None,
    }


@app.put("/api/settings/delivery-logistics-plan")
def put_delivery_logistics_plan(
    db: DbSession,
    body: Annotated[dict, Body(...)],
) -> Dict[str, Optional[float]]:
    if "delivery_avg_rub_per_kg" in body:
        raw = body.get("delivery_avg_rub_per_kg")
        if raw is None or raw == "":
            row = db.get(DashboardSetting, _DELIVERY_AVG_PLAN_KEY)
            if row:
                db.delete(row)
        else:
            try:
                v = float(str(raw).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="delivery_avg_rub_per_kg должен быть числом",
                ) from e
            if v < 0 or v > 1e9:
                raise HTTPException(status_code=400, detail="delivery_avg_rub_per_kg вне диапазона")
            _put_setting_float(db, _DELIVERY_AVG_PLAN_KEY, v)
    if "logistics_share_plan_percent" in body:
        raw = body.get("logistics_share_plan_percent")
        if raw is None or raw == "":
            row = db.get(DashboardSetting, _LOGISTICS_SHARE_PLAN_KEY)
            if row:
                db.delete(row)
        else:
            try:
                v = float(str(raw).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="logistics_share_plan_percent должен быть числом",
                ) from e
            if v < 0 or v > 500:
                raise HTTPException(
                    status_code=400,
                    detail="logistics_share_plan_percent вне диапазона (0…500)",
                )
            _put_setting_float(db, _LOGISTICS_SHARE_PLAN_KEY, v)
    if "shipping_avg_plan_days" in body:
        raw = body.get("shipping_avg_plan_days")
        if raw is None or raw == "":
            row = db.get(DashboardSetting, _SHIPPING_AVG_PLAN_DAYS_KEY)
            if row:
                db.delete(row)
        else:
            try:
                v = float(str(raw).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="shipping_avg_plan_days должен быть числом",
                ) from e
            if v < 0 or v > 365:
                raise HTTPException(
                    status_code=400,
                    detail="shipping_avg_plan_days вне диапазона (0…365)",
                )
            _put_setting_float(db, _SHIPPING_AVG_PLAN_DAYS_KEY, v)
    db.commit()
    return get_delivery_logistics_plan(db)


@app.get("/api/settings/tasks-bonus-percent")
def get_tasks_bonus_percent(db: DbSession) -> Dict[str, Optional[float]]:
    """Процент бонуса за задачи и поручения: 0…10 % (на дашборде 10 % = 5 000 ₽)."""
    v = _get_setting_float(db, _TASKS_BONUS_PERCENT_KEY)
    if v is None:
        v = _parse_percent_env(os.getenv("KPI_TASKS_BONUS_PERCENT", ""))
    return {"percent": round(v, 2) if v is not None else None}


@app.put("/api/settings/tasks-bonus-percent")
def put_tasks_bonus_percent(
    db: DbSession,
    body: Annotated[dict, Body(...)],
) -> Dict[str, float]:
    raw = body.get("percent")
    if raw is None:
        raise HTTPException(status_code=400, detail="Нужно поле percent")
    try:
        pct = float(str(raw).strip().replace(",", "."))
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail="percent должен быть числом") from e
    if pct < 0 or pct > 10:
        raise HTTPException(
            status_code=400,
            detail="percent вне допустимого диапазона (0…10)",
        )
    _put_setting_float(db, _TASKS_BONUS_PERCENT_KEY, pct)
    db.commit()
    return {"percent": round(pct, 2)}


@app.get("/api/settings/monthly-plan")
def get_monthly_plan(
    db: DbSession,
    month: Annotated[str, Query(description="Календарный месяц YYYY-MM (планы и расчёты сверху)")],
) -> Dict[str, object]:
    ym = _validate_plan_month(month.strip())
    return _resolve_monthly_plan(db, ym)


@app.get("/api/settings/monthly-plans-range")
def get_monthly_plans_range(
    db: DbSession,
    month_from: Annotated[str, Query(description="Начало интервала YYYY-MM")],
    month_to: Annotated[str, Query(description="Конец интервала YYYY-MM")],
) -> Dict[str, object]:
    """Итоговые планы по месяцам (как в GET monthly-plan) для каждого месяца в диапазоне."""
    a = _validate_plan_month(month_from.strip())
    b = _validate_plan_month(month_to.strip())
    if a > b:
        a, b = b, a
    seq = _iter_plan_months(a, b)
    if len(seq) > 48:
        raise HTTPException(
            status_code=400,
            detail="Интервал не более 48 месяцев (сузьте month_from … month_to)",
        )
    months = [_resolve_monthly_plan(db, ym) for ym in seq]
    return {"months": months}


@app.get("/api/settings/monthly-plans-saved")
def get_monthly_plans_saved(db: DbSession) -> Dict[str, object]:
    """Только месяцы, для которых вы сохраняли план (есть запись переопределений в БД)."""
    seq = _list_months_with_saved_plan_overrides(db)
    months = [_resolve_monthly_plan(db, ym) for ym in seq]
    return {"months": months}


@app.put("/api/settings/monthly-plan")
def put_monthly_plan(
    db: DbSession,
    body: Annotated[dict, Body(...)],
) -> Dict[str, object]:
    raw_m = body.get("month")
    if not raw_m or not isinstance(raw_m, str):
        raise HTTPException(status_code=400, detail="Нужно поле month (YYYY-MM)")
    ym = _validate_plan_month(str(raw_m).strip())
    cur = _load_monthly_plan_overrides(db, ym)

    if "cost_ratio_plan_percent" in body:
        v = body.get("cost_ratio_plan_percent")
        if v is None or v == "":
            cur.pop("cost_ratio_plan_percent", None)
        else:
            try:
                pct = float(str(v).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="cost_ratio_plan_percent должен быть числом",
                ) from e
            if pct < 0 or pct > 500:
                raise HTTPException(
                    status_code=400,
                    detail="cost_ratio_plan_percent вне 0…500",
                )
            cur["cost_ratio_plan_percent"] = pct

    if "delivery_avg_rub_per_kg" in body:
        v = body.get("delivery_avg_rub_per_kg")
        if v is None or v == "":
            cur.pop("delivery_avg_rub_per_kg", None)
        else:
            try:
                x = float(str(v).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="delivery_avg_rub_per_kg должен быть числом",
                ) from e
            if x < 0 or x > 1e9:
                raise HTTPException(
                    status_code=400,
                    detail="delivery_avg_rub_per_kg вне допустимого диапазона",
                )
            cur["delivery_avg_rub_per_kg"] = x

    if "logistics_share_plan_percent" in body:
        v = body.get("logistics_share_plan_percent")
        if v is None or v == "":
            cur.pop("logistics_share_plan_percent", None)
        else:
            try:
                x = float(str(v).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="logistics_share_plan_percent должен быть числом",
                ) from e
            if x < 0 or x > 500:
                raise HTTPException(
                    status_code=400,
                    detail="logistics_share_plan_percent вне 0…500",
                )
            cur["logistics_share_plan_percent"] = x

    if "shipping_avg_plan_days" in body:
        v = body.get("shipping_avg_plan_days")
        if v is None or v == "":
            cur.pop("shipping_avg_plan_days", None)
        else:
            try:
                x = float(str(v).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="shipping_avg_plan_days должен быть числом",
                ) from e
            if x < 0 or x > 365:
                raise HTTPException(
                    status_code=400,
                    detail="shipping_avg_plan_days вне 0…365",
                )
            cur["shipping_avg_plan_days"] = x

    if "tasks_bonus_percent" in body:
        v = body.get("tasks_bonus_percent")
        if v is None or v == "":
            cur.pop("tasks_bonus_percent", None)
        else:
            try:
                pct = float(str(v).strip().replace(",", "."))
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400,
                    detail="tasks_bonus_percent должен быть числом",
                ) from e
            if pct < 0 or pct > 10:
                raise HTTPException(
                    status_code=400,
                    detail="tasks_bonus_percent вне 0…10",
                )
            cur["tasks_bonus_percent"] = pct

    key = _monthly_plan_settings_key(ym)
    row = db.get(DashboardSetting, key)
    if not cur:
        if row:
            db.delete(row)
    else:
        _save_monthly_plan_overrides(db, ym, cur)
    db.commit()
    return _resolve_monthly_plan(db, ym)


@app.get("/api/kpi/current")
def kpi_current(
    db: DbSession,
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
) -> dict:
    p_from, p_to = _parse_period(date_from, date_to)
    row = db.scalar(
        select(DailySnapshot)
        .where(
            DailySnapshot.period_from == p_from,
            DailySnapshot.period_to == p_to,
        )
        .order_by(DailySnapshot.snapshot_date.desc())
        .limit(1),
    )
    return snapshot_to_payload(row)


@app.get("/api/kpi/history")
def kpi_history(
    db: DbSession,
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
) -> dict:
    p_from, p_to = _parse_period(date_from, date_to)
    rows = db.scalars(
        select(DailySnapshot)
        .where(
            DailySnapshot.period_from == p_from,
            DailySnapshot.period_to == p_to,
        )
        .order_by(DailySnapshot.snapshot_date.asc()),
    ).all()
    return {"points": [snapshot_history_row(r) for r in rows]}


@app.get("/api/kpi/daily-breakdown")
def kpi_daily_breakdown(
    db: DbSession,
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
) -> dict:
    """По календарным дням: себестоимость отгрузок и закупки (расходные ордера + платежи)."""
    p_from, p_to = _parse_period(date_from, date_to)
    rows = db.scalars(
        select(PeriodDayMetric)
        .where(
            PeriodDayMetric.period_from == p_from,
            PeriodDayMetric.period_to == p_to,
        )
        .order_by(PeriodDayMetric.bucket_date.asc()),
    ).all()
    by_day = {r.bucket_date: r for r in rows}
    out: list[dict] = []
    d = p_from
    while d <= p_to:
        r = by_day.get(d)
        eo = round(r.expense_orders_rub, 2) if r else 0.0
        po = round(r.paymentout_purchase_rub, 2) if r else 0.0
        ps = round(r.profit_sales_rub, 2) if r else 0.0
        out.append(
            {
                "date": d.isoformat(),
                "shipments": ps,
                "cost_shipped": round(r.cost_shipped_rub, 2) if r else 0.0,
                "purchases": round(eo + po, 2),
                "raw_material_stock": round(r.raw_material_stock_rub, 2) if r else 0.0,
            },
        )
        d += timedelta(days=1)
    return {"days": out}


def _reorder_group_key(s: str) -> str:
    """Схлопывание пробелов/NBSP — одна кнопка на одну логическую категорию из столбца C."""
    t = str(s).replace("\u00a0", " ").strip()
    return " ".join(t.split())


def _is_reorder_sheet_header_row(name: str, group: str) -> bool:
    n = name.casefold().replace("ё", "е").strip()
    g = group.casefold().replace("ё", "е").strip()
    return n == "наименование" and g == "группа"


@app.get("/api/kpi/reorder-raw-materials")
def kpi_reorder_raw_materials() -> dict:
    spreadsheet_id = os.getenv(
        "GOOGLE_SHEETS_REORDER_SPREADSHEET_ID",
        "1eUdgokEoZ72xePF8RmQZbuWwoYNuJH9rvU3WvUxBTEE",
    ).strip()
    sheet_name = os.getenv("GOOGLE_SHEETS_REORDER_SHEET_NAME", "Остатки сырья").strip()
    excluded_groups = {"жмых и мука", "масло"}

    rows = fetch_sheet_rows(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        tq="select B, C, G",
        prefer_formatted_for_cols=frozenset({"C"}),
    )

    categories_by_key: dict[str, str] = {}
    candidates: list[dict] = []
    for r in rows:
        name = str(r.get("B") or "").strip()
        group_raw = str(r.get("C") or "").strip()
        if _is_reorder_sheet_header_row(name, group_raw):
            continue
        if group_raw:
            gk = _reorder_group_key(group_raw)
            if gk:
                categories_by_key.setdefault(gk, group_raw.strip())

        if not name:
            continue
        group_norm = group_raw.casefold().replace("ё", "е")
        if group_norm in excluded_groups:
            continue
        stock = _parse_money(r.get("G"))
        if stock <= 0:
            continue
        candidates.append(
            {
                "name": name,
                "group": group_raw,
                "stock": round(stock, 2),
            },
        )

    candidates.sort(key=lambda x: (x["stock"], x["name"]))
    categories = sorted(
        categories_by_key.values(),
        key=lambda s: s.casefold().replace("ё", "е"),
    )
    return {"items": candidates, "categories": categories}


def _norm_status_cell(value: object) -> str:
    """Текст статуса из chip/выпадающего списка: убираем многоточие, nbsp, лишние пробелы."""
    s = str(value or "").strip().casefold().replace("ё", "е")
    s = s.replace("\u00a0", " ").replace("\u2026", "").replace("...", "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _row_matches_in_transit_status(b_norm: str) -> bool:
    if not b_norm:
        return False
    if "заказ получен" in b_norm:
        return False
    if "заказ в пути" in b_norm:
        return True
    if "заказ оформлен" in b_norm:
        return True
    # Усечённая подпись в интерфейсе: «Заказ оформл…»
    if b_norm.startswith("заказ оформл"):
        return True
    return False


@app.get("/api/kpi/raw-material-in-transit")
def kpi_raw_material_in_transit() -> dict:
    """
    Лист «В ПУТИ»: строки со статусом в колонке B «Заказ оформлен» или «Заказ в пути» —
    сумма колонки E (руб.).
    """
    spreadsheet_id = os.getenv(
        "GOOGLE_SHEETS_IN_TRANSIT_SPREADSHEET_ID",
        "1cNLC0WZVIcHJWQbKYbpbedAdxANDze3VV12Op2F1O3E",
    ).strip()
    sheet_name = os.getenv("GOOGLE_SHEETS_IN_TRANSIT_SHEET_NAME", "В ПУТИ").strip()

    try:
        rows = fetch_sheet_rows(
            spreadsheet_id=spreadsheet_id,
            sheet_name=sheet_name,
            tq="select B, E",
            prefer_formatted_for_cols=frozenset({"B"}),
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=(
                "Не удалось прочитать лист «В ПУТИ» через Google (gviz). "
                "Проверьте имя листа и что таблица открыта для просмотра по ссылке. "
                f"Детали: {e!s}"
            ),
        ) from e

    total = 0.0
    for r in rows:
        b_norm = _norm_status_cell(r.get("B"))
        if not _row_matches_in_transit_status(b_norm):
            continue
        total += _parse_money(r.get("E"))

    return {"sum_rub": round(total, 2)}


def _is_delivery_cost_header_row(f_raw: object, i_raw: object) -> bool:
    """Первая строка / шапка: в F — «дата», в I — подпись про стоимость за кг и т.п."""
    f_txt = str(f_raw or "").strip().casefold().replace("ё", "е")
    if not f_txt or len(f_txt) > 64:
        return False
    if "дата" in f_txt:
        return True
    i_txt = str(i_raw or "").strip().casefold().replace("ё", "е")
    if "стоимость" in i_txt and "кг" in i_txt:
        return True
    return False


@app.get("/api/kpi/delivery-cost-per-kg")
def kpi_delivery_cost_per_kg(
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
) -> Dict[str, object]:
    """
    По строкам с датой в F внутри периода [date_from, date_to]:
    - средняя стоимость доставки (факт, ₽/кг) — сумма H / сумма G;
    - доля логистики — (сумма H) / (сумма E) × 100% (числа через _parse_money).
    Таблица и лист — в .env.
    """
    p_from, p_to = _parse_period(date_from, date_to)
    spreadsheet_id = os.getenv(
        "GOOGLE_SHEETS_DELIVERY_COST_SPREADSHEET_ID",
        "1cNLC0WZVIcHJWQbKYbpbedAdxANDze3VV12Op2F1O3E",
    ).strip()
    sheet_name = os.getenv(
        "GOOGLE_SHEETS_DELIVERY_COST_SHEET_NAME",
        os.getenv("GOOGLE_SHEETS_IN_TRANSIT_SHEET_NAME", "В ПУТИ"),
    ).strip()

    try:
        rows = fetch_sheet_rows(
            spreadsheet_id=spreadsheet_id,
            sheet_name=sheet_name,
            tq="select E, F, G, H, I",
            prefer_formatted_for_cols=frozenset({"E", "F", "G", "H", "I"}),
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=(
                "Не удалось прочитать лист доставки через Google (gviz). "
                "Проверьте GOOGLE_SHEETS_DELIVERY_COST_SHEET_NAME и доступ таблицы по ссылке. "
                f"Детали: {e!s}"
            ),
        ) from e

    sum_h = 0.0
    sum_e = 0.0
    sum_g = 0.0
    rows_in_period = 0
    h_values_count = 0
    for r in rows:
        f_raw = r.get("F")
        i_raw = r.get("I")
        h_raw = r.get("H")
        if _is_delivery_cost_header_row(f_raw, i_raw):
            continue
        row_date = _parse_sheet_date(f_raw)
        if row_date is None or row_date < p_from or row_date > p_to:
            continue
        rows_in_period += 1
        val_h = _parse_money(h_raw)
        val_e = _parse_money(r.get("E"))
        val_g = _parse_money(r.get("G"))
        sum_h += val_h
        sum_e += val_e
        sum_g += val_g
        if val_h != 0.0:
            h_values_count += 1

    share_pct: Optional[float] = None
    if sum_e > 0:
        share_pct = round((sum_h / sum_e) * 100.0, 2)

    avg_rub: Optional[float] = None
    if sum_g > 0:
        avg_rub = round(sum_h / sum_g, 2)

    return {
        "avg_rub_per_kg": avg_rub,
        "rows_used": rows_in_period,
        "rows_in_period": rows_in_period,
        "h_values_count": h_values_count,
        "logistics_share_percent": share_pct,
        "sum_h_rub": round(sum_h, 2),
        "sum_e_rub": round(sum_e, 2),
        "sum_g_rub": round(sum_g, 2),
        "period_from": p_from.isoformat(),
        "period_to": p_to.isoformat(),
    }


@app.get("/api/kpi/avg-shipping-days")
def kpi_avg_shipping_days(
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
    include_marketplaces: Annotated[
        bool,
        Query(
            description="Учитывать заказы маркетплейсов (Ozon, РВБ/Wildberries)",
        ),
    ] = False,
) -> Dict[str, object]:
    """
    Среднее время отгрузки заказов покупателей (МойСклад, customerorder):
    от created до первой проведённой отгрузки (demand.moment).
    """
    p_from, p_to = _parse_period(date_from, date_to)
    key = _shipping_cache_key(p_from, p_to, include_marketplaces)
    with _shipping_cache_lock:
        entry = _shipping_cache.get(key)

    # Свежий кэш — отдаём мгновенно (фоновый поток держит текущий месяц актуальным).
    if entry and entry.get("payload") is not None:
        age = time.time() - float(entry.get("fetched_at") or 0.0)
        if age <= _shipping_refresh_sec():
            payload = dict(entry["payload"])
            payload["cached"] = True
            payload["age_sec"] = round(age, 1)
            return payload

    # Кэш пуст или устарел — считаем синхронно и кладём в кэш.
    try:
        payload = _shipping_refresh(p_from, p_to, include_marketplaces)
        payload["cached"] = False
        payload["age_sec"] = 0.0
        return payload
    except MoySkladConfigError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        # Лучше отдать прошлый (устаревший) результат, чем ошибку и пустую карточку.
        if entry and entry.get("payload") is not None:
            payload = dict(entry["payload"])
            payload["cached"] = True
            payload["stale"] = True
            payload["age_sec"] = round(time.time() - float(entry.get("fetched_at") or 0.0), 1)
            return payload
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось получить заказы покупателей из МойСклад: {e!s}",
        ) from e


@app.get("/api/integrations/yougile/tasks")
def yougile_employee_tasks(
    employee: Annotated[
        str,
        Query(description="ФИО сотрудника в YouGile"),
    ] = _yougile_employee_default,
    limit: Annotated[
        int,
        Query(ge=1, le=20, description="Максимум задач в ответе"),
    ] = 8,
) -> dict:
    key = _yougile_cache_key(employee, limit)
    with _yougile_cache_lock:
        entry = _yougile_cache.get(key)

    # Свежий кэш — отдаём мгновенно (фоновый поток держит его актуальным).
    if entry and entry.get("payload") is not None:
        age = time.time() - float(entry.get("fetched_at") or 0.0)
        if age <= _yougile_refresh_sec():
            payload = dict(entry["payload"])
            payload["cached"] = True
            payload["age_sec"] = round(age, 1)
            return payload

    # Кэш пуст или устарел — обновляем синхронно (после оптимизации это ~1-2 c).
    try:
        payload = _yougile_refresh(employee, limit)
        payload["cached"] = False
        payload["age_sec"] = 0.0
        return payload
    except YougileConfigError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        # Если есть хоть какой-то старый кэш — лучше отдать его, чем ошибку.
        if entry and entry.get("payload") is not None:
            payload = dict(entry["payload"])
            payload["cached"] = True
            payload["age_sec"] = round(time.time() - float(entry.get("fetched_at") or 0.0), 1)
            payload["stale"] = True
            return payload
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось получить задачи из YouGile: {e!s}",
        ) from e


@app.get("/api/integrations/yougile/debug")
def yougile_debug(
    employee: Annotated[
        str,
        Query(description="ФИО сотрудника в YouGile"),
    ] = _yougile_employee_default,
) -> dict:
    try:
        users_payload = _request_json("users")
        tasks_payload = _request_json("tasks")
        users_raw = _extract_items(users_payload)
        tasks_raw = _extract_items(tasks_payload)

        users_by_id: dict[str, dict[str, str]] = {}
        for u in users_raw:
            uid = _norm_text(u.get("id"))
            if not uid:
                continue
            users_by_id[uid] = {
                "id": uid,
                "email": _norm_text(u.get("email")),
                "realName": _norm_text(u.get("realName")),
                "name": _norm_text(u.get("name") or u.get("fullName")),
            }

        matched_users: list[dict[str, str]] = []
        employee_norm = employee.casefold().strip()
        for u in users_raw:
            uid = _norm_text(u.get("id"))
            variants = [
                _norm_text(u.get("name")),
                _norm_text(u.get("fullName")),
                _norm_text(u.get("realName")),
                _norm_text(u.get("email")),
            ]
            variants_norm = [v.casefold().strip() for v in variants if v.strip()]
            if any(v == employee_norm for v in variants_norm):
                matched_users.append(
                    {
                        "id": uid,
                        "name": _norm_text(u.get("name") or u.get("fullName")),
                        "realName": _norm_text(u.get("realName")),
                        "email": _norm_text(u.get("email")),
                    }
                )

        assignee_key_stats = {
            "assigned": 0,
            "assignedUserIds": 0,
            "assigneeIds": 0,
            "responsibleIds": 0,
            "memberIds": 0,
            "assignedTo": 0,
            "responsible": 0,
            "assignee": 0,
        }
        for t in tasks_raw:
            for k in assignee_key_stats:
                if t.get(k):
                    assignee_key_stats[k] += 1

        assigned_task_counts: dict[str, int] = {}
        for t in tasks_raw:
            for uid in _task_assignee_ids(t):
                assigned_task_counts[uid] = assigned_task_counts.get(uid, 0) + 1
        assigned_top = sorted(
            assigned_task_counts.items(),
            key=lambda x: x[1],
            reverse=True,
        )[:10]
        assigned_users_top = [
            {
                "id": uid,
                "task_count": cnt,
                "email": users_by_id.get(uid, {}).get("email", ""),
                "realName": users_by_id.get(uid, {}).get("realName", ""),
                "name": users_by_id.get(uid, {}).get("name", ""),
            }
            for uid, cnt in assigned_top
        ]

        sample_titles = []
        for t in tasks_raw[:10]:
            sample_titles.append(
                _norm_text(t.get("title") or t.get("name") or t.get("summary"))
            )

        tasks_for_first_match = 0
        if matched_users and matched_users[0].get("id"):
            uid = matched_users[0]["id"]
            tasks_for_first_match = sum(1 for t in tasks_raw if uid in _task_assignee_ids(t))

        users_payload_preview = (
            users_payload
            if isinstance(users_payload, list)
            else {k: users_payload.get(k) for k in list(users_payload.keys())[:12]}
            if isinstance(users_payload, dict)
            else str(users_payload)
        )
        tasks_payload_preview = (
            tasks_payload
            if isinstance(tasks_payload, list)
            else {k: tasks_payload.get(k) for k in list(tasks_payload.keys())[:12]}
            if isinstance(tasks_payload, dict)
            else str(tasks_payload)
        )

        return {
            "employee_query": employee,
            "users_count": len(users_raw),
            "tasks_count": len(tasks_raw),
            "users_payload_type": type(users_payload).__name__,
            "tasks_payload_type": type(tasks_payload).__name__,
            "users_payload_keys": sorted(users_payload.keys()) if isinstance(users_payload, dict) else [],
            "tasks_payload_keys": sorted(tasks_payload.keys()) if isinstance(tasks_payload, dict) else [],
            "users_payload_preview": users_payload_preview,
            "tasks_payload_preview": tasks_payload_preview,
            "matched_users": matched_users[:10],
            "tasks_for_first_match_user": tasks_for_first_match,
            "assignee_key_stats": assignee_key_stats,
            "assigned_users_top": assigned_users_top,
            "task_sample_keys": sorted(tasks_raw[0].keys()) if tasks_raw else [],
            "task_sample_titles": sample_titles,
        }
    except YougileConfigError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось выполнить debug YouGile: {e!s}",
        ) from e


@app.post("/api/sync")
def sync_from_source(
    db: DbSession,
    date_from: Annotated[
        Optional[date],
        Query(description="Начало периода (включительно)"),
    ] = None,
    date_to: Annotated[
        Optional[date],
        Query(description="Конец периода (включительно)"),
    ] = None,
) -> dict:
    p_from, p_to = _parse_period(date_from, date_to)
    try:
        from app.sync_service import run_sync

        snap = run_sync(db, p_from, p_to)
        return snapshot_to_payload(snap)
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail="Не установлены зависимости для синхронизации. "
            "В каталоге backend выполните: pip install -r requirements.txt",
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
