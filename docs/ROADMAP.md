# Roadmap — флот Xentra по образцу флота CTO (ETS Tender)

Решение владельца 2026-11-09: **доращиваем свой флот**, а не берём `tender/fleet` за основу —
он рассчитан на Linux-хост (systemd, nftables, общий спул), а флот Xentra работает на Mac.
Цель — та же модель работы: роли с правами, почта между ролями, раннер, брифы, память, лимиты,
человек только в необратимом. Референс (только чтение): `~/WebstormProjects/tender-fleet`
(`CLAUDE.md`, `bootstrap/README.md`, `bootstrap/fleet/runner/*`, `registry/people.yaml`, `bootstrap/pools.yaml`).

## Где мы сейчас (2026-11-09)

Один процесс (`node dist/cli.js bot`) ведёт одну задачу по конвейеру: PM-план → приёмочный тест →
разработчик (гейты, брифы, handoff на 80k) → ревью → MR → Jira Review. Telegram: меню, задачи,
смена статусов, лимиты. Безопасность: гейты без токенов, `--restricted`, пустой MCP, deny-list.

Модели: PM Opus 5.5 · dev Sonnet 5.5 · ревью Opus 5.5 · тест/память Sonnet · заметки/отчёт/чат Haiku.
Fable 5.1 недоступна на подписке («out of usage credits»). Второй ревьюер — Codex `gpt-6-astra`, effort `high`
(`CODEX_REVIEW_MODEL`, `CODEX_REVIEW_EFFORT` в `.env`, ещё не подключён).

## Соответствие: флот CTO → наш флот на Mac

| У CTO (Linux) | У нас (Mac) |
|---|---|
| роли-личности в `~/develop/agents/<role>` | роли в `roles/<role>.yaml`: модель/провайдер, права, бакет, `accept_from` |
| team-mail: файловый спул, ack без пробуждения, `not-before`, `supersedes` | `~/.xentra-fleet/mail/{Inbox,Sent,Archive,Acks}` — тот же формат (md + YAML-шапка) |
| раннер на роль (systemd `agent@.service`, inotify) | один супервизор Node + воркер на роль (`fs.watch`); автозапуск — launchd plist |
| сессия на письмо, `--resume` по треду (sid+cwd+model+provider) | то же: `state/<role>/thread.<id>.json` |
| пакет контекста до старта (письмо, память, Jira, MR) — скриптом | то же, без модели, с бюджетом времени и fail-open |
| stream-json журнал, idle watchdog 30 мин, жёсткий timeout | `streamlog` в TS, тот же контракт |
| WIP-коммит перед kill, честная пометка «прошлую сессию убили» | то же |
| пулы ключей и бакеты, gate только на старт сессии | бакеты `claude-sub` / `codex-sub`, дневные доли, пауза |
| override/пауза — флаг от владельца-CTO | кнопки Telegram от allowlisted user id |
| брифы в веб-консоли, журнал ответов append-only | брифы в Telegram (уже есть) + `briefs/<id>/answers.jsonl` |
| память sysadmin-mcp (`mail.<thread>`, `task.<key>`, `people`, `decisions`) | SQLite/JSON-хранилище тех же namespace + чтение в начале / запись в конце сессии |
| ci-watch, jira-watch → письма | то же: события GitLab/Jira превращаются в письма роли |
| merge-bot: аудит на sha головы + зелёный CI + нет вето | то же, выключен по умолчанию, включает владелец |
| nftables egress-deny | нет на Mac → агенты без shell (`--restricted`), сеть закрыта deny-list |

## Фазы

