import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fleetHome } from "./fleet/workspace.js";

// The owner's own standing Claude Code session ("CTO console"), like the CTO's terminal
// session that runs his fleet: a dedicated folder whose CLAUDE.md explains the fleet and
// the commands to drive it, a status line, and `claude --continue` so it is always the
// same conversation. It is NOT the «Зам. CTO» chat in Telegram (that one is pm's session
// inside the fleet) — two writers into one session would garble it.

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function ctoDir(): string {
  return join(fleetHome(), "cto");
}

// Claude Code keeps a folder's conversations under ~/.claude/projects/<path, every non-alphanumeric char as ->.
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

export function hasPreviousSession(cwd: string): boolean {
  const dir = claudeProjectDir(cwd);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"));
}

export function ctoClaudeMd(cli: string): string {
  return `# Консоль CTO — флот Xentra

Ты — личная постоянная сессия владельца для управления флотом агентов Xentra. Владелец здесь
CTO: ставит цели и принимает решения; ты помогаешь ему видеть картину и отдавать распоряжения.
Общайся по-русски, коротко и по делу.

## Как устроен флот
- **Бот** (Telegram) ведёт одну задачу сам: план → код → гейты → ревью → MR.
- **Команда** — роли, которые переписываются письмами: Зам. CTO (\`xentra/pm\`), разработчики
  (\`xentra/dev\` → dev-1, dev-2), аудиторы (\`auditor\`, \`auditor-codex\`), тестировщик (\`tester\`).
  Владелец — адрес \`xentra/owner\`. Супервизор запускает сессии ролей: \`${cli} fleet run\`.
- Push, MR, мерж, миграции БД, закрытие задач — только владелец (кнопками в Telegram).

## Команды (Bash разрешён для них)
- \`${cli} fleet status\` — кто работает, очереди, решения, треды за неделю, письма владельцу. **Начинай с неё.**
- \`${cli} fleet mail thread <тред>\` — вся переписка по задаче.
- \`${cli} fleet mail check\` / \`read <id> --keep\` — письма владельцу.
- \`${cli} fleet mail send --to xentra/pm --subject "XEN-55: …" --body "…" --key XEN-55\` — задача
  или ответ от имени владельца (новый тред; ответ в тред — \`--thread <тред>\`).
  **Отправляй только когда владелец явно попросил**, и покажи текст письма перед отправкой.
- \`${cli} fleet metrics --days 7\` — метрики: время до MR, возвраты, стоимость по ролям и моделям.
- \`${cli} watch --tail 2\` / \`${cli} watch --task <ключ или fleet-тред>\` — что делали агенты.
- \`${cli} fleet hold list\` / \`fleet hold release <тред>\` — треды, остановленные защитой от зацикливания.
- \`${cli} fleet roles\` — роли и модели.

## Где лежит
- Почта и состояние команды: \`~/.xentra-fleet/\` (mail, state/memory, state/sessions.jsonl).
- Код флота: \`${REPO_ROOT}\` (docs/FLEET.md, docs/ROADMAP.md, docs/KNOWN-LIMITS.md).

## Правила
- Не выдумывай состояние: сначала \`fleet status\` или переписка треда.
- Не меняй файлы флота и рабочих репозиториев из этой сессии — для этого есть команда.
- Решения push/merge не принимай за владельца; напомни, что кнопки в Telegram.
`;
}

export function ctoSettings(cli: string, statusLine: string): object {
  return {
    permissions: {
      allow: [
        `Bash(${cli} fleet status)`,
        `Bash(${cli} fleet status:*)`,
        `Bash(${cli} fleet mail check)`,
        `Bash(${cli} fleet mail thread:*)`,
        `Bash(${cli} fleet mail read:*)`,
        `Bash(${cli} fleet metrics:*)`,
        `Bash(${cli} fleet roles)`,
        `Bash(${cli} fleet hold list)`,
        `Bash(${cli} watch:*)`,
        `Read(${join(fleetHome())}/**)`,
        `Read(${REPO_ROOT}docs/**)`,
      ],
    },
    statusLine: { type: "command", command: statusLine },
  };
}

// Writes CLAUDE.md and .claude/settings.json fresh each time (paths stay current).
export function prepareCtoWorkspace(): { dir: string; resume: boolean } {
  const dir = ctoDir();
  const cli = `node ${join(REPO_ROOT, "dist", "cli.js")}`;
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), ctoClaudeMd(cli));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(ctoSettings(cli, `${cli} cto-statusline`), null, 2));
  return { dir, resume: hasPreviousSession(dir) };
}
