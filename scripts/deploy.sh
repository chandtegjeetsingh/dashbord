#!/usr/bin/env bash
# Деплой дашборда на GCP VM. Список команд: ./scripts/deploy.sh help
#
set -euo pipefail

GCLOUD_SCP_FLAGS=(--scp-flag="-oServerAliveInterval=30" --scp-flag="-oServerAliveCountMax=24")
GCLOUD_SSH_FLAGS=(--ssh-flag="-oServerAliveInterval=30" --ssh-flag="-oServerAliveCountMax=24")

VM_NAME="${VM_NAME:-dash-vm}"
ZONE="${ZONE:-us-west1-b}"
PROJECT="${PROJECT:-capable-country-491808-g4}"
DASHBOARD_REMOTE_DIR="${DASHBOARD_REMOTE_DIR:-dashbord}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STEP="${1:-all}"
STEP_LC="$(printf '%s' "$STEP" | tr '[:upper:]' '[:lower:]')"

usage() {
  cat <<'EOF'
Деплой на GCP VM — по шагам или всё сразу.

  ./scripts/deploy.sh help     — эта справка
  ./scripts/deploy.sh sync     — 1) только код (архив → VM → распаковка)
  ./scripts/deploy.sh env      — 2) только .env на VM
  ./scripts/deploy.sh up       — 3) только docker compose up --build на VM
  ./scripts/deploy.sh all      — всё подряд (по умолчанию, если аргумент не указан)

Переменные окружения: VM_NAME, ZONE, PROJECT, DASHBOARD_REMOTE_DIR

Режим «all» и флаги: DEPLOY_SKIP_SYNC=1, DEPLOY_SKIP_ENV=1, DEPLOY_SKIP_COMPOSE=1
EOF
}

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Ошибка: не найден gcloud. Установите Google Cloud SDK." >&2
  exit 1
fi

run_sync() {
  echo "=== Шаг: код на VM (${VM_NAME}) ==="
  DASHBOARD_REMOTE_DIR="$DASHBOARD_REMOTE_DIR" \
    VM_NAME="$VM_NAME" ZONE="$ZONE" PROJECT="$PROJECT" \
    "$ROOT/scripts/sync-to-gcp-vm.sh"
}

run_env() {
  if [[ ! -f "$ROOT/.env" ]]; then
    echo "(!) Нет локального $ROOT/.env — пропуск." >&2
    return 0
  fi
  echo ""
  echo "=== Шаг: .env на VM ==="
  echo "    Локальный файл: $ROOT/.env ($(du -h "$ROOT/.env" | awk '{print $1}'))"
  echo "    Удалённый путь:  ~/${DASHBOARD_REMOTE_DIR}/.env"
  printf "    копирование"
  set +e
  (
    gcloud compute scp "${GCLOUD_SCP_FLAGS[@]}" "$ROOT/.env" "${VM_NAME}:~/${DASHBOARD_REMOTE_DIR}/.env" \
      --zone="$ZONE" \
      --project="$PROJECT" \
      --verbosity=warning
  ) &
  E_PID=$!
  while kill -0 "${E_PID}" 2>/dev/null; do printf "."; sleep 1; done
  printf "\n"
  wait "${E_PID}"
  E_EXIT=$?
  set -euo pipefail
  if [[ "${E_EXIT}" -ne 0 ]]; then
    echo "Ошибка: копирование .env завершилось с кодом ${E_EXIT}" >&2
    exit "${E_EXIT}"
  fi
  echo "    готово."
}

run_up() {
  echo ""
  echo "=== Шаг: Docker Compose на VM ==="
  gcloud compute ssh "${GCLOUD_SSH_FLAGS[@]}" "$VM_NAME" \
    --zone="$ZONE" \
    --project="$PROJECT" \
    --verbosity=warning \
    --command="set -euo pipefail; cd \"\$HOME/${DASHBOARD_REMOTE_DIR}\"; command -v docker >/dev/null 2>&1 || { echo 'Docker не установлен на VM.' >&2; exit 1; }; DOCKER_BUILDKIT=1 docker compose up -d --build; docker compose ps"
}

case "$STEP_LC" in
  help|-h|--help)
    usage
    exit 0
    ;;
  sync)
    run_sync
    echo ""
    echo "Дальше вручную: ./scripts/deploy.sh env"
    echo "              затем: ./scripts/deploy.sh up"
    ;;
  env)
    run_env
    echo ""
    echo "Дальше вручную: ./scripts/deploy.sh up"
    ;;
  up|compose)
    run_up
    echo ""
    echo "Готово. Браузер: http://<внешний-IP-VM>:8080"
    ;;
  all)
    echo "=== Полный деплой → ${VM_NAME} (${ZONE}, ${PROJECT}) ==="
    echo "Каталог на VM: ~/${DASHBOARD_REMOTE_DIR}"
    echo "(по шагам: ./scripts/deploy.sh help)"
    echo

    if [[ "${DEPLOY_SKIP_SYNC:-0}" != "1" ]]; then
      run_sync
    else
      echo "→ Пропуск sync (DEPLOY_SKIP_SYNC=1)"
    fi

    if [[ "${DEPLOY_SKIP_ENV:-0}" != "1" ]]; then
      if [[ -f "$ROOT/.env" ]]; then
        run_env
      else
        echo "(!) Локального .env нет — на VM должен уже лежать ~/${DASHBOARD_REMOTE_DIR}/.env"
      fi
    else
      echo "→ Пропуск .env (DEPLOY_SKIP_ENV=1)"
    fi

    if [[ "${DEPLOY_SKIP_COMPOSE:-0}" != "1" ]]; then
      run_up
    else
      echo "→ Пропуск compose (DEPLOY_SKIP_COMPOSE=1)"
    fi

    echo ""
    echo "Готово. Браузер: http://<внешний-IP-VM>:8080"
    ;;
  *)
    echo "Неизвестная команда: $STEP" >&2
    echo "" >&2
    usage >&2
    exit 1
    ;;
esac
