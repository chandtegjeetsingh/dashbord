import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./App.css";

type MonthlyPlanResponse = {
  month: string;
  cost_ratio_plan_percent: number | null;
  delivery_avg_rub_per_kg: number | null;
  logistics_share_plan_percent: number | null;
  shipping_avg_plan_days: number | null;
  tasks_bonus_percent: number | null;
};

/** Оклад и максимум бонуса за задачи (10 % → 5 000 ₽) — константы ТЗ. */
const MONTHLY_SALARY_RUB = 50_000;
const TASKS_BONUS_MAX_RUB = 5_000;
/** Бонус логистики: 1 из 2 показателей выполнен — 4 000 ₽; оба — 12 000 ₽ (факт ≤ план). */
const DELIVERY_LOGISTICS_BONUS_ONE_RUB = 4_000;
const DELIVERY_LOGISTICS_BONUS_BOTH_RUB = 12_000;

const THEME_LIGHT_STORAGE_KEY = "dashboard-theme-light";

function ThemeToggle({
  lightTheme,
  onLightThemeChange,
}: {
  lightTheme: boolean;
  onLightThemeChange: (value: boolean) => void;
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="Тема оформления">
      <span className="theme-toggle__hint" id="theme-toggle-label">
        Тема
      </span>
      <div
        className="theme-toggle__switch"
        role="radiogroup"
        aria-labelledby="theme-toggle-label"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!lightTheme}
          className={`theme-toggle__btn${!lightTheme ? " is-active" : ""}`}
          onClick={() => onLightThemeChange(false)}
        >
          Тёмная
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={lightTheme}
          className={`theme-toggle__btn${lightTheme ? " is-active" : ""}`}
          onClick={() => onLightThemeChange(true)}
        >
          Светлая
        </button>
      </div>
    </div>
  );
}

/** Та же таблица, что по умолчанию у `/api/kpi/delivery-cost-per-kg` (можно заменить в .env). */
const DELIVERY_LOGISTICS_SOURCE_SHEET_URL =
  import.meta.env.VITE_DELIVERY_LOGISTICS_SHEET_URL?.trim() ||
  "https://docs.google.com/spreadsheets/d/1cNLC0WZVIcHJWQbKYbpbedAdxANDze3VV12Op2F1O3E/edit";

const MOYSKLAD_CUSTOMER_ORDERS_URL =
  import.meta.env.VITE_MOYSKLAD_CUSTOMER_ORDERS_URL?.trim() ||
  "https://online.moysklad.ru/app/#customerorder";

type DeliveryCostPerKgResponse = {
  avg_rub_per_kg: number | null;
  rows_used: number;
  rows_in_period: number;
  h_values_count: number;
  logistics_share_percent: number | null;
  sum_h_rub: number;
  sum_e_rub: number;
  sum_g_rub: number;
  period_from: string;
  period_to: string;
};

type AvgShippingDaysResponse = {
  avg_days: number | null;
  orders_shipped: number;
  orders_in_period: number;
  orders_pending: number;
  period_from: string;
  period_to: string;
  source?: string;
  samples?: Array<{
    name: string;
    agent: string;
    created: string;
    shipped_at: string;
    days: number;
  }>;
};

type KpiPayload = {
  message: string | null;
  shipments_sum: number | null;
  cost_shipped_sum: number | null;
  expense_orders_sum: number | null;
  purchase_payments_sum: number | null;
  purchases_sum: number | null;
  raw_material_stock_sum: number | null;
  as_of: string | null;
  snapshot_date: string | null;
  period_from: string | null;
  period_to: string | null;
  sync_error: string | null;
};

type DailyBreakdownDay = {
  date: string;
  shipments: number;
  cost_shipped: number;
  purchases: number;
  raw_material_stock: number;
};

type PeriodMode = "day" | "week" | "month";
type ReorderItem = {
  name: string;
  group: string;
  stock: number;
};
type YougileTask = {
  id: string;
  title: string;
  status: string;
  url: string | null;
  deadline_at: string | null;
  priority: string;
};
type YougileTasksResponse = {
  employee: string;
  items: YougileTask[];
};

function formatRub(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const over10k = Math.abs(n) > 10_000;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: over10k ? 0 : 1,
  }).format(over10k ? Math.round(n) : n);
}

function formatRubPerKg(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(n);
  return `${s}\u00a0/\u00a0кг`;
}

function formatDays(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const label = Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n;
  const formatted =
    typeof label === "number" && !Number.isInteger(label)
      ? label.toFixed(1).replace(".", ",")
      : String(label);
  return `${formatted}\u00a0дн.`;
}

function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits).replace(".", ",")} %`;
}

/** Логистика: факт ≤ план — норма. null — нельзя сравнить. */
function logisticsFactNotWorseThanPlan(
  fact: number | null,
  plan: number | null,
): boolean | null {
  if (
    fact == null ||
    plan == null ||
    Number.isNaN(fact) ||
    Number.isNaN(plan) ||
    !Number.isFinite(fact) ||
    !Number.isFinite(plan)
  ) {
    return null;
  }
  return fact <= plan;
}

function logisticsFactPlanFactColClass(
  ok: boolean | null,
  opts?: { noData?: boolean },
): string {
  const base = "logistics-fact-plan-col logistics-fact-plan-col--fact";
  if (opts?.noData) return `${base} logistics-fact-plan-col--fact-na`;
  if (ok === true) return `${base} logistics-fact-plan-col--fact-ok`;
  if (ok === false) return `${base} logistics-fact-plan-col--fact-warn`;
  return `${base} logistics-fact-plan-col--fact-na`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function formatDateTimeShort(iso: string | null): string {
  if (!iso) return "Без дедлайна";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Без дедлайна";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMillionTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const mln = v / 1_000_000;
  const rounded = Math.round(mln * 10) / 10;
  const text = Number.isInteger(rounded)
    ? String(Math.trunc(rounded))
    : rounded.toFixed(1).replace(".", ",");
  return `${text} млн`;
}

function formatAxisCompact(v: number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(".", ",")} млн`;
  }
  if (Math.abs(n) >= 1000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return `${k.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} тыс`;
  }
  const rounded = Math.round(n * 10) / 10;
  return rounded.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

const DASH_DOT_LOADER_COUNT = 12;

function OilFlaskLoader({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`dash-dot-loader${compact ? " dash-dot-loader--compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Загрузка"
    >
      <div className="dash-dot-loader__ring" aria-hidden="true">
        {Array.from({ length: DASH_DOT_LOADER_COUNT }, (_, i) => (
          <span key={i} className="dash-dot-loader__dot" />
        ))}
      </div>
    </div>
  );
}

/** Один лёгкий индикатор для светлой страницы «План» (без «колбы»). */
function PlanLuxeSpinner() {
  return (
    <div className="plan-luxe-spinner" role="status" aria-label="Загрузка">
      <div className="plan-luxe-spinner__ring" aria-hidden="true" />
    </div>
  );
}

/** Единый заголовок «бонус»: звезда, подпись, градиентная линия. */
function BonusPanelHeader({
  subtitle,
  compact = false,
}: {
  subtitle: string;
  compact?: boolean;
}) {
  return (
    <header
      className={`bonus-panel-header${compact ? " bonus-panel-header--compact" : ""}`}
    >
      <div className="bonus-panel-header__top">
        <span className="bonus-panel-header__star" aria-hidden="true">
          ★
        </span>
        <div className="bonus-panel-header__text">
          <span className="bonus-panel-header__title">Бонус</span>
          <p className="bonus-panel-header__subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="bonus-panel-header__rule" aria-hidden="true" />
    </header>
  );
}

/** Подпись «Бонус N» в карточках вознаграждения — звезда как в bonus-panel-header. */
function HonorariumBonusEyebrow({ label }: { label: string }) {
  return (
    <span className="honorarium-cell__eyebrow honorarium-cell__eyebrow--bonus">
      <span className="honorarium-cell__bonus-star-badge" aria-hidden="true">
        ★
      </span>
      {label}
    </span>
  );
}

/** Заголовок показателя в «Наша цель»: мишень + дротик (вместо звезды). */
function PeriodGoalEyebrow({ label }: { label: string }) {
  return (
    <span className="honorarium-cell__eyebrow honorarium-cell__eyebrow--bonus">
      <span className="period-plan-dart-badge" aria-hidden="true">
        <svg className="period-plan-dart-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="8.75" cy="12" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.15" opacity="0.42" />
          <circle cx="8.75" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="0.95" opacity="0.58" />
          <circle cx="8.75" cy="12" r="1.35" fill="currentColor" opacity="0.82" />
          <path
            d="M12.8 10.5 20.5 12 12.8 13.5 11.4 12.35 16.2 12 11.4 11.65Z"
            fill="currentColor"
            opacity="0.95"
          />
          <path
            d="M11.2 12H8.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinecap="round"
            opacity="0.55"
          />
        </svg>
      </span>
      {label}
    </span>
  );
}

function periodQuery(dateFrom: string, dateTo: string): string {
  return new URLSearchParams({
    date_from: dateFrom,
    date_to: dateTo,
  }).toString();
}

function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Первый и последний день календарного месяца (локальная TZ браузера). Fallback без API. */
function calendarMonthBoundsFromDate(d: Date): { from: string; to: string } {
  const y = d.getFullYear();
  const m = d.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${y}-${pad(m + 1)}-01`,
    to: `${y}-${pad(m + 1)}-${pad(last)}`,
  };
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(base: Date): Date {
  const d = new Date(base);
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return d;
}

function dayWord(n: number): string {
  const a = Math.abs(Math.trunc(n));
  const mod10 = a % 10;
  const mod100 = a % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

/** Совпадение с бэкендом `_reorder_group_key` для фильтра по столбцу C. */
function normalizeReorderGroupKey(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Текст на кнопке: весь хвост после последнего «/». Без слэша — вся строка. */
function shortenReorderCategoryButtonLabel(full: string): string {
  const t = normalizeReorderGroupKey(full);
  if (!t) return full;
  const idx = t.lastIndexOf("/");
  if (idx < 0 || idx >= t.length - 1) return t;
  const tail = t.slice(idx + 1).trim();
  return tail.length > 0 ? tail : t;
}

function reorderCategoryLabelsFromItems(items: ReorderItem[]): string[] {
  const m = new Map<string, string>();
  for (const it of items) {
    const raw = (it.group || "").trim();
    if (!raw) continue;
    const k = normalizeReorderGroupKey(raw);
    if (k) m.set(k, raw.replace(/\u00a0/g, " ").trim());
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b, "ru"));
}

/** Прямой URL API (Vite: `VITE_API_BASE=http://127.0.0.1:8000` в `frontend/.env`) или относительные `/api` через прокси. */
function resolveApiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const raw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? "";
  const base = raw.replace(/\/$/, "");
  return base ? `${base}${url}` : url;
}

/** Один раз читает body как текст, затем JSON — без SyntaxError на пустом ответе. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resolved = resolveApiUrl(url);
  const r = await fetch(resolved, init);
  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      r.ok
        ? `Пустой ответ сервера: ${resolved}`
        : `HTTP ${r.status}: пустой ответ (${resolved}). Запустите API (порт 8000) или задайте VITE_API_BASE.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `Ответ не JSON (${r.status}): ${trimmed.slice(0, 200)}`,
    );
  }
  if (!r.ok) {
    const d = data as { detail?: unknown };
    let msg = `HTTP ${r.status}`;
    if (d && typeof d === "object" && d.detail != null) {
      msg = Array.isArray(d.detail)
        ? d.detail
            .map((x: { msg?: string }) => String(x.msg ?? JSON.stringify(x)))
            .join("; ")
        : String(d.detail);
    } else {
      msg = trimmed.slice(0, 400);
    }
    throw new Error(msg);
  }
  return data as T;
}

type AppRoute = "dashboard" | "plan";

function readAppRoute(): AppRoute {
  const h = window.location.hash;
  if (h.startsWith("#/plan")) return "plan";
  return "dashboard";
}

function readMonthFromHash(): string | null {
  const h = window.location.hash;
  const q = h.indexOf("?");
  if (q < 0) return null;
  const m = new URLSearchParams(h.slice(q + 1)).get("month");
  return m && /^\d{4}-\d{2}$/.test(m) ? m : null;
}

function planMonthIsoFromDateFrom(dateFrom: string): string {
  if (dateFrom && dateFrom.length >= 7) return dateFrom.slice(0, 7);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Строка «План АПРЕЛЬ» для полоски заголовка. */
function formatPlanMonthStrip(ym: string): string {
  const [y, mo] = ym.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return "План";
  }
  const d = new Date(y, mo - 1, 1);
  const monthLong = d.toLocaleDateString("ru-RU", { month: "long" });
  return `План ${monthLong.toLocaleUpperCase("ru-RU")}`;
}

