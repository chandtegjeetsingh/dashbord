#!/usr/bin/env bash
# Выгрузка проекта на VM Google Cloud без GitHub: архив + gcloud scp/ssh.
# Запуск с Mac из корня репозитория: ./scripts/sync-to-gcp-vm.sh
# Если таймаут на внешний IP:22: USE_IAP=1 ./scripts/sync-to-gcp-vm.sh
set -euo pipefail

# Длинный scp/ssh: не обрывать соединение при заливке архива
GCLOUD_SCP_FLAGS=(--scp-flag="-oServerAliveInterval=30" --scp-flag="-oServerAliveCountMax=24")
GCLOUD_SSH_FLAGS=(--ssh-flag="-oServerAliveInterval=30" --ssh-flag="-oServerAliveCountMax=24")

VM_NAME="${VM_NAME:-dash-vm}"
ZONE="${ZONE:-us-west1-b}"
PROJECT="${PROJECT:-capable-country-491808-g4}"
# Каталог на VM относительно $HOME (без ведущего слэша)
DASHBOARD_REMOTE_DIR="${DASHBOARD_REMOTE_DIR:-dashbord}"
# Если с интернета порт 22 закрыт: USE_IAP=1 ./scripts/sync-to-gcp-vm.sh
USE_IAP="${USE_IAP:-0}"
IAP_FLAG=()
if [[ "$USE_IAP" == "1" ]]; then
  IAP_FLAG=(--tunnel-through-iap)
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -t dashboard-sync.XXXXXX.tar.gz)"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo ""
echo "━━ [1/4] Упаковка проекта ━━"
echo "    Каталог: $ROOT"
echo "    Исключения: node_modules, .git, frontend/dist, .venv, .env, *.db …"
tar czf "$TMP" \
  -C "$ROOT" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='frontend/dist' \
  --exclude='__pycache__' \
  --exclude='.venv' \
  --exclude='*.db' \
  --exclude='.env' \
  .

echo ""
echo "━━ [2/4] Содержимое архива (первые 25 путей) ━━"
ARCHIVE_LINES=0
while IFS= read -r line; do
  ARCHIVE_LINES=$((ARCHIVE_LINES + 1))
  if [[ "${ARCHIVE_LINES}" -le 25 ]]; then
    printf '    %s\n' "${line}"
  fi
done < <(tar tzf "$TMP" 2>/dev/null)
echo "    Всего записей в .tgz: ${ARCHIVE_LINES}"
if [[ "${ARCHIVE_LINES}" -gt 25 ]]; then
  echo "    … показаны первые 25 из ${ARCHIVE_LINES}"
fi
echo "    Размер файла: $(du -h "$TMP" | awk '{print $1}')"

echo ""
echo "━━ [3/4] Копирование на VM: ${VM_NAME}:/tmp/dashboard-sync.tgz ━━"
if [[ "${#IAP_FLAG[@]}" -gt 0 ]]; then
  echo "    Режим: IAP (--tunnel-through-iap)"
fi
echo "    (точки = идёт передача, обычно несколько минут)"
printf "    "
set +e
(
  gcloud compute scp "${IAP_FLAG[@]}" "${GCLOUD_SCP_FLAGS[@]}" "$TMP" "${VM_NAME}:/tmp/dashboard-sync.tgz" \
    --zone="$ZONE" \
    --project="$PROJECT" \
    --verbosity=warning
) &
SCP_PID=$!
while kill -0 "${SCP_PID}" 2>/dev/null; do
  printf "."
  sleep 2
done
printf "\n"
wait "${SCP_PID}"
SCP_EXIT=$?
if [[ "${SCP_EXIT}" -ne 0 ]]; then
  echo "Ошибка: gcloud compute scp завершился с кодом ${SCP_EXIT}" >&2
  exit "${SCP_EXIT}"
fi
set -euo pipefail
echo "    Заливка завершена."

echo ""
echo "━━ [4/4] Распаковка на VM в ~/${DASHBOARD_REMOTE_DIR} ━━"
gcloud compute ssh "${IAP_FLAG[@]}" "${GCLOUD_SSH_FLAGS[@]}" "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT" \
  --verbosity=warning \
  --command="mkdir -p ~/${DASHBOARD_REMOTE_DIR} && tar xzf /tmp/dashboard-sync.tgz -C ~/${DASHBOARD_REMOTE_DIR} && rm -f /tmp/dashboard-sync.tgz"
echo "    Распаковка завершена."

echo "Готово. Код на VM: ~/${DASHBOARD_REMOTE_DIR}"
echo "  .env: scp или ./scripts/deploy.sh (копирует .env при наличии)"
echo "  запуск: cd ~/${DASHBOARD_REMOTE_DIR} && docker compose up -d --build"
