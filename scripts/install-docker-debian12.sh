#!/usr/bin/env bash
# Установка Docker Engine + Compose v2 на Debian 12 (bookworm).
# Запуск на VM: bash scripts/install-docker-debian12.sh
# После установки: exit и новый SSH, затем usermod уже применит группу docker (см. конец скрипта).
set -euo pipefail

if ! grep -qi 'bookworm' /etc/os-release 2>/dev/null; then
  echo "Внимание: похоже, это не Debian 12 bookworm. Проверь: cat /etc/os-release"
fi

echo "→ Удаление ошибочного списка Docker (ubuntu bookworm и т.п.)…"
sudo rm -f /etc/apt/sources.list.d/docker.list

echo "→ apt update…"
sudo apt-get update -qq

echo "→ Базовые пакеты…"
sudo apt-get install -y ca-certificates curl

echo "→ Ключ и репозиторий Docker для Debian…"
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "→ Установка Docker…"
sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "→ Запуск docker…"
sudo systemctl enable --now docker

echo "→ Проверка…"
sudo docker --version
sudo docker compose version
sudo docker run --rm hello-world

echo ""
echo "Готово. Чтобы не использовать sudo для docker:"
echo "  sudo usermod -aG docker \$USER"
echo "  exit"
echo "  (новый SSH-вход)"
echo ""
echo "Дашборд:"
echo "  cd ~/dashbord && docker compose up -d --build"
