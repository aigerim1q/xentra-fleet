import type { Letter } from "./mail.js";
import { OWNER_ADDRESS } from "./roles.js";

// Which letters a role takes next — the CTO fleet's rules, minus limits/buckets:
// - ack/auto-ack never count (they shouldn't be in an Inbox at all; stray ones are
//   archived by the supervisor without a session);
// - high/urgent before normal/low, then by arrival (ids start with a unix timestamp);
// - letters are grouped by (repo, thread): one session handles one thread in one repo;
// - up to BATCH_LIMIT letters of that group go into one session: all owner and
//   high-priority letters, then the newest of the rest; older ones wait;
// - primary = the owner's letter if there is one, else the newest.

export const BATCH_LIMIT = 5;

export interface Batch {
  primary: Letter;
  extras: Letter[];
  thread: string;
  repo?: string;
}

const isUrgent = (l: Letter) => l.priority === "high" || l.priority === "urgent";

export function pendingOrder(letters: Letter[]): Letter[] {
  const real = letters.filter((l) => !l.kind);
  const byArrival = [...real].sort((a, b) => a.id.localeCompare(b.id));
  return [...byArrival.filter(isUrgent), ...byArrival.filter((l) => !isUrgent(l))];
}

export function pickBatch(letters: Letter[], opts: { skip?: (l: Letter) => boolean; limit?: number } = {}): Batch | undefined {
  const limit = opts.limit ?? BATCH_LIMIT;
  const ordered = pendingOrder(letters).filter((l) => !opts.skip?.(l));
  if (ordered.length === 0) return undefined;
  const first = ordered[0];
  const group = ordered.filter((l) => l.thread === first.thread && l.repo === first.repo);

  const mustTake = group.filter((l) => l.from === OWNER_ADDRESS || isUrgent(l));
  const rest = group.filter((l) => !mustTake.includes(l)).sort((a, b) => b.id.localeCompare(a.id));
  const chosen = [...mustTake, ...rest].slice(0, Math.max(limit, mustTake.length));

  const owner = chosen.filter((l) => l.from === OWNER_ADDRESS).sort((a, b) => b.id.localeCompare(a.id));
  const newestFirst = [...chosen].sort((a, b) => b.id.localeCompare(a.id));
  const primary = owner[0] ?? newestFirst[0];
  return {
    primary,
    extras: newestFirst.filter((l) => l !== primary).reverse(),
    thread: first.thread,
    repo: first.repo,
  };
}
