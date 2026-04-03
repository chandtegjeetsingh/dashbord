from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Annotated, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db, init_db
from app.google_sheets_client import _parse_money, fetch_sheet_rows
from app.kpi_format import snapshot_history_row, snapshot_to_payload
from app.models import DailySnapshot, PeriodDayMetric
from app.period_util import default_period_dates
from app.yougile_client import (
    YougileConfigError,
    _extract_items,
    _norm_text,
    _request_json,
    _task_assignee_ids,
    get_employee_tasks,
)

load_dotenv()
_yougile_employee_default = os.getenv("YOUGILE_EMPLOYEE", "Татьяна Живетьева").strip()
_yougile_employee_id_default = os.getenv("YOUGILE_EMPLOYEE_ID", "").strip()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Дашборд KPI",
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
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/kpi/period-defaults")
def kpi_period_defaults() -> dict[str, str]:
    df, dt = default_period_dates()
    return {"date_from": df.isoformat(), "date_to": dt.isoformat()}


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
    )

    candidates: list[dict] = []
    for r in rows:
        name = str(r.get("B") or "").strip()
        group_raw = str(r.get("C") or "").strip()
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
    top = candidates[:8]
    return {"items": top}


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
    try:
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
    except YougileConfigError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
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
