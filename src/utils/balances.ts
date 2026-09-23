import type { LogEntry } from "@/hooks/use-logs";

// Sentinel key a deleted account's balance is filed under. A log's paidBy/
// memberId comes back null once that person's account is gone (see
// delete_account in schema.sql), but the debt itself is still real — it
// doesn't get to silently vanish from the total just because the identity
// behind it did. If more than one deleted account has an outstanding debt in
// the same group, their amounts merge into this one bucket: once an identity
// is truly erased there's no remaining way to tell two of them apart, so
// this is the best a "who owes whom" total can do, not a bug.
export const DELETED_USER_ID = "deleted";

/**
 * Net balance per other member, from the given viewer's perspective, derived
 * from the group's log entries rather than stored, so it can never drift
 * from the underlying ledger.
 *
 * Positive = that member owes the viewer. Negative = the viewer owes them.
 * Any log the viewer neither paid nor was a beneficiary of doesn't affect
 * their balance at all — with more than one real payer in a group, a log's
 * effect depends on who's looking at it, so this can't be reduced to a
 * single payer-agnostic number per member the way it could when "you" were
 * always the payer. When `payerIncluded` is true, the payer also benefited
 * from the purchase, so the amount is split one extra way and the payer's
 * own share is absorbed rather than owed to themselves.
 *
 * Uses `convertedAmount`, not `amount` — a log's originally-entered amount
 * may be in a different currency than the group's, and convertedAmount is
 * kept in the group's current currency (see schema.sql), which is the only
 * way mixed-currency entries stay comparable to each other.
 */
export function calculateMemberBalances(
  logs: LogEntry[],
  groupId: string,
  viewerId: string
): Record<string, number> {
  const balances: Record<string, number> = {};

  logs
    .filter((log) => log.groupId === groupId && log.memberIds.length > 0)
    .forEach((log) => {
      const shareCount = log.memberIds.length + (log.payerIncluded ? 1 : 0);
      const share = log.convertedAmount / shareCount;

      if (log.paidBy === viewerId) {
        log.memberIds.forEach((memberId) => {
          if (memberId === viewerId) return;
          // A null memberId means that person has since deleted their
          // account — still counted (under DELETED_USER_ID) rather than
          // dropped, since they still owe this share; it's just filed
          // under a shared "deleted" bucket instead of their own id.
          const key = memberId ?? DELETED_USER_ID;
          balances[key] = (balances[key] ?? 0) + share;
        });
      } else if (log.memberIds.includes(viewerId)) {
        const key = log.paidBy ?? DELETED_USER_ID;
        balances[key] = (balances[key] ?? 0) - share;
      }
    });

  return balances;
}
