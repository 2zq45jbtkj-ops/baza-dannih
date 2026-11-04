#!/bin/bash
# SessionStart-хук: сверяет рабочую копию с origin/main (см. CLAUDE.md).
# При неудаче fetch честно сообщает об этом, а не молчит «всё синхронно».
cd "$(dirname "$0")/.." || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

emit() { jq -nc --arg c "$1" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'; }

git fetch origin --quiet 2>/dev/null &
pid=$!
for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; ok=0; else wait "$pid" 2>/dev/null && ok=1 || ok=0; fi

br=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || {
  emit "GIT: ссылки origin/main нет локально, сверить не с чем."; exit 0; }

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null)
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null)
warn=""
[ "$ok" -eq 0 ] && warn=" ВНИМАНИЕ: fetch не прошёл, сравнение с ранее скачанной ссылкой и может быть устаревшим."

if [ "$behind" = "0" ]; then
  emit "GIT: ветка '$br' не отстаёт от origin/main (впереди на $ahead).$warn"
else
  emit "GIT — ОСТАНОВИСЬ. Ветка '$br' отстаёт от origin/main на $behind коммит(ов), впереди на $ahead. Файлы на диске НЕ соответствуют задеплоенному коду. Сначала git rebase origin/main, потом работа.$warn"
fi
