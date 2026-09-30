import type { GroupAccess, MemberAccess } from "@/hooks/use-group-access";

const DAY_MS = 24 * 60 * 60 * 1000;
// How close to its end an unlock gets pointed out next to someone's name.
const ENDS_SOON_MS = 3 * DAY_MS;

// When a plan bought right now would end — for lining it up against people's
// current unlocks before buying. Plans start the moment they're bought.
export function endsAtIfBoughtNow(days: number) {
  return Date.now() + days * DAY_MS;
}

// Whether someone whose unlock runs until `unlockedUntil` is unlocked at `at`.
export function isUnlockedAt(unlockedUntil: number | null | undefined, at = Date.now()) {
  return unlockedUntil != null && unlockedUntil > at;
}

export function isMemberUnlocked(access: GroupAccess | null, userId: string, at = Date.now()) {
  return isUnlockedAt(access?.members[userId]?.unlockedUntil, at);
}

// The viewer's own free entries left in this group (everyone gets their own
// in each group) once this device's not-yet-synced entries in it are counted
// too — the server only counts what has reached it. Pessimistic: a pending
// entry with everyone on it unlocked won't actually use one.
export function freeEntriesLeft(access: GroupAccess | null, pendingInGroup: number) {
  return Math.max(0, (access?.freeEntriesLeft ?? 0) - pendingInGroup);
}

// Whether the viewer's entries in this group need everyone on them unlocked
// right now —
// the client-side mirror of check_entry_access in schema.sql. Access that
// hasn't loaded yet (null) never blocks anything: the server has the final
// say either way, and an entry it turns down is held on the device rather
// than lost (see use-logs.tsx).
export function entriesNeedUnlock(access: GroupAccess | null, pendingInGroup: number) {
  return !!access && access.paywallEnabled && freeEntriesLeft(access, pendingInGroup) === 0;
}

// Worth pointing out next to someone's name: their unlock runs out before
// the group's plan does (so mid-trip), or within the next few days. Never for
// one that renews by itself.
export function unlockEndsEarly(
  member: MemberAccess | undefined,
  planEndsAt: number | null,
  now = Date.now()
) {
  if (!member || !isUnlockedAt(member.unlockedUntil, now) || member.willRenew) return false;
  const until = member.unlockedUntil as number;
  if (planEndsAt !== null && until < planEndsAt) return true;
  return until - now < ENDS_SOON_MS;
}

// "7 Oct", or "7 Oct 2027" once it's not this year. Always English, like the
// rest of the app's text — the device's own locale would drop e.g. a German
// "7. Okt." into an English sentence.
export function formatAccessDate(ms: number) {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-GB", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// "Sam", "Sam and Kim", "Sam, Kim and Lea" — the same joining check_entry_access
// uses for its own message.
// With `max`, names past it collapse into a count: "Anna, Ben +3".
export function joinNames(names: string[], max?: number) {
  if (max !== undefined && names.length > max) {
    return `${names.slice(0, max).join(", ")} +${names.length - max}`;
  }
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
