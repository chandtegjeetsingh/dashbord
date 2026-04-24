import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
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
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(n);
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
    return `${Math.round(n / 1000)} тыс`;
  }
  return String(Math.round(n));
}

function OilFlaskLoader({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`oil-loader ${compact ? "compact" : ""}`} aria-live="polite">
      <div className="oil-loader-drops" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="oil-flask" aria-hidden="true">
        <div className="oil-fill" />
        <div className="oil-flask-marks" aria-hidden="true">
          <span className="oil-flask-tick oil-flask-tick-high" />
          <span className="oil-flask-tick oil-flask-tick-low" />
        </div>
      </div>
    </div>
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

/** Один раз читает body как текст, затем JSON — без SyntaxError на пустом ответе. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      r.ok
        ? `Пустой ответ сервера: ${url}`
        : `HTTP ${r.status}: пустой ответ (${url}). Проверьте, что API запущен и прокси Vite указывает на порт 8000.`,
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

export default function App() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [kpi, setKpi] = useState<KpiPayload | null>(null);
  const [dailyDays, setDailyDays] = useState<DailyBreakdownDay[]>([]);
  const [syncDetail, setSyncDetail] = useState<string | null>(null);
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
  const [yougileTasks, setYougileTasks] = useState<YougileTask[]>([]);
  const [yougileLoading, setYougileLoading] = useState(false);
  const [yougileError, setYougileError] = useState<string | null>(null);
  const [yougileEmployee, setYougileEmployee] = useState("Татьяна Живетьева");
  const chartGradKey = `cg${useId().replace(/:/g, "")}`;

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
        const t = new Date();
        const from = addDays(t, -29);
        setDateFrom(from.toISOString().slice(0, 10));
        setDateTo(t.toISOString().slice(0, 10));
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

  const loadKpiOnly = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    const q = periodQuery(dateFrom, dateTo);
    setRawMaterialInTransitError(null);
    const transitP = fetchJson<{ sum_rub: number }>("/api/kpi/raw-material-in-transit")
      .then((x) => ({ ok: true as const, sum: x.sum_rub }))
      .catch((e) => ({
        ok: false as const,
        err: e instanceof Error ? e.message : "Ошибка загрузки «Сырьё в пути»",
      }));
    const [kc, kd, rr, transitRes] = await Promise.all([
      fetchJson<KpiPayload>(`/api/kpi/current?${q}`),
      fetchJson<{ days: DailyBreakdownDay[] }>(`/api/kpi/daily-breakdown?${q}`),
      fetchJson<{ items: ReorderItem[]; categories?: string[] }>(
        "/api/kpi/reorder-raw-materials",
      ),
      transitP,
    ]);
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
  }, [dateFrom, dateTo]);

  useEffect(() => {
    if (!defaultsLoaded) return;
    void loadYougileTasks();
  }, [defaultsLoaded, loadYougileTasks]);

  const syncFromSheets = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    setSyncDetail(null);
    const q = periodQuery(dateFrom, dateTo);
    try {
      await fetchJson<KpiPayload>(`/api/sync?${q}`, { method: "POST" });
    } catch (e) {
      setSyncDetail(
        e instanceof Error ? e.message : "Ошибка синхронизации с Google Sheets",
      );
    }
    try {
      await loadKpiOnly();
    } catch (e) {
      setSyncDetail(
        (prev) =>
          prev ??
          (e instanceof Error ? e.message : "Не удалось загрузить KPI"),
      );
    }
  }, [dateFrom, dateTo, loadKpiOnly]);

  useEffect(() => {
    if (!defaultsLoaded || !dateFrom || !dateTo) return;

    // Автосинк при смене диапазона (с debounce).
    const t = window.setTimeout(() => {
      void syncFromSheets().catch((e) => setSyncDetail(String(e)));
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

  const hasDailyActivity = useMemo(
    () =>
      dailyDays.some(
        (d) =>
          d.shipments > 0 ||
          d.cost_shipped > 0 ||
          d.purchases > 0 ||
          d.raw_material_stock > 0,
      ),
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

  const shipmentsYAxisDomain = useMemo<[number, number]>(() => {
    const max = Math.max(0, ...dailyDays.map((d) => d.shipments));
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

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="dash-header-inner">
          <div className="topbar">
            <div className="brand">
              <h1>Дашборд хозяйки закромов</h1>
              <p className="brand-tagline">Сырьё · закупки · отгрузки · задачи</p>
            </div>
          </div>
        </div>
      </header>

      <div className="dashboard-main">
      <section className="filter-bar panel">
        <div className="period-nav panel">
            <div className="period-range">
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
          <h2 className="sales-hero-heading">Продажи (отгрузки)</h2>
          <div className="sales-hero-row">
            <div className="sales-hero-kpi-slot">
              <div className="kpi-card kpi-card-compact sales-hero-kpi">
                <p className="value">{formatRub(kpi.shipments_sum)}</p>
                <p className="label">Итого за период</p>
              </div>
            </div>
            <div className="sales-hero-chart-wrap chart-surface">
            {chartDataDaily.length === 0 ? (
              <p className="empty-hint sales-hero-chart-empty">Нет данных по дням</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartDataDaily}
                  margin={{ top: 14, right: 20, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 4" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    interval="preserveStartEnd"
                    minTickGap={10}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={{ stroke: "#e2e8f0" }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={shipmentsYAxisDomain}
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                    tickCount={6}
                    tickFormatter={(v) => formatAxisCompact(v as number)}
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
                      border: "1px solid #e2e8f0",
                      boxShadow: "0 12px 36px rgba(15,23,42,0.1)",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="shipments"
                    name="Продажи"
                    stroke="#1d4ed8"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    dot={{ r: 0 }}
                    activeDot={{ r: 6, strokeWidth: 0, fill: "#1d4ed8" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            </div>
          </div>
        </section>
      )}

      {syncDetail && (
        <div className="banner" role="alert">
          {syncDetail}
        </div>
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
            <section className="panel finance-panel hero-panel">
              <div className="finance-kpis">
                <div className="kpi-card kpi-card-compact">
                  <p className="value">{formatRub(kpi?.cost_shipped_sum ?? null)}</p>
                  <p className="label">Себестоимость отгрузок</p>
                </div>
                <div className="kpi-card kpi-card-compact">
                  <p className="value">{formatRub(kpi?.purchases_sum ?? null)}</p>
                  <p className="label">Закупки (итого)</p>
                </div>
              </div>
              <h2>Показатели по календарным дням</h2>
              {chartDataDaily.length === 0 ? (
                <p className="empty-hint">Укажите период «от — до».</p>
              ) : (
                <>
                  {!hasDailyActivity && kpi?.message === "no_snapshot" && (
                    <p className="empty-hint chart-hint">
                      Пока нет данных по дням — выполните «Обновить из Google Sheets».
                    </p>
                  )}
                  <div className="chart-h chart-h-lines chart-h-lines--compact chart-surface">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartDataDaily}
                        margin={{ top: 16, right: 20, left: 8, bottom: 12 }}
                      >
                        <defs>
                          <linearGradient id={`${chartGradKey}-cost`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#0f2744" stopOpacity={0.45} />
                            <stop offset="45%" stopColor="#1e40af" stopOpacity={0.15} />
                            <stop offset="100%" stopColor="#f97316" stopOpacity={0.04} />
                          </linearGradient>
                          <linearGradient id={`${chartGradKey}-pur`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f97316" stopOpacity={0.42} />
                            <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 4" stroke="#e2e8f0" vertical={false} />
                        <XAxis
                          dataKey="label"
                          interval="preserveStartEnd"
                          minTickGap={18}
                          tick={{ fontSize: 11, fill: "#64748b" }}
                          axisLine={{ stroke: "#e2e8f0" }}
                          tickLine={false}
                        />
                        <YAxis
                          domain={[0, 300000]}
                          tick={{ fontSize: 11, fill: "#64748b" }}
                          axisLine={false}
                          tickLine={false}
                          tickCount={6}
                          tickFormatter={(v) =>
                            new Intl.NumberFormat("ru-RU", {
                              maximumFractionDigits: 0,
                            }).format(v as number)
                          }
                          width={48}
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
                            border: "1px solid #e2e8f0",
                            boxShadow: "0 16px 48px rgba(15,23,42,0.12)",
                            fontSize: 12,
                          }}
                        />
                        <Legend
                          wrapperStyle={{ fontSize: 13, paddingTop: 12 }}
                          iconType="plainline"
                          iconSize={18}
                        />
                        <Area
                          type="monotone"
                          dataKey="cost_shipped"
                          name="Себестоимость"
                          stroke="#0f2744"
                          strokeWidth={2.5}
                          fill={`url(#${chartGradKey}-cost)`}
                          fillOpacity={1}
                          dot={false}
                          activeDot={{ r: 5, strokeWidth: 0, fill: "#0f2744" }}
                        />
                        <Area
                          type="monotone"
                          dataKey="purchases"
                          name="Закупки"
                          stroke="#ea580c"
                          strokeWidth={2.5}
                          fill={`url(#${chartGradKey}-pur)`}
                          fillOpacity={1}
                          dot={false}
                          activeDot={{ r: 5, strokeWidth: 0, fill: "#ea580c" }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </section>

          <section className="panel procurement-panel">
            <div className="kpi-grid procurement-grid">
              <div className="kpi-card kpi-card-list kpi-card-wide reorder-card">
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
                <p className="reorder-sheet-hint">
                  Если на листе в Google включён фильтр (иконка в шапке столбца), в
                  дашборд попадают только видимые строки — для полного списка снимите
                  фильтр в таблице.
                </p>
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
                            {it.stock.toLocaleString("ru-RU")} {dayWord(it.stock)}
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
            </div>
          </section>
          </div>

          <section className="panel raw-materials-panel">
            <h2 className="raw-materials-panel-title">Сырьё на складе и в пути</h2>
            <div className="raw-stock-line">
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
                          <CartesianGrid strokeDasharray="3 4" stroke="#dbe5f1" vertical={false} />
                          <XAxis
                            dataKey="label"
                            interval="preserveStartEnd"
                            minTickGap={22}
                            tick={{ fontSize: 11, fill: "#64748b" }}
                            axisLine={{ stroke: "#cbd5e1" }}
                            tickLine={false}
                            tickMargin={8}
                          />
                          <YAxis
                            domain={rawMaterialYAxisDomain}
                            tick={{ fontSize: 11, fill: "#64748b" }}
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
                              border: "1px solid #e2e8f0",
                              boxShadow: "0 10px 40px rgba(15,23,42,0.08)",
                              fontSize: 12,
                            }}
                          />
                          <Line
                            type="monotone"
                            dataKey="raw_material_stock"
                            name="Остаток сырья"
                            stroke="#16a34a"
                            strokeWidth={3}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            dot={{ r: 2, strokeWidth: 0, fill: "#16a34a" }}
                            activeDot={{ r: 6, strokeWidth: 0, fill: "#16a34a" }}
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
