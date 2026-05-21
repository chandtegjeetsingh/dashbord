/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL FastAPI, без завершающего /. Пример: http://127.0.0.1:8000 */
  readonly VITE_API_BASE?: string;
  /** Ссылка на Google Таблицу с данными доставки/логистики (кнопка у карточек в блоке «Логистика»). */
  readonly VITE_DELIVERY_LOGISTICS_SHEET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
