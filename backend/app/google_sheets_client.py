from __future__ import annotations

import os
import re
from datetime import date
import csv
import json
import time
from datetime import datetime, time as dtime
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import urlopen


def _require_env(name: str) -> str:
    v = os.getenv(name, "").strip()
    if not v:
        raise ValueError(
            f"Не задан env-переменная {name}. "
            "Для автономной работы добавьте её в .env."
        )
    return v


def _parse_sheet_date(value: str) -> date | None:
    """
    Google-таблица: возможны форматы вроде:
    - '01.01.2026 5:00:00'
    - '01.01.2026'
    - '2026-01-01'
    В любом случае возвращаем календарную дату.
    """
    s = str(value).strip()
    if not s:
        return None

    # Формат gviz для DateTime: Date(2026,2,25,15,31,24)
    # Внутри месяц 0-based (0=январь), поэтому +1.
    m_js = re.match(r"^Date\((\d{4}),(\d{1,2}),(\d{1,2})", s)
    if m_js:
        y = int(m_js.group(1))
        mo = int(m_js.group(2)) + 1
        d = int(m_js.group(3))
        try:
            return date(y, mo, d)
        except ValueError:
            return None

    # Быстрый парс dd.mm.yyyy (и игнорируем время после пробела).
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
    if m:
        d = int(m.group(1))
        mo = int(m.group(2))
        y = int(m.group(3))
        return date(y, mo, d)

    # ISO date prefix.
    try:
        if "T" in s and len(s) >= 10:
            return date.fromisoformat(s[:10])
        if len(s) >= 10:
            return date.fromisoformat(s[:10])
    except ValueError:
        return None

    return None


def _parse_money(value: Any) -> float:
    """
    Парсинг суммы в числовое float.
    Поддерживаем типовые варианты: пробелы как разделитель тысяч и запятую как decimal.
    """
    s = str(value).strip()
    if not s:
        return 0.0

    s = s.replace("\xa0", " ").replace(" ", "")

    # Если одновременно есть '.' и ',' — считаем, что '.' это тысячи, ',' это десятичный разделитель.
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s and "." not in s:
        s = s.replace(",", ".")

    # Удаляем всё, кроме цифр, точки и минуса.
    s = re.sub(r"[^0-9.\-]", "", s)
    if not s or s == "-" or s == ".":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _public_sheet_to_values_tsv(sheet_id: str, sheet_name: str) -> list[list[str]]:
    """
    Чтение листа без ключей/авторизации.
    Требуется, чтобы таблица/лист были публично доступны для чтения (или Publish to web).

    Важно: используем `out:tsv`, чтобы избежать проблем с запятыми в числах.
    """
    sheet_name_enc = quote(sheet_name, safe="")
    url = (
        f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq"
        f"?tqx=out:tsv&sheet={sheet_name_enc}"
    )

    with urlopen(url) as resp:
        raw = resp.read().decode("utf-8", errors="replace")

    reader = csv.reader(raw.splitlines(), delimiter="\t")
    return [row for row in reader]


_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _cache_ttl_seconds() -> int:
    try:
        return int(os.getenv("GOOGLE_SHEETS_CACHE_TTL_SECONDS", "120").strip() or "120")
    except ValueError:
        return 120


