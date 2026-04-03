#!/usr/bin/env bash
# Выгрузка проекта на VM Google Cloud без GitHub: архив + gcloud scp/ssh.
# Запуск с Mac из корня репозитория: ./scripts/sync-to-gcp-vm.sh
set -euo pipefail

VM_NAME="${VM_NAME:-dash-vm}"
ZONE="${ZONE:-us-west1-b}"
PROJECT="${PROJECT:-capable-country-491808-g4}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -t dashboard-sync.XXXXXX.tar.gz)"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

echo "→ Сборка архива из $ROOT (без node_modules, .git, dist)…"
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

echo "→ Копирование на $VM_NAME…"
gcloud compute scp "$TMP" "${VM_NAME}:/tmp/dashboard-sync.tgz" \
  --zone="$ZONE" \
  --project="$PROJECT"

echo "→ Распаковка на VM в ~/dashbord…"
gcloud compute ssh "$VM_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT" \
  --command='mkdir -p ~/dashbord && tar xzf /tmp/dashboard-sync.tgz -C ~/dashbord && rm -f /tmp/dashboard-sync.tgz'

echo "Готово. На VM: положи ~/dashbord/.env вручную (scp), затем:"
echo "  cd ~/dashbord && docker compose up -d --build"