function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() =>
    typeof window !== "undefined" ? readAppRoute() : "dashboard",
  );
  useEffect(() => {
    const onHash = () => setRoute(readAppRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function parseOptionalPlanNumber(raw: string): number | null | "bad" {
  const t = raw.trim();
  if (!t) return null;
  const n = Number.parseFloat(t.replace(",", "."));
  if (Number.isNaN(n)) return "bad";
  return n;
}

/** Заголовок строки: «Март 2026 — плановые показатели». */
function formatPlanMonthRowHeading(ym: string): string {
  const [y, mo] = ym.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return `${ym} — плановые показатели`;
  }
  const d = new Date(y, mo - 1, 1);
  const monthLong = d.toLocaleDateString("ru-RU", { month: "long" });
  const cap =
    monthLong.charAt(0).toLocaleUpperCase("ru-RU") + monthLong.slice(1);
  return `${cap} ${y} — плановые показатели`;
}

type MonthlyPlansSavedPayload = { months: MonthlyPlanResponse[] };

function MonthlyPlansSavedSummary({
  selectedYm,
  onSelectMonth,
  refreshNonce = 0,
  className,
  compact,
  onLoadingChange,
  suppressVisualLoader = false,
}: {
  selectedYm: string;
  onSelectMonth: (ym: string) => void;
  refreshNonce?: number;
  className?: string;
  compact?: boolean;
  onLoadingChange?: (busy: boolean) => void;
  suppressVisualLoader?: boolean;
}) {
  const [rows, setRows] = useState<MonthlyPlanResponse[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onLoadingChange?.(true);
    void fetchJson<MonthlyPlansSavedPayload>("/api/settings/monthly-plans-saved")
      .then((r) => {
        if (cancelled) return;
        setRows(r.months);
        setErr(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Ошибка загрузки списка");
        setRows([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        onLoadingChange?.(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, onLoadingChange]);

  const rootClass = [
    "plan-months-summary",
    compact ? "plan-months-summary--compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass}>
      <p className="plan-months-summary-kicker">
        {compact ? (
          <>
            Только месяцы, для которых в базе сохранён план. Строка — как считается бонус;
            нажмите, чтобы подставить месяц в форму.
          </>
        ) : (
          <>
            Сюда попадают только месяцы, для которых вы хотя бы раз нажали «Сохранить» в этом
            разделе (есть запись в базе). Цифры — итог с учётом общих настроек. Нажмите строку,
            чтобы открыть месяц для правок.
          </>
        )}
      </p>
      {loading ? (
        suppressVisualLoader ? (
          <div className="plan-months-summary-placeholder" aria-hidden="true" />
        ) : (
          <div className="plan-months-summary-loader">
            <OilFlaskLoader compact />
          </div>
        )
      ) : err ? (
        <p className="plan-months-summary-error" role="alert">
          {err}
        </p>
      ) : rows.length === 0 ? (
        <p className="plan-months-summary-empty" role="status">
          Пока нет сохранённых планов по месяцам. Выберите месяц, заполните поля и нажмите
          «Сохранить» — после этого месяц появится в этом списке.
        </p>
      ) : (
        <ul className="plan-months-summary-list" role="list">
          {rows.map((row) => (
            <li key={row.month}>
              <button
                type="button"
                className={`plan-month-row${
                  row.month === selectedYm ? " plan-month-row--current" : ""
                }`}
                onClick={() => onSelectMonth(row.month)}
              >
                <span className="plan-month-row-title">{formatPlanMonthRowHeading(row.month)}</span>
                <span className="plan-month-row-metrics">
                  С/с {formatPercent(row.cost_ratio_plan_percent)} · Доставка{" "}
                  {formatRubPerKg(row.delivery_avg_rub_per_kg)} · Отгрузка{" "}
                  {formatDays(row.shipping_avg_plan_days)} · Задачи{" "}
                  {formatPercent(row.tasks_bonus_percent)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Пароль для входа на страницу «План» (только клиент; API не защищён). */
const PLAN_PAGE_PASSWORD = "Plan";
const PLAN_AUTH_SESSION_KEY = "hz_plan_unlocked";

function readPlanAuthSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(PLAN_AUTH_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function writePlanAuthSession(ok: boolean) {
  try {
    if (ok) sessionStorage.setItem(PLAN_AUTH_SESSION_KEY, "1");
    else sessionStorage.removeItem(PLAN_AUTH_SESSION_KEY);
  } catch {
    /* приватный режим и т.п. */
  }
}

function PlanPasswordGate({ onReloadDashboard }: { onReloadDashboard: () => void }) {
  const [unlocked, setUnlocked] = useState(readPlanAuthSession);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const lockSession = useCallback(() => {
    writePlanAuthSession(false);
    setUnlocked(false);
    setPassword("");
    setAuthError(null);
  }, []);

  const trySubmit = (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (password === PLAN_PAGE_PASSWORD) {
      writePlanAuthSession(true);
      setUnlocked(true);
      setPassword("");
    } else {
      setAuthError("Неверный пароль");
    }
  };

  if (!unlocked) {
    return (
      <div className="dashboard-main">
        <section
          className="panel plan-page-panel plan-auth-gate"
          aria-labelledby="plan-auth-heading"
        >
          <h2 id="plan-auth-heading">Доступ к разделу «План»</h2>
          <p className="plan-auth-lead">
            Введите пароль, чтобы просматривать и редактировать плановые показатели.
          </p>
          <form onSubmit={trySubmit} className="plan-auth-form">
            <label className="plan-page-field">
              <span>Пароль</span>
              <input
                type="password"
                name="plan-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="plan-page-input"
              />
            </label>
            {authError ? (
              <p className="banner" role="alert">
                {authError}
              </p>
            ) : null}
            <div className="plan-page-actions">
              <button type="submit" className="plan-save-btn">
                Войти
              </button>
              <a href="#/" className="plan-back-link">
                ← К дашборду
              </a>
            </div>
          </form>
        </section>
      </div>
    );
  }

  return (
    <PlanSettingsPage
      onReloadDashboard={onReloadDashboard}
      onLockPlanSession={lockSession}
    />
  );
}

function PlanSettingsPage({
  onReloadDashboard,
  onLockPlanSession,
}: {
  onReloadDashboard: () => void;
  onLockPlanSession?: () => void;
}) {
  const [planMonthIso, setPlanMonthIso] = useState(() =>
    readMonthFromHash() ?? planMonthIsoFromDateFrom(""),
  );
  const [pct, setPct] = useState("");
  const [delPlanAvg, setDelPlanAvg] = useState("");
  const [delPlanShipping, setDelPlanShipping] = useState("");
  const [tasksBonusPct, setTasksBonusPct] = useState("0");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [plansListRefresh, setPlansListRefresh] = useState(0);
  const [summaryBusy, setSummaryBusy] = useState(true);
  const planBodyBusy = summaryBusy || loading;

  useEffect(() => {
    const onHash = () => {
      const m = readMonthFromHash();
      if (m) setPlanMonthIso(m);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    setLoading(true);
    const q = new URLSearchParams({ month: planMonthIso }).toString();
    void fetchJson<MonthlyPlanResponse>(`/api/settings/monthly-plan?${q}`)
      .then((mp) => {
        if (mp.cost_ratio_plan_percent != null) setPct(String(mp.cost_ratio_plan_percent));
        else setPct("");
        if (mp.delivery_avg_rub_per_kg != null) {
          setDelPlanAvg(String(mp.delivery_avg_rub_per_kg));
        } else setDelPlanAvg("");
        if (mp.shipping_avg_plan_days != null) {
          setDelPlanShipping(String(mp.shipping_avg_plan_days));
        } else setDelPlanShipping("");
        if (mp.tasks_bonus_percent != null) setTasksBonusPct(String(mp.tasks_bonus_percent));
        else setTasksBonusPct("0");
        setMsg(null);
      })
      .catch((e) => {
        setMsg(e instanceof Error ? e.message : "Ошибка загрузки");
      })
      .finally(() => setLoading(false));
  }, [planMonthIso]);

  const savePlanSettings = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const num = Number.parseFloat(pct.replace(",", "."));
      if (Number.isNaN(num)) throw new Error("План по себестоимости: введите число");
      if (num < 0 || num > 500) throw new Error("План по себестоимости: допустимо 0…500 %");

      const avg = parseOptionalPlanNumber(delPlanAvg);
      if (avg === "bad") {
        throw new Error("Доставка: введите число или оставьте поле пустым для сброса");
      }

      const sh = parseOptionalPlanNumber(delPlanShipping);
      if (sh === "bad") {
        throw new Error("Время отгрузки: введите число или оставьте поле пустым для сброса");
      }
      if (sh != null && (sh < 0 || sh > 365)) {
        throw new Error("Время отгрузки: допустимо 0…365 дн.");
      }

      const rawTasks = tasksBonusPct.trim() || "0";
      const tasksN = Number.parseFloat(rawTasks.replace(",", "."));
      if (Number.isNaN(tasksN)) throw new Error("Бонус за задачи: введите число от 0 до 10");
      if (tasksN < 0 || tasksN > 10) throw new Error("Бонус за задачи: допустимо 0…10 %");

      await fetchJson<MonthlyPlanResponse>("/api/settings/monthly-plan", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: planMonthIso,
          cost_ratio_plan_percent: num,
          delivery_avg_rub_per_kg: avg,
          shipping_avg_plan_days: sh,
          tasks_bonus_percent: tasksN,
        }),
      });
      setPlansListRefresh((n) => n + 1);
      onReloadDashboard();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Не сохранилось");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-main">
      <section className="panel plan-page-panel">
        <h2>Плановые показатели</h2>
        <p className="plan-page-month-strip">{formatPlanMonthStrip(planMonthIso)}</p>
        <label className="plan-page-field plan-page-field--month">
          <span>Месяц планов (YYYY-MM)</span>
          <input
            type="month"
            value={planMonthIso}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              setPlanMonthIso(v);
              window.location.hash = `#/plan?month=${encodeURIComponent(v)}`;
            }}
            className="plan-page-input"
          />
        </label>
        <div
          className={`plan-page-body-stack${planBodyBusy ? " plan-page-body-stack--busy" : ""}`}
        >
          {planBodyBusy ? (
            <div className="plan-page-unified-loader">
              <PlanLuxeSpinner />
            </div>
          ) : null}
          <div className={`plan-page-body-stack-inner${planBodyBusy ? " is-busy" : ""}`}>
            <MonthlyPlansSavedSummary
              selectedYm={planMonthIso}
              onSelectMonth={(ym) => {
                setPlanMonthIso(ym);
                window.location.hash = `#/plan?month=${encodeURIComponent(ym)}`;
              }}
              refreshNonce={plansListRefresh}
              onLoadingChange={setSummaryBusy}
              suppressVisualLoader
            />
            {!loading ? (
              <>
            {msg && (
              <p className="banner" role="alert">
                {msg}
              </p>
            )}
            <h3 className="plan-page-h3">Доля себестоимости к отгрузкам</h3>
            <label className="plan-page-field">
              <span>План, %</span>
              <input
                type="number"
                step="0.01"
                min={0}
                max={500}
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="plan-page-input"
              />
            </label>

            <h3 className="plan-page-h3 plan-page-h3--spaced">Доставка</h3>
            <label className="plan-page-field">
              <span>План: средняя стоимость доставки, ₽/кг</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={delPlanAvg}
                onChange={(e) => setDelPlanAvg(e.target.value)}
                className="plan-page-input"
              />
            </label>
            <label className="plan-page-field plan-page-field--tight">
              <span>План: среднее время отгрузки, дн.</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={365}
                value={delPlanShipping}
                onChange={(e) => setDelPlanShipping(e.target.value)}
                className="plan-page-input"
              />
            </label>

            <h3 className="plan-page-h3 plan-page-h3--spaced">Бонус за задачи</h3>
            <label className="plan-page-field">
              <span>Процент бонуса за задачи и поручения, %</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={10}
                value={tasksBonusPct}
                onChange={(e) => setTasksBonusPct(e.target.value)}
                className="plan-page-input"
              />
            </label>
            <div className="plan-page-actions">
              <button
                type="button"
                className="plan-save-btn"
                onClick={() => void savePlanSettings()}
                disabled={saving}
              >
                {saving ? "Сохранение…" : "Сохранить"}
              </button>
              {onLockPlanSession ? (
                <button
                  type="button"
                  className="plan-lock-session-btn"
                  onClick={onLockPlanSession}
                >
                  Выйти из раздела
                </button>
              ) : null}
              <a href="#/" className="plan-back-link">
                ← К дашборду
              </a>
            </div>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const [lightTheme, setLightTheme] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(THEME_LIGHT_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_LIGHT_STORAGE_KEY, lightTheme ? "1" : "0");
    } catch {
      /* приватный режим */
    }
  }, [lightTheme]);

  const dashboardSurfaceClass = lightTheme ? "dashboard dashboard--light" : "dashboard";

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  /** Календарный месяц для планов и верхних бонусов (по дате «От»). */
  const planMonthIso = useMemo(() => planMonthIsoFromDateFrom(dateFrom), [dateFrom]);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [kpi, setKpi] = useState<KpiPayload | null>(null);
  const [planPercent, setPlanPercent] = useState<number | null>(null);
  const [planDeliveryAvgRubPerKg, setPlanDeliveryAvgRubPerKg] = useState<
    number | null
  >(null);
  const [planShippingAvgDays, setPlanShippingAvgDays] = useState<number | null>(null);
  const [dailyDays, setDailyDays] = useState<DailyBreakdownDay[]>([]);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("month");
  const [reorderItems, setReorderItems] = useState<ReorderItem[]>([]);
  /** Все уникальные категории из столбца C листа (с бэкенда), не только строки «к заказу». */
  const [reorderCategoryLabels, setReorderCategoryLabels] = useState<string[]>([]);
  /** Нормализованные ключи `_reorder_group_key`. */
  const [reorderCategoryFilter, setReorderCategoryFilter] = useState<string[]>([]);
  const [rawMaterialInTransitRub, setRawMaterialInTransitRub] = useState<number | null>(
    null,
  );
  const [rawMaterialInTransitError, setRawMaterialInTransitError] = useState<
    string | null
  >(null);
  const [deliveryAvgRubPerKg, setDeliveryAvgRubPerKg] = useState<number | null>(null);
  const [deliveryRowsInPeriod, setDeliveryRowsInPeriod] = useState(0);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [shippingAvgDays, setShippingAvgDays] = useState<number | null>(null);
  const [shippingOrdersShipped, setShippingOrdersShipped] = useState(0);
  const [shippingOrdersInPeriod, setShippingOrdersInPeriod] = useState(0);
  const [shippingError, setShippingError] = useState<string | null>(null);
  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingIncludeMarketplaces, setShippingIncludeMarketplaces] = useState(false);
  const [yougileTasks, setYougileTasks] = useState<YougileTask[]>([]);
  const [yougileLoading, setYougileLoading] = useState(false);
  const [yougileError, setYougileError] = useState<string | null>(null);
  const [yougileEmployee, setYougileEmployee] = useState("Татьяна Живетьева");
  /** 0…10 % → до 5 000 ₽ на полосе сверху. */
  const [tasksBonusPlanPercent, setTasksBonusPlanPercent] = useState<number | null>(
    null,
  );
  /** Защита от гонок: применяем только ответ самого свежего запроса по диапазону дат. */
  const latestKpiRequestIdRef = useRef(0);
  useEffect(() => {
    void fetchJson<{ date_from: string; date_to: string }>(
      "/api/kpi/period-defaults",
    )
      .then((d) => {
        setDateFrom(d.date_from);
        setDateTo(d.date_to);
        setDefaultsLoaded(true);
      })
      .catch(() => {
        const { from, to } = calendarMonthBoundsFromDate(new Date());
        setDateFrom(from);
        setDateTo(to);
        setDefaultsLoaded(true);
      });
  }, []);

  const loadYougileTasks = useCallback(async () => {
    setYougileLoading(true);
    setYougileError(null);
    try {
      const yt = await fetchJson<YougileTasksResponse>(
        "/api/integrations/yougile/tasks?limit=8",
      );
      setYougileTasks(yt.items || []);
      setYougileEmployee(yt.employee || "Сотрудник");
    } catch (e) {
      setYougileTasks([]);
      setYougileError(
        e instanceof Error ? e.message : "Не удалось загрузить задачи YouGile",
      );
    } finally {
      setYougileLoading(false);
    }
  }, []);

  const reloadShippingKpi = useCallback(
    async (includeMarketplaces: boolean) => {
      if (!dateFrom || !dateTo) return;
      const q = periodQuery(dateFrom, dateTo);
      setShippingLoading(true);
      setShippingError(null);
      try {
        const data = await fetchJson<AvgShippingDaysResponse>(
          `/api/kpi/avg-shipping-days?${q}&${new URLSearchParams({
            include_marketplaces: includeMarketplaces ? "true" : "false",
          }).toString()}`,
        );
        setShippingAvgDays(data.avg_days ?? null);
        setShippingOrdersShipped(data.orders_shipped ?? 0);
        setShippingOrdersInPeriod(data.orders_in_period ?? 0);
        setShippingError(null);
      } catch (e) {
        setShippingAvgDays(null);
        setShippingOrdersShipped(0);
        setShippingOrdersInPeriod(0);
        setShippingError(
          e instanceof Error ? e.message : "Не удалось загрузить время отгрузки",
        );
      } finally {
        setShippingLoading(false);
      }
    },
    [dateFrom, dateTo],
  );

  const loadKpiOnly = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    const requestId = ++latestKpiRequestIdRef.current;
    const q = periodQuery(dateFrom, dateTo);
    setRawMaterialInTransitError(null);
    setDeliveryError(null);
    setShippingError(null);
    const transitP = fetchJson<{ sum_rub: number }>("/api/kpi/raw-material-in-transit")
      .then((x) => ({ ok: true as const, sum: x.sum_rub }))
      .catch((e) => ({
        ok: false as const,
        err: e instanceof Error ? e.message : "Ошибка загрузки «Сырьё в пути»",
      }));
    const ym = planMonthIsoFromDateFrom(dateFrom);
    const monthlyPlanP = fetchJson<MonthlyPlanResponse>(
      `/api/settings/monthly-plan?${new URLSearchParams({ month: ym }).toString()}`,
    )
      .then((x) => ({ ok: true as const, data: x }))
      .catch(() => ({ ok: false as const }));

    const deliveryP = fetchJson<DeliveryCostPerKgResponse>(
      `/api/kpi/delivery-cost-per-kg?${q}`,
    )
      .then((x) => ({ ok: true as const, data: x }))
      .catch((e) => ({
        ok: false as const,
        err:
          e instanceof Error
            ? e.message
            : "Не удалось загрузить стоимость доставки",
      }));

    const shippingP = fetchJson<AvgShippingDaysResponse>(
      `/api/kpi/avg-shipping-days?${q}&${new URLSearchParams({
        include_marketplaces: shippingIncludeMarketplaces ? "true" : "false",
      }).toString()}`,
    )
      .then((x) => ({ ok: true as const, data: x }))
      .catch((e) => ({
        ok: false as const,
        err:
          e instanceof Error
            ? e.message
            : "Не удалось загрузить время отгрузки",
      }));

    const [kc, kd, rr, transitRes, monthlyPlanRes, deliveryRes, shippingRes] =
      await Promise.all([
      fetchJson<KpiPayload>(`/api/kpi/current?${q}`),
      fetchJson<{ days: DailyBreakdownDay[] }>(`/api/kpi/daily-breakdown?${q}`),
      fetchJson<{ items: ReorderItem[]; categories?: string[] }>(
        "/api/kpi/reorder-raw-materials",
      ),
      transitP,
      monthlyPlanP,
      deliveryP,
      shippingP,
    ]);
    if (requestId !== latestKpiRequestIdRef.current) return;
    setKpi(kc);
    setDailyDays(kd.days || []);
    const items = rr.items || [];
    const fromApi = rr.categories ?? [];
    const labels =
      fromApi.length > 0 ? fromApi : reorderCategoryLabelsFromItems(items);
    setReorderItems(items);
    setReorderCategoryLabels(labels);
    const allowedKeys = new Set(labels.map((c) => normalizeReorderGroupKey(c)));
    setReorderCategoryFilter((prev) => prev.filter((k) => allowedKeys.has(k)));
    if (transitRes.ok) {
      setRawMaterialInTransitRub(transitRes.sum);
      setRawMaterialInTransitError(null);
    } else {
      setRawMaterialInTransitRub(null);
      setRawMaterialInTransitError(transitRes.err);
    }
    if (monthlyPlanRes.ok) {
      const mp = monthlyPlanRes.data;
      setPlanPercent(mp.cost_ratio_plan_percent ?? null);
      setPlanDeliveryAvgRubPerKg(mp.delivery_avg_rub_per_kg ?? null);
      setPlanShippingAvgDays(mp.shipping_avg_plan_days ?? null);
      setTasksBonusPlanPercent(mp.tasks_bonus_percent ?? null);
    }
    if (deliveryRes.ok) {
      setDeliveryAvgRubPerKg(deliveryRes.data.avg_rub_per_kg ?? null);
      setDeliveryRowsInPeriod(deliveryRes.data.rows_in_period ?? 0);
      setDeliveryError(null);
    } else {
      setDeliveryAvgRubPerKg(null);
      setDeliveryRowsInPeriod(0);
      setDeliveryError(deliveryRes.err);
    }
    if (shippingRes.ok) {
      setShippingAvgDays(shippingRes.data.avg_days ?? null);
      setShippingOrdersShipped(shippingRes.data.orders_shipped ?? 0);
      setShippingOrdersInPeriod(shippingRes.data.orders_in_period ?? 0);
      setShippingError(null);
    } else {
      setShippingAvgDays(null);
      setShippingOrdersShipped(0);
      setShippingOrdersInPeriod(0);
      setShippingError(shippingRes.err);
    }
  }, [dateFrom, dateTo, shippingIncludeMarketplaces]);

  useEffect(() => {
    if (!defaultsLoaded) return;
    void loadYougileTasks();
  }, [defaultsLoaded, loadYougileTasks]);

  const syncFromSheets = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    const q = periodQuery(dateFrom, dateTo);
    // Сначала показываем снимок из БД (быстро), иначе экран висит на POST /api/sync
    // (Google Sheets может отвечать очень долго).
    try {
      await loadKpiOnly();
    } catch {
      /* ignore */
    }
    try {
      await fetchJson<KpiPayload>(`/api/sync?${q}`, { method: "POST" });
    } catch {
      /* ignore */
    }
    try {
      await loadKpiOnly();
    } catch {
      /* ignore */
    }
  }, [dateFrom, dateTo, loadKpiOnly]);

  useEffect(() => {
    if (!defaultsLoaded || !dateFrom || !dateTo) return;

    // Автосинк при смене диапазона (с debounce).
    const t = window.setTimeout(() => {
      void syncFromSheets();
    }, 450);

    return () => window.clearTimeout(t);
  }, [defaultsLoaded, dateFrom, dateTo, syncFromSheets]);

  const chartDataDaily = useMemo(
    () =>
      dailyDays.map((p) => ({
        ...p,
        label: formatShortDate(p.date),
      })),
    [dailyDays],
  );

  const hasRawMaterialActivity = useMemo(
    () => dailyDays.some((d) => d.raw_material_stock > 0),
    [dailyDays],
  );
  const rawMaterialYAxisDomain = useMemo<[number, number]>(() => {
    const vals = dailyDays
      .map((d) => d.raw_material_stock)
      .filter((v) => Number.isFinite(v) && v > 0);
    if (vals.length === 0) return [0, 100];
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (min === max) {
      const pad = Math.max(1, Math.round(min * 0.05));
      return [Math.max(0, min - pad), max + pad];
    }
    const span = max - min;
    const pad = Math.max(1, Math.round(span * 0.1));
    return [Math.max(0, min - pad), max + pad];
  }, [dailyDays]);

  /** Общая шкала ₽ для отгрузок, себестоимости отгрузок и закупок по дням. */
  const salesMixYAxisDomain = useMemo<[number, number]>(() => {
    const max = Math.max(
      0,
      ...dailyDays.flatMap((d) => [d.shipments, d.cost_shipped, d.purchases]),
    );
    if (max === 0) return [0, 100];
    const pad = Math.max(1, Math.round(max * 0.08));
    return [0, max + pad];
  }, [dailyDays]);

  const displayedReorderItems = useMemo(() => {
    if (reorderCategoryFilter.length === 0) return reorderItems;
    const sel = new Set(reorderCategoryFilter);
    return reorderItems.filter((it) =>
      sel.has(normalizeReorderGroupKey(it.group)),
    );
  }, [reorderItems, reorderCategoryFilter]);

  const toggleReorderCategory = useCallback((labelFromSheet: string) => {
    const k = normalizeReorderGroupKey(labelFromSheet);
    if (!k) return;
    setReorderCategoryFilter((prev) =>
      prev.includes(k) ? prev.filter((c) => c !== k) : [...prev, k],
    );
  }, []);

  const clearReorderCategoryFilter = useCallback(() => {
    setReorderCategoryFilter([]);
  }, []);

  const periodNavLabel = useMemo(() => {
    if (!dateFrom || !dateTo) return "";
    const from = parseIsoDate(dateFrom);
    const to = parseIsoDate(dateTo);
    if (periodMode === "day") {
      return from.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    }
    if (periodMode === "week") {
      return `Неделя, ${from.toLocaleDateString("ru-RU", { day: "numeric" })}-${to.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`;
    }
    return from.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  }, [dateFrom, dateTo, periodMode]);

  const applyPeriodMode = useCallback(
    (mode: PeriodMode, baseIso?: string) => {
      const base = parseIsoDate(baseIso || dateFrom || dateTo || toIsoDate(new Date()));
      if (mode === "day") {
        const iso = toIsoDate(base);
        setDateFrom(iso);
        setDateTo(iso);
      } else if (mode === "week") {
        const start = startOfWeekMonday(base);
        const end = addDays(start, 6);
        setDateFrom(toIsoDate(start));
        setDateTo(toIsoDate(end));
      } else {
        const start = new Date(base.getFullYear(), base.getMonth(), 1);
        const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
        setDateFrom(toIsoDate(start));
        setDateTo(toIsoDate(end));
      }
      setPeriodMode(mode);
    },
    [dateFrom, dateTo],
  );

  const shiftPeriod = useCallback(
    (dir: -1 | 1) => {
      if (!dateFrom || !dateTo) return;
      const from = parseIsoDate(dateFrom);
      if (periodMode === "day") {
        const d = addDays(from, dir);
        const iso = toIsoDate(d);
        setDateFrom(iso);
        setDateTo(iso);
        return;
      }
      if (periodMode === "week") {
        const start = addDays(from, dir * 7);
        const end = addDays(start, 6);
        setDateFrom(toIsoDate(start));
        setDateTo(toIsoDate(end));
        return;
      }
      const shifted = new Date(from.getFullYear(), from.getMonth() + dir, 1);
      const end = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0);
      setDateFrom(toIsoDate(shifted));
      setDateTo(toIsoDate(end));
    },
    [dateFrom, dateTo, periodMode],
  );

  const costRatioFactPercent = useMemo(() => {
    const s = kpi?.shipments_sum;
    const c = kpi?.cost_shipped_sum;
    if (
      s == null ||
      c == null ||
      !Number.isFinite(s) ||
      !Number.isFinite(c) ||
      s <= 0
    ) {
      return null;
    }
    return (c / s) * 100;
  }, [kpi]);

  /** (План% − Факт%) / 100 × сумма отгрузок × 0,2 — как в ТЗ. */
  const costRatioBonusRub = useMemo(() => {
    const s = kpi?.shipments_sum;
    if (
      planPercent == null ||
      costRatioFactPercent == null ||
      s == null ||
      !Number.isFinite(s) ||
      s <= 0
    ) {
      return null;
    }
    return ((planPercent - costRatioFactPercent) / 100) * s * 0.2;
  }, [kpi, planPercent, costRatioFactPercent]);

  /** План выполнен, если факт ≤ план (оба показателя «чем меньше, тем лучше»). */
  const deliveryLogisticsBonusRub = useMemo(() => {
    const pAvg = planDeliveryAvgRubPerKg;
    const fAvg = deliveryAvgRubPerKg;
    const pSh = planShippingAvgDays;
    const fSh = shippingAvgDays;
    const hasAvg =
      pAvg != null && fAvg != null && Number.isFinite(pAvg) && Number.isFinite(fAvg);
    const hasShipping =
      pSh != null && fSh != null && Number.isFinite(pSh) && Number.isFinite(fSh);
    const nApplicable = (hasAvg ? 1 : 0) + (hasShipping ? 1 : 0);
    if (nApplicable === 0) return null;
    const metAvg = hasAvg && fAvg <= pAvg;
    const metShipping = hasShipping && fSh <= pSh;
    const nMet = (metAvg ? 1 : 0) + (metShipping ? 1 : 0);
    if (nMet === 0) return 0;
    if (nApplicable === 2 && nMet === 2) return DELIVERY_LOGISTICS_BONUS_BOTH_RUB;
    return DELIVERY_LOGISTICS_BONUS_ONE_RUB;
  }, [
    planDeliveryAvgRubPerKg,
    planShippingAvgDays,
    deliveryAvgRubPerKg,
    shippingAvgDays,
  ]);

  /** 0…10 % от максимума 5 000 ₽ (линейно). */
  const tasksBonusRubFromPlan = useMemo(() => {
    const p = tasksBonusPlanPercent ?? 0;
    const clamped = Math.min(10, Math.max(0, p));
    return (clamped / 10) * TASKS_BONUS_MAX_RUB;
  }, [tasksBonusPlanPercent]);

  /** Оклад + бонусы (недоступные бонусы в сумме как 0). */
  const compensationTotalRub = useMemo(() => {
    const bc = costRatioBonusRub;
    const bl = deliveryLogisticsBonusRub;
    const nC = bc != null && Number.isFinite(bc) ? bc : 0;
    const nL = bl != null && Number.isFinite(bl) ? bl : 0;
    return MONTHLY_SALARY_RUB + nC + nL + tasksBonusRubFromPlan;
  }, [costRatioBonusRub, deliveryLogisticsBonusRub, tasksBonusRubFromPlan]);

  const tasksBonusPercentLabel = (tasksBonusPlanPercent ?? 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

  /** Для себестоимости к отгрузкам норма та же: факт ≤ план. */
  const costRatioVsPlanOk = useMemo((): boolean | null => {
    if (
      planPercent == null ||
      costRatioFactPercent == null ||
      !Number.isFinite(planPercent) ||
      !Number.isFinite(costRatioFactPercent)
    ) {
      return null;
    }
    return costRatioFactPercent <= planPercent;
  }, [planPercent, costRatioFactPercent]);

  const deliveryAvgVsPlanOk = useMemo(
    () => logisticsFactNotWorseThanPlan(deliveryAvgRubPerKg, planDeliveryAvgRubPerKg),
    [deliveryAvgRubPerKg, planDeliveryAvgRubPerKg],
  );

  const shippingAvgVsPlanOk = useMemo(
    () => logisticsFactNotWorseThanPlan(shippingAvgDays, planShippingAvgDays),
    [shippingAvgDays, planShippingAvgDays],
  );

  const { urgentTasks, overdueTasks } = useMemo(() => {
    const now = Date.now();
    const uniqueOpen = new Map<string, YougileTask>();
    for (const t of yougileTasks) {
      if (t.status.toLowerCase() === "завершена") continue;
      if (!uniqueOpen.has(t.id)) uniqueOpen.set(t.id, t);
    }

    const urgent: YougileTask[] = [];
    const overdue: YougileTask[] = [];
    for (const t of uniqueOpen.values()) {
      if (!t.deadline_at) {
        urgent.push(t);
        continue;
      }
      const ts = new Date(t.deadline_at).getTime();
      if (Number.isFinite(ts) && ts < now) overdue.push(t);
      else urgent.push(t);
    }

    urgent.sort((a, b) => {
      const ad = a.deadline_at
        ? new Date(a.deadline_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      const bd = b.deadline_at
        ? new Date(b.deadline_at).getTime()
        : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });
    overdue.sort(
      (a, b) =>
        new Date(a.deadline_at || "").getTime() -
        new Date(b.deadline_at || "").getTime(),
    );
    return { urgentTasks: urgent, overdueTasks: overdue };
  }, [yougileTasks]);

  if (route === "plan") {
  return (
    <div className={dashboardSurfaceClass}>
      <header className="dash-header">
        <div className="dash-header-inner">
          <div className="topbar">
            <div className="brand">
              <h1>Дашборд хозяйки закромов</h1>
              <p className="brand-tagline">Сырьё · закупки · отгрузки · задачи</p>
            </div>
            <div className="topbar__actions">
              <ThemeToggle lightTheme={lightTheme} onLightThemeChange={setLightTheme} />
              <nav className="dash-nav" aria-label="Разделы">
                <a href="#/" className="dash-nav-link">
                  Дашборд
                </a>
                <a href="#/plan" className="dash-nav-link dash-nav-link--active">
                  План
                </a>
              </nav>
            </div>
          </div>
        </div>
        </header>
        <PlanPasswordGate onReloadDashboard={() => void loadKpiOnly()} />
      </div>
    );
  }

  return (
    <div className={dashboardSurfaceClass}>
      <header className="dash-header">
        <div className="dash-header-inner">
          <div className="topbar">
            <div className="brand">
              <h1>Дашборд хозяйки закромов</h1>
              <p className="brand-tagline">Сырьё · закупки · отгрузки · задачи</p>
            </div>
            <div className="topbar__actions">
              <ThemeToggle lightTheme={lightTheme} onLightThemeChange={setLightTheme} />
              <nav className="dash-nav" aria-label="Разделы">
                <a href="#/" className="dash-nav-link dash-nav-link--active">
                  Дашборд
                </a>
                <a href="#/plan" className="dash-nav-link">
                  План
                </a>
              </nav>
            </div>
          </div>
        </div>
      </header>

      <div className="dashboard-main">
      <section className="filter-bar panel">
        <div className="filter-bar-inner">
        <div className="period-nav panel">
            <div className="period-range">
              <div className="period-range-dates">
              <label className="period-date-field">
                <span>От</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="period-date-input"
                />
              </label>
              <span className="period-range-sep">—</span>
              <label className="period-date-field">
                <span>До</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="period-date-input"
                />
              </label>
              </div>
            </div>
            <div className="period-nav-top">
              <span className="period-nav-label">Период:</span>
              <button type="button" className={`period-mode ${periodMode === "day" ? "active" : ""}`} onClick={() => applyPeriodMode("day")}>дн</button>
              <span className="period-dot">·</span>
              <button type="button" className={`period-mode ${periodMode === "week" ? "active" : ""}`} onClick={() => applyPeriodMode("week")}>нед</button>
              <span className="period-dot">·</span>
              <button type="button" className={`period-mode ${periodMode === "month" ? "active" : ""}`} onClick={() => applyPeriodMode("month")}>мес</button>
            </div>
            <div className="period-nav-main">
              <button type="button" className="period-arrow" onClick={() => shiftPeriod(-1)} aria-label="Предыдущий период">◀</button>
              <span className="period-nav-title">{periodNavLabel}</span>
              <button type="button" className="period-arrow" onClick={() => shiftPeriod(1)} aria-label="Следующий период">▶</button>
            </div>
            <div
              className="honorarium-board period-plan-strip"
              aria-label="План и факт по месяцу даты «От»"
            >
              <header className="honorarium-board__intro">
                <div className="honorarium-board__intro-text">
                  <h3 className="honorarium-board__title">Наша цель</h3>
                </div>
              </header>
              <ul className="honorarium-matrix period-plan-rows">
                <li className="honorarium-cell honorarium-cell--bonus" aria-label="Себестоимость: факт и план">
                  <PeriodGoalEyebrow label="СЕБЕСТОИМОСТЬ" />
                  <p className="honorarium-cell__amount period-plan-amount-block">
                    <span
                      className={[
                        "period-plan-fact",
                        costRatioVsPlanOk === true
                          ? "period-plan-fact--ok"
                          : costRatioVsPlanOk === false
                            ? "period-plan-fact--warn"
                            : "period-plan-fact--na",
                      ].join(" ")}
                      title={
                        costRatioVsPlanOk === true
                          ? "В норме: факт не выше плана"
                          : costRatioVsPlanOk === false
                            ? "Выше плана"
                            : "Недостаточно данных для сравнения"
                      }
                    >
                      {formatPercent(costRatioFactPercent)}
                    </span>
                    <span className="period-plan-sep" aria-hidden="true">
                      /
                    </span>
                    <span className="period-plan-target">{formatPercent(planPercent)}</span>
                  </p>
                  <p className="honorarium-cell__hint">Факт сейчас · цель (план) на месяц</p>
                </li>
                <li className="honorarium-cell honorarium-cell--bonus" aria-label="Стоимость доставки 1 кг: факт и план">
                  <PeriodGoalEyebrow label="ДОСТАВКА 1 КГ" />
                  <p className="honorarium-cell__amount period-plan-amount-block">
                    <span
                      className={[
                        "period-plan-fact",
                        deliveryError
                          ? "period-plan-fact--na"
                          : deliveryAvgVsPlanOk === true
                            ? "period-plan-fact--ok"
                            : deliveryAvgVsPlanOk === false
                              ? "period-plan-fact--warn"
                              : "period-plan-fact--na",
                      ].join(" ")}
                      title={
                        deliveryError
                          ? deliveryError
                          : deliveryAvgVsPlanOk === true
                            ? "В норме: факт не выше плана"
                            : deliveryAvgVsPlanOk === false
                              ? "Выше плана"
                              : "Недостаточно данных для сравнения"
                      }
                    >
                      {deliveryError ? "—" : formatRubPerKg(deliveryAvgRubPerKg)}
                    </span>
                    <span className="period-plan-sep" aria-hidden="true">
                      /
                    </span>
                    <span className="period-plan-target">
                      {formatRubPerKg(planDeliveryAvgRubPerKg)}
                    </span>
                  </p>
                  <p className="honorarium-cell__hint">Факт сейчас · цель (план) на месяц</p>
                </li>
                <li className="honorarium-cell honorarium-cell--bonus" aria-label="Среднее время отгрузки: факт и план">
                  <PeriodGoalEyebrow label="ВРЕМЯ ОТГРУЗКИ" />
                  <p className="honorarium-cell__amount period-plan-amount-block">
                    <span
                      className={[
                        "period-plan-fact",
                        shippingError
                          ? "period-plan-fact--na"
                          : shippingAvgVsPlanOk === true
                            ? "period-plan-fact--ok"
                            : shippingAvgVsPlanOk === false
                              ? "period-plan-fact--warn"
                              : "period-plan-fact--na",
                      ].join(" ")}
                      title={
                        shippingError
                          ? shippingError
                          : shippingAvgVsPlanOk === true
                            ? "В норме: факт не выше плана"
                            : shippingAvgVsPlanOk === false
                              ? "Выше плана"
                              : "Недостаточно данных для сравнения"
                      }
                    >
                      {shippingError ? "—" : formatDays(shippingAvgDays)}
                    </span>
                    <span className="period-plan-sep" aria-hidden="true">
                      /
                    </span>
                    <span className="period-plan-target">
                      {formatDays(planShippingAvgDays)}
                    </span>
                  </p>
                  <p className="honorarium-cell__hint">Факт сейчас · цель (план) на месяц</p>
                </li>
                <li className="honorarium-cell honorarium-cell--bonus" aria-label="Задачи: план по бонусу">
                  <PeriodGoalEyebrow label="ЗАДАЧИ" />
                  <p
                    className="honorarium-cell__amount period-plan-amount-block period-plan-amount--tasks"
                    title={`Максимум по плану: ${formatRub(tasksBonusRubFromPlan)}; автооценка задач не считается`}
                  >
                    <span className="period-plan-target">
                      {tasksBonusPercentLabel}% из 10%
                    </span>
                  </p>
                  <p className="honorarium-cell__hint">Порог бонуса из раздела «План»</p>
                </li>
              </ul>
            </div>
          </div>
          <div className="filter-bar-plan-column">
          <section className="honorarium-board" aria-label="Оклад, бонусы и итого">
            <header className="honorarium-board__intro">
              <div className="honorarium-board__intro-text">
                <h3 className="honorarium-board__title">Вознаграждение</h3>
              </div>
            </header>

            <div className="honorarium-matrix" role="list">
              <article
                className="honorarium-cell honorarium-cell--salary"
                aria-label="Оклад"
                role="listitem"
              >
                <span className="honorarium-cell__eyebrow">База</span>
                <p className="honorarium-cell__amount">{formatRub(MONTHLY_SALARY_RUB)}</p>
                <p className="honorarium-cell__hint">Фиксированно за период</p>
              </article>

              <article
                className="honorarium-cell honorarium-cell--bonus honorarium-cell--tone-emerald"
                aria-label="Бонус за долю себестоимости к отгрузкам"
                role="listitem"
              >
                <HonorariumBonusEyebrow label='Бонус "СЕБЕСТОИМОСТЬ"' />
                <p className="honorarium-cell__amount">{formatRub(costRatioBonusRub)}</p>
                <p className="honorarium-cell__hint">
                  (План − Факт) / 100 × сумма отгрузок × 0,2
                </p>
              </article>

              <article
                className="honorarium-cell honorarium-cell--bonus honorarium-cell--tone-violet"
                aria-label="Бонус за доставку"
                role="listitem"
              >
                <HonorariumBonusEyebrow label='Бонус "ЛОГИСТИКА"' />
                <p className="honorarium-cell__amount">{formatRub(deliveryLogisticsBonusRub)}</p>
                <p className="honorarium-cell__hint">
                  {`1 из 2 — ${formatRub(DELIVERY_LOGISTICS_BONUS_ONE_RUB)} · оба — ${formatRub(DELIVERY_LOGISTICS_BONUS_BOTH_RUB)} при факт ≤ план`}
                </p>
              </article>

              <article
                className="honorarium-cell honorarium-cell--bonus honorarium-cell--tone-sky"
                aria-label="Бонус за задачи и поручения"
                role="listitem"
              >
                <HonorariumBonusEyebrow label='Бонус "ЗАДАЧИ"' />
                <p className="honorarium-cell__amount">{formatRub(tasksBonusRubFromPlan)}</p>
                <p className="honorarium-cell__hint">
                  {tasksBonusPercentLabel}% из 10% (макс. 5&nbsp;000 ₽) · план {planMonthIso}
                </p>
              </article>
            </div>

            <article className="honorarium-foot" aria-label="Итого: оклад и все бонусы">
              <div className="honorarium-foot__total">
                <span className="honorarium-foot__total-label">Итого</span>
                <p className="honorarium-foot__total-sum">{formatRub(compensationTotalRub)}</p>
                <p className="honorarium-foot__total-note">Сумма строк слева</p>
              </div>
            </article>
          </section>
            </div>
        </div>
      </section>

      <section className="yougile-strip panel" aria-label="Задачи YouGile">
          <aside className="yougile-widget panel">
            <h3>Задачи YouGile: {yougileEmployee}</h3>
            {yougileLoading ? (
              <div className="yougile-loader-wrap">
                <OilFlaskLoader compact />
              </div>
            ) : yougileError ? (
              <p className="sub">{yougileError}</p>
            ) : yougileTasks.length > 0 ? (
              <div className="yougile-columns">
                <section className="yougile-col">
                  <h4>Задачи (по дедлайну)</h4>
                  {urgentTasks.length > 0 ? (
                    <ul className="yougile-list">
                      {urgentTasks.map((t) => (
                        <li key={`u-${t.id}`}>
                          <div className="yougile-task-main">
                            {t.url ? (
                              <a href={t.url} target="_blank" rel="noopener noreferrer">
                                {t.title}
                              </a>
                            ) : (
                              <span>{t.title}</span>
                            )}
                            <small>{formatDateTimeShort(t.deadline_at)}</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sub">Нет задач с дедлайном.</p>
                  )}
                </section>
                <section className="yougile-col yougile-col-overdue">
                  <h4>Просроченные</h4>
                  {overdueTasks.length > 0 ? (
                    <ul className="yougile-list">
                      {overdueTasks.map((t) => (
                        <li key={`i-${t.id}`}>
                          <div className="yougile-task-main">
                            {t.url ? (
                              <a href={t.url} target="_blank" rel="noopener noreferrer">
                                {t.title}
                              </a>
                            ) : (
                              <span>{t.title}</span>
                            )}
                            <small>{formatDateTimeShort(t.deadline_at)}</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sub">Нет просроченных задач.</p>
                  )}
                </section>
              </div>
            ) : (
              <p className="sub">Активных задач не найдено.</p>
            )}
          </aside>
      </section>

      {kpi !== null && (
        <section className="panel sales-hero-panel">
          <h2 className="sales-hero-heading">Продажи - себестоимость - закупки</h2>
          <div className="sales-hero-row">
            <div className="sales-hero-kpi-slot">
              <div className="sales-hero-kpi-stack">
                <div className="kpi-card kpi-card-compact sales-hero-kpi-tile sales-hero-kpi-tile--ship">
                  <p className="value">{formatRub(kpi.shipments_sum)}</p>
                  <p className="label">Отгрузки, итого</p>
                </div>
                <div className="kpi-card kpi-card-compact sales-hero-kpi-tile sales-hero-kpi-tile--cost">
                  <p className="value">{formatRub(kpi.cost_shipped_sum)}</p>
                  <p className="label">Себестоимость отгрузок</p>
                </div>
                <div className="kpi-card kpi-card-compact sales-hero-kpi-tile sales-hero-kpi-tile--purch">
                  <p className="value">{formatRub(kpi.purchases_sum)}</p>
                  <p className="label">Закупки, итого</p>
                </div>
              </div>
            </div>
            <div className="sales-hero-chart-wrap chart-surface">
            {chartDataDaily.length === 0 ? (
              <p className="empty-hint sales-hero-chart-empty">Нет данных по дням</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartDataDaily}
                  margin={{ top: 36, right: 16, left: 2, bottom: 6 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 4"
                    stroke="var(--chart-grid)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    interval="preserveStartEnd"
                    minTickGap={10}
                    tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
                    axisLine={{ stroke: "var(--chart-axis-line)" }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={salesMixYAxisDomain}
                    tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                    tickCount={6}
                    tickFormatter={(v) => formatAxisCompact(v as number)}
                  />
                  <Legend
                    verticalAlign="top"
                    align="center"
                    iconType="plainline"
                    iconSize={14}
                    wrapperStyle={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "var(--chart-axis)",
                      paddingTop: "2px",
                      paddingBottom: "2px",
                    }}
                  />
                  <Tooltip
                    formatter={(value: number | string, name: string) => [
                      formatRub(typeof value === "number" ? value : Number(value)),
                      name,
                    ]}
                    labelFormatter={(_label, items) => {
                      const raw = items?.[0]?.payload?.date;
                      return raw
                        ? new Date(String(raw) + "T12:00:00").toLocaleDateString(
                            "ru-RU",
                            {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                            },
                          )
                        : "";
                    }}
                    contentStyle={{
                      borderRadius: 12,
                      border: "var(--chart-tooltip-border)",
                      background: "var(--chart-tooltip-bg)",
                      color: "var(--chart-tooltip-color)",
                      boxShadow: "var(--chart-tooltip-shadow)",
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--chart-tooltip-label)" }}
                    itemStyle={{ color: "var(--chart-tooltip-item)" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="shipments"
                    name="Отгрузки"
                    stroke="#34d399"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    dot={{ r: 0 }}
                    activeDot={{ r: 5, strokeWidth: 0, fill: "#5eead4" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="cost_shipped"
                    name="Себестоимость"
                    stroke="#fb923c"
                    strokeWidth={2}
                    strokeLinecap="round"
                    dot={{ r: 0 }}
                    activeDot={{ r: 5, strokeWidth: 0, fill: "#fdba74" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="purchases"
                    name="Закупки"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    strokeLinecap="round"
                    dot={{ r: 0 }}
                    activeDot={{ r: 5, strokeWidth: 0, fill: "#c4b5fd" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            </div>
          </div>
        </section>
      )}

      {kpi?.sync_error && (
        <div className="banner banner-warn" role="status">
          В последнем снимке была ошибка: {kpi.sync_error}
        </div>
      )}

      {!kpi ? (
        <div className="loading-center">
          <OilFlaskLoader />
        </div>
      ) : (
        <>
          <div className="main-dashboard-grid">
            <div className="main-dashboard-primary-col">
            <section className="panel finance-panel hero-panel">
              <header className="finance-block-head">
                <div>
                  <h2 className="finance-block-title">Себестоимость</h2>
                </div>
              </header>

              <div className="finance-pfb" aria-label="План, факт и бонус">
                <div className="finance-pfb-grid">
                  <article
                    className="finance-pfb-duo"
                    aria-label="Факт и план: доля себестоимости к отгрузкам"
                  >
                    <div className="finance-pfb-duo-inner">
                      <div
                        className={[
                          "finance-pfb-half finance-pfb-half--fact",
                          costRatioVsPlanOk === true
                            ? "finance-pfb-half--fact-ok"
                            : costRatioVsPlanOk === false
                              ? "finance-pfb-half--fact-warn"
                              : "finance-pfb-half--fact-na",
                        ].join(" ")}
                      >
                        <span className="finance-pfb-badge">Факт</span>
                        <p className="finance-pfb-role-label">Выполнение за период</p>
                        <p className="finance-pfb-value">{formatPercent(costRatioFactPercent)}</p>
                        <p className="finance-pfb-caption">
                          Себестоимость отгрузок / сумма отгрузок × 100%
                        </p>
                      </div>
                      <div className="finance-pfb-duo-divider" aria-hidden="true" />
                      <div className="finance-pfb-half finance-pfb-half--plan">
                        <span className="finance-pfb-badge">План</span>
                        <p className="finance-pfb-role-label">Целевой показатель</p>
                        <p className="finance-pfb-value">{formatPercent(planPercent)}</p>
                        <p className="finance-pfb-caption">
                          Целевая доля с/с к отгрузкам (месяц по дате «От»)
                        </p>
                      </div>
                    </div>
                  </article>
                  <article className="finance-pfb-tile finance-pfb-tile--bonus finance-pfb-tile--bonus-star">
                    <BonusPanelHeader subtitle="За выполнение плана по доле себестоимости к отгрузкам" />
                    <p className="finance-pfb-value finance-pfb-value--rub">
                      {formatRub(costRatioBonusRub)}
                    </p>
                  </article>
                </div>
              </div>
            </section>

            <section
              className="delivery-cost-strip panel logistics-block logistics-block--framed"
              aria-label="Логистика: доставка и закупки"
            >
              <header className="logistics-block-head">
                <div className="logistics-block-head-accent" aria-hidden="true" />
                <div className="logistics-block-head-inner">
                  <h2 className="logistics-block-title">Логистика</h2>
                </div>
              </header>
              <div className="logistics-with-procurement">
                <>
                    <div className="logistics-left-column">
                    <div className="logistics-band logistics-band--fact">
                      <div className="logistics-band-cards">
                        <article className="delivery-cost-card delivery-cost-card--metric delivery-cost-card--nested delivery-cost-card--delivery delivery-cost-card--fact-plan logistics-metric-card">
                          <div className="logistics-mini-card-head">
                            <h4 className="logistics-mini-card-title">Средняя стоимость доставки</h4>
                            <a
                              className="logistics-mini-card-sheet-link"
                              href={DELIVERY_LOGISTICS_SOURCE_SHEET_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Таблица ↗
                            </a>
                          </div>
                          {deliveryError ? (
                            <p
                              className="delivery-cost-error delivery-cost-error--span"
                              role="alert"
                            >
                              {deliveryError}
                            </p>
                          ) : (
                            <>
                          <div className="logistics-mini-card-body">
                          <div className="logistics-fact-plan-split">
                            <div
                              className={logisticsFactPlanFactColClass(
                                logisticsFactNotWorseThanPlan(
                                  deliveryAvgRubPerKg,
                                  planDeliveryAvgRubPerKg,
                                ),
                                { noData: Boolean(deliveryError) },
                              )}
                              title={
                                deliveryError
                                  ? deliveryError
                                  : deliveryAvgVsPlanOk === true
                                    ? "Факт не выше плана"
                                    : deliveryAvgVsPlanOk === false
                                      ? "Факт выше плана"
                                      : "Недостаточно данных для сравнения"
                              }
                            >
                              <span className="logistics-fact-plan-tag">Факт</span>
                              <p className="logistics-fact-plan-role">Сумма H ÷ сумма G</p>
                              <p className="delivery-cost-value logistics-fact-plan-value logistics-fact-plan-value--in-cell">
                                {formatRubPerKg(deliveryAvgRubPerKg)}
                              </p>
                            </div>
                            <div className="logistics-fact-plan-col logistics-fact-plan-col--plan">
                              <span className="logistics-fact-plan-tag logistics-fact-plan-tag--plan">
                                План
                              </span>
                              <p className="logistics-fact-plan-role logistics-fact-plan-role--plan">
                                Целевой показатель
                              </p>
                              <p className="delivery-cost-value delivery-cost-value--plan-compact logistics-fact-plan-value--in-cell">
                                {formatRubPerKg(planDeliveryAvgRubPerKg)}
                              </p>
                            </div>
                          </div>
                          </div>
                          <footer className="logistics-mini-card-foot">
                          <p className="delivery-cost-meta">
                            {deliveryAvgRubPerKg != null && deliveryRowsInPeriod > 0
                              ? `ΣH / ΣG за период · ${deliveryRowsInPeriod} строк с датой в F`
                              : deliveryRowsInPeriod > 0
                                ? "Сумма G за период равна нулю — нельзя посчитать ₽/кг"
                                : "Нет строк с датой в F в выбранном периоде"}
                          </p>
                          <div className="logistics-mini-card-foot-slot" aria-hidden="true" />
                          </footer>
                            </>
                          )}
                        </article>
                        <article
                          className={`delivery-cost-card delivery-cost-card--metric delivery-cost-card--nested delivery-cost-card--shipping delivery-cost-card--fact-plan logistics-metric-card${shippingLoading ? " logistics-metric-card--busy" : ""}`}
                          aria-busy={shippingLoading}
                        >
                          <div className="logistics-mini-card-head">
                            <h4 className="logistics-mini-card-title">Среднее время отгрузки</h4>
                            <a
                              className="logistics-mini-card-sheet-link"
                              href={MOYSKLAD_CUSTOMER_ORDERS_URL}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              МойСклад ↗
                            </a>
                          </div>
                          {shippingError ? (
                            <p
                              className="delivery-cost-error delivery-cost-error--span"
                              role="alert"
                            >
                              {shippingError}
                            </p>
                          ) : (
                            <>
                              <div className="logistics-mini-card-body">
                              <div className="logistics-fact-plan-split">
                                <div
                                  className={logisticsFactPlanFactColClass(
                                    logisticsFactNotWorseThanPlan(
                                      shippingAvgDays,
                                      planShippingAvgDays,
                                    ),
                                    { noData: Boolean(shippingError) },
                                  )}
                                  title={
                                    shippingError
                                      ? shippingError
                                      : shippingAvgVsPlanOk === true
                                        ? "Факт не выше плана"
                                        : shippingAvgVsPlanOk === false
                                          ? "Факт выше плана"
                                          : "Недостаточно данных для сравнения"
                                  }
                                >
                                  <span className="logistics-fact-plan-tag">Факт</span>
                                  <p className="logistics-fact-plan-role">МойСклад · created → отгрузка</p>
                                  <p className="delivery-cost-value logistics-fact-plan-value logistics-fact-plan-value--in-cell">
                                    {shippingLoading ? "…" : formatDays(shippingAvgDays)}
                                  </p>
                                </div>
                                <div className="logistics-fact-plan-col logistics-fact-plan-col--plan">
                                  <span className="logistics-fact-plan-tag logistics-fact-plan-tag--plan">
                                    План
                                  </span>
                                  <p className="logistics-fact-plan-role logistics-fact-plan-role--plan">
                                    Целевой показатель
                                  </p>
                                  <p className="delivery-cost-value delivery-cost-value--plan-compact logistics-fact-plan-value--in-cell">
                                    {formatDays(planShippingAvgDays)}
                                  </p>
                                </div>
                              </div>
                              </div>
                              <footer className="logistics-mini-card-foot">
                              <p className="delivery-cost-meta">
                                {shippingLoading
                                  ? "Пересчёт по заказам МойСклад…"
                                  : shippingOrdersInPeriod > 0
                                    ? shippingOrdersShipped > 0
                                      ? `${shippingOrdersShipped} отгружено из ${shippingOrdersInPeriod} заказов покупателей за период`
                                      : `${shippingOrdersInPeriod} заказов за период — отгрузок пока нет`
                                    : "Нет заказов покупателей в МойСклад за выбранный период"}
                              </p>
                              <label className="logistics-shipping-marketplace-toggle">
                                <input
                                  type="checkbox"
                                  checked={shippingIncludeMarketplaces}
                                  disabled={shippingLoading}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setShippingIncludeMarketplaces(checked);
                                    void reloadShippingKpi(checked);
                                  }}
                                />
                                <span>вместе с заказами с маркетплейсов</span>
                              </label>
                              </footer>
                            </>
                          )}
                        </article>
                      </div>
                      <article
                        className="finance-pfb-tile finance-pfb-tile--bonus finance-pfb-tile--bonus-star logistics-bonus-as-finance-tile"
                        aria-label="Бонус логистики за период"
                      >
                        <BonusPanelHeader subtitle="За выполнение плана по доставке и среднему времени отгрузки" />
                        <p className="finance-pfb-value finance-pfb-value--rub">
                          {formatRub(deliveryLogisticsBonusRub)}
                        </p>
                        <p className="finance-pfb-caption logistics-bonus-footnote">
                          1 из 2 по плану — {formatRub(DELIVERY_LOGISTICS_BONUS_ONE_RUB)}
                          <br />
                          оба — {formatRub(DELIVERY_LOGISTICS_BONUS_BOTH_RUB)} (факт ≤ план)
                        </p>
                      </article>
                    </div>
                    </div>

                    <aside
                      className="logistics-reorder-aside"
                      aria-label="Заказать сырьё"
                    >
                      <div className="kpi-card kpi-card-list reorder-card logistics-reorder-card">
                        <div className="reorder-card-title-row">
                          <p className="list-title">Заказать сырьё</p>
                          <a
                            className="reorder-sheet-link"
                            href="https://docs.google.com/spreadsheets/d/1eUdgokEoZ72xePF8RmQZbuWwoYNuJH9rvU3WvUxBTEE/edit?gid=1246024051#gid=1246024051"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Таблица ↗
                          </a>
                        </div>
                        {reorderCategoryLabels.length > 0 ? (
                          <div
                            className="reorder-category-toolbar"
                            role="group"
                            aria-label="Фильтр по группе из столбца «Группа»"
                          >
                            <div className="reorder-category-filters">
                              {reorderCategoryLabels.map((label) => {
                                const key = normalizeReorderGroupKey(label);
                                const active = reorderCategoryFilter.includes(key);
                                return (
                                  <button
                                    type="button"
                                    key={key}
                                    className={`reorder-category-btn${active ? " reorder-category-btn--active" : ""}`}
                                    aria-pressed={active}
                                    title={label}
                                    onClick={() => {
                                      toggleReorderCategory(label);
                                    }}
                                  >
                                    {shortenReorderCategoryButtonLabel(label)}
                                  </button>
                                );
                              })}
                            </div>
                            {reorderCategoryFilter.length > 0 ? (
                              <button
                                type="button"
                                className="reorder-category-clear"
                                onClick={clearReorderCategoryFilter}
                              >
                                Сбросить фильтр
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="reorder-list-panel">
                          <div className="kpi-list-head">
                            <span>Наименование</span>
                            <span>Хватит на</span>
                          </div>
                          {displayedReorderItems.length > 0 ? (
                            <ul className="kpi-list">
                              {displayedReorderItems.map((it) => (
                                <li key={`${(it.group || "").trim()}\t${it.name}`}>
                                  <span>{it.name}</span>
                                  <strong>
                                    {it.stock.toLocaleString("ru-RU", {
                                      minimumFractionDigits: 0,
                                      maximumFractionDigits: 1,
                                    })}{" "}
                                    {dayWord(it.stock)}
                                  </strong>
                                </li>
                              ))}
                            </ul>
                          ) : reorderItems.length > 0 ? (
                            <p className="sub">Нет позиций в выбранных категориях.</p>
                          ) : (
                            <p className="sub">Нет позиций для заказа.</p>
                          )}
                        </div>
                      </div>
                    </aside>
                </>
              </div>
            </section>
            </div>
          </div>

          <section className="panel raw-materials-panel">
            <h2 className="raw-materials-panel-title">Сырьё на складе и в пути</h2>
            <div className="raw-stock-line">
              <div className="raw-stock-kpis-column">
                <div className="kpi-card kpi-card-compact raw-stock-tile">
                  <p className="value">{formatRub(kpi?.raw_material_stock_sum ?? null)}</p>
                  <p className="label">Остаток сырья на складе</p>
                </div>
                <div className="kpi-card kpi-card-compact raw-stock-tile">
                  <p className="value">{formatRub(rawMaterialInTransitRub)}</p>
                  <p className="label">Сырьё в пути</p>
                  {rawMaterialInTransitError ? (
                    <p className="raw-stock-tile-error" role="alert">
                      {rawMaterialInTransitError}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="raw-stock-mini panel">
                <h3 className="raw-stock-chart-title">Остаток сырья по дням</h3>
                {chartDataDaily.length === 0 ? (
                  <p className="empty-hint">Укажите период «от — до».</p>
                ) : (
                  <>
                    {!hasRawMaterialActivity && (
                      <p className="empty-hint chart-hint">
                        Пока нет данных по остаткам сырья за выбранный период.
                      </p>
                    )}
                    <div className="chart-h chart-h-raw-stock chart-h-lines chart-surface">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={chartDataDaily}
                          margin={{ top: 12, right: 16, left: 20, bottom: 14 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 4"
                            stroke="var(--chart-grid)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="label"
                            interval="preserveStartEnd"
                            minTickGap={22}
                            tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
                            axisLine={{ stroke: "var(--chart-axis-line)" }}
                            tickLine={false}
                            tickMargin={8}
                          />
                          <YAxis
                            domain={rawMaterialYAxisDomain}
                            tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => formatMillionTick(v as number)}
                            tickMargin={8}
                            width={68}
                          />
                          <Tooltip
                            formatter={(value: number) => formatRub(value)}
                            labelFormatter={(_label, items) => {
                              const raw = items?.[0]?.payload?.date;
                              return raw
                                ? new Date(String(raw) + "T12:00:00").toLocaleDateString(
                                    "ru-RU",
                                    {
                                      weekday: "short",
                                      day: "numeric",
                                      month: "short",
                                    },
                                  )
                                : "";
                            }}
                            contentStyle={{
                              borderRadius: 12,
                              border: "var(--chart-tooltip-border)",
                              background: "var(--chart-tooltip-bg)",
                              color: "var(--chart-tooltip-color)",
                              boxShadow: "var(--chart-tooltip-shadow)",
                              fontSize: 12,
                            }}
                            labelStyle={{ color: "var(--chart-tooltip-label)" }}
                            itemStyle={{ color: "var(--chart-tooltip-item)" }}
                          />
                          <Line
                            type="monotone"
                            dataKey="raw_material_stock"
                            name="Остаток сырья"
                            stroke="#4ade80"
                            strokeWidth={3}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            dot={{ r: 2, strokeWidth: 0, fill: "#4ade80" }}
                            activeDot={{ r: 6, strokeWidth: 0, fill: "#86efac" }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>

        </>
      )}
      </div>
    </div>
  );
}