def _fetch_gviz_json(
    sheet_id: str,
    sheet_name: str,
    *,
    tq: str | None,
    prefer_formatted_for_cols: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Чтение листа публично через gviz/tqx=out:json.

    Возвращает список dict, где ключи — id колонок (например "A", "B", "C", "E"),
    а значения — cell.v или cell.f из ответа.

    prefer_formatted_for_cols — для этих колонок сначала берём cell.f (текст с экрана),
    если выпадающий список/chip отдаёт в v число-индекс, а подпись только в f.
    """
    sheet_name_enc = quote(sheet_name, safe="")
    params: dict[str, str] = {"tqx": "out:json", "sheet": sheet_name}
    if tq:
        params["tq"] = tq
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?{urlencode(params)}"

    with urlopen(url) as resp:
        raw = resp.read().decode("utf-8", errors="replace")

    marker = "google.visualization.Query.setResponse("
    start = raw.find(marker)
    if start < 0:
        raise ValueError("Непредвиденный ответ gviz: не найден setResponse")
    start += len(marker)
    end = raw.rfind(");")
    if end < 0 or end <= start:
        raise ValueError("Непредвиденный ответ gviz: не найден хвост setResponse")

    json_text = raw[start:end].strip()
    data = json.loads(json_text)

    table = data.get("table") or {}
    cols = table.get("cols") or []
    rows = table.get("rows") or []
    col_ids = [str(c.get("id") or "") for c in cols]

    out_rows: list[dict[str, Any]] = []
    for row in rows:
        cells = row.get("c") or []
        d: dict[str, Any] = {}
        for i, col_id in enumerate(col_ids):
            if not col_id:
                continue
            if i >= len(cells):
                continue
            cell = cells[i] or {}
            fmt_cols = prefer_formatted_for_cols or frozenset()
            if col_id in fmt_cols:
                f = cell.get("f")
                v = cell.get("v")
                if isinstance(f, str) and f.strip():
                    d[col_id] = f.strip()
                elif isinstance(v, str) and str(v).strip():
                    d[col_id] = str(v).strip()
                elif v is not None:
                    d[col_id] = v
                else:
                    d[col_id] = f
            elif "v" in cell and cell["v"] is not None:
                d[col_id] = cell.get("v")
            else:
                d[col_id] = cell.get("f")
        out_rows.append(d)

    return out_rows


def fetch_sheet_rows(
    *,
    spreadsheet_id: str,
    sheet_name: str,
    tq: str | None = None,
    prefer_formatted_for_cols: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Возвращает строки листа как список dict по id колонок (A,B,C...).
    Чтение публичное через gviz; таблица должна быть доступна по ссылке для просмотра.
    tq — опциональный запрос Google Visualization Query Language.
    """
    fmt_key = ",".join(sorted(prefer_formatted_for_cols or ()))
    cache_key = f"{spreadsheet_id}::{sheet_name}::{tq or ''}::fmt:{fmt_key}"
    ttl = _cache_ttl_seconds()
    now = time.time()
    cached = _CACHE.get(cache_key)
    if cached and (now - cached[0]) <= ttl:
        return cached[1]

    rows = _fetch_gviz_json(
        spreadsheet_id,
        sheet_name,
        tq=tq,
        prefer_formatted_for_cols=prefer_formatted_for_cols,
    )
    _CACHE[cache_key] = (now, rows)
    return rows


def tq_datetime_range(col: str, p_from: date, p_to: date) -> str:
    """
    Условие для gviz `where` по datetime колонке, включительно.
    Пример: C >= datetime '2026-01-01 00:00:00' and C <= datetime '2026-01-31 23:59:59'
    """
    start = datetime.combine(p_from, dtime.min).strftime("%Y-%m-%d %H:%M:%S")
    end = datetime.combine(p_to, dtime(23, 59, 59)).strftime("%Y-%m-%d %H:%M:%S")
    return f"{col} >= datetime '{start}' and {col} <= datetime '{end}'"


def fetch_sheet_values() -> dict[str, list[dict[str, Any]]]:
    """
    Читает нужные листы из таблицы и возвращает матрицы значений (как в Google UI).
    """
    sheet_id = _require_env("GOOGLE_SHEETS_SPREADSHEET_ID")
    profit_sheet_name = os.getenv("GOOGLE_SHEETS_PROFIT_SHEET_NAME", "прибыльность").strip()
    purchase_sheet_name = os.getenv("GOOGLE_SHEETS_PURCHASE_SHEET_NAME", "Закупка_товары").strip()

    try:
        return {
            # По умолчанию: без фильтра периода, только базовая выборка.
            # Сервис синхронизации может использовать fetch_sheet_rows(...) с tq.
            "profit": fetch_sheet_rows(
                spreadsheet_id=sheet_id,
                sheet_name=profit_sheet_name,
                tq="select A, B, C",
            ),
            "purchase": fetch_sheet_rows(
                spreadsheet_id=sheet_id,
                sheet_name=purchase_sheet_name,
                tq="select B, C, E",
            ),
        }
    except Exception as exc:
        raise ValueError(
            "Не удалось прочитать Google Sheets публично через gviz. "
            "Проверьте, что листы «прибыльность» и «Закупка_товары» доступны для чтения "
            "(Publish to web / anyone with link). Детали: "
            f"{exc!s}"
        ) from exc


__all__ = [
    "date",
    "_parse_money",
    "_parse_sheet_date",
    "fetch_sheet_rows",
    "fetch_sheet_values",
    "tq_datetime_range",
]