### Фаза 1 — качество конвейера (в текущем процессе) — ✅ закрыта 2026-11-10
1. ✅ **Codex-ревьюер** (`src/engine/codexReview.ts`, параллельно с Claude-ревьюером; выключатель `CODEX_REVIEW_ENABLED`): `codex exec --sandbox read-only -m $CODEX_REVIEW_MODEL -c model_reasoning_effort=$CODEX_REVIEW_EFFORT --output-schema … -o …`, env без токенов; блокирует, если блокирует любой из двух ревьюеров.
2. ✅ **Пакет контекста** (`src/engine/contextPack.ts`; выключатель `CONTEXT_PACK_ENABLED`) перед PM и разработчиком: карточка Jira + 3 последних комментария, MR и пайплайн.
3. ✅ **Журнал сессии** (`src/engine/sessionLog.ts`): поток каждого хода → `.harness-state/tasks/<KEY>/sessions/<время>-<роль>.jsonl`, секреты маскируются, хранение `SESSION_LOG_RETENTION_DAYS` (14 дней, чистка при старте бота). Idle watchdog 30 мин и потолок хода 5 ч (`AGENT_IDLE_TIMEOUT_MS`, `AGENT_TURN_TIMEOUT_MS`).
4. ✅ **WIP-коммит перед принудительной остановкой** и пометка в следующем промпте: `wip: checkpoint …`, задача → человеку (`turn_timeout`), кнопка «Продолжить (та же сессия)» — `--resume` с `buildTimeoutResumePrompt`.
5. ✅ **Политика контекста как у CTO**: одна сессия на задачу через `--resume`, сжатие — штатное у Claude Code (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`), ограничение по времени, а не по токенам. Передача по порогу токенов и стоп `CONTEXT_BUDGET_TOKENS` — выключены по умолчанию. Замер контекста исправлен: размер последнего вызова модели, а не сумма `usage` за ход (сумма завышала в разы).

### Фаза 2 — роли и почта — ✅ закрыта 2026-11-10 (см. `docs/FLEET.md`)
5. ✅ Почтовый спул (`src/fleet/mail.ts`, раскладка и формат team-mail) и CLI `fleet mail send|check|read|thread`.
6. ✅ Супервизор (`src/fleet/supervisor.ts`): воркер на роль, сессия на пачку до 5 писем треда, `--resume` по треду (sid+cwd+model), один тред — одна сессия за раз, рабочая копия на тред (`fleet/<тред>`), коммит правок разработчика, `<gates/>` с лимитом 8 на тред.
7. ✅ Роли `roles/*.json` + `roles/*.md`: `pm` (Opus), `dev-1..2` (Sonnet, правка), `auditor` (Opus), `auditor-codex` (gpt-6-astra high), `tester` (Sonnet). Владелец = `xentra/owner` в Telegram (`src/fleet/telegramBridge.ts`: письма приходят в чат, ответ реплаем, `/fleet`, `/holds`, `/release`).
8. ✅ Защита от эха (`src/fleet/loopGuard.ts`): ack только в Acks (не будит), автоквитанции «начата/завершена», hold треда при > 30 писем ролей / 30 мин или > 10 коротких, карантин, письмо владельцу; «Не выполнено» после 3 попыток, без петли уведомлений.

Отличия от CTO: роли в JSON (без YAML-зависимости); агенты без shell — письма, квитанции и гейты заказывают блоками `<mail>`/`<ack>`/`<gates/>` в ответе, супервизор проверяет и выполняет; один процесс-супервизор вместо юнита на роль. Не сделано в фазе 2: push/MR из треда (фаза 3, через подтверждение владельца), автозапуск launchd, `not-before`/`supersedes`/`expires`.

### Фаза 3 — управление
9. Бакеты и gate на старт сессии; пауза/override из Telegram.
10. Память по треду и задаче (обязательное чтение/запись).
11. jira-watch и ci-watch → письма; агент ставит наблюдение за CI и завершает сессию.
12. Merge-бот по правилу (выключен по умолчанию).

### Фаза 4 — масштаб и метрики
13. Параллельные разработчики в своих worktree.
14. Метрики флота: время до MR, возвраты, внимание владельца, стоимость по ролям; сравнение моделей по логам.
15. Eval на ~20 закрытых XEN-тикетах (pass@1/pass^k).

## Правила, которые не меняются
- Мерж, прод, миграции БД, Jira «Закрыт» — только человек.
- Push в удалённые репозитории — только с подтверждения владельца, каждый раз.
- Репо выглядит как собственный проект владельца: без ссылок на исходный проект.
