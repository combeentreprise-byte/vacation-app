import { useCallback, useEffect, useState } from "react";

import type { PlanKind } from "@/constants/plans";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { requestErrorMessage } from "@/utils/network";
import { readUserData, writeUserData } from "@/utils/offline-storage";

// The group's plan that hasn't ended, if any (at most one per group):
// running, or set up to start later (startsAt still ahead — its seat holders
// aren't unlocked by it until then).
export type GroupPlan = {
  id: string;
  kind: PlanKind;
  // Null once the sponsor has deleted their account.
  sponsorId: string | null;
  seatCount: number;
  // Every taken seat, including deletedSeats. A seat stays with its holder
  // for the whole plan — leaving the group doesn't free it.
  seatsUsed: number;
  // Taken by accounts that have since been deleted (there's no member left
  // to show them under).
  deletedSeats: number;
  // Null in a copy saved on the device before this existed.
  startsAt: number | null;
  endsAt: number;
  willRenew: boolean;
  // How long it runs. Null in a copy saved on the device before this
  // existed.
  durationDays: number | null;
  // Whether the viewer hands out its seats: its sponsor, or the group's
  // admins once the sponsor is no longer in the group.
  canManage: boolean;
  // Members holding one of its seats (from `members`). Missing from a copy
  // saved on the device before this existed.
  seatHolderIds?: string[];
};

export type MemberAccess = {
  // When their unlock runs out (from any plan, not just this group's), or
  // null if they aren't unlocked. A renewing subscription wins over a
  // longer pass: it counts as never running out (isCoveredAt).
  unlockedUntil: number | null;
  willRenew: boolean;
  // How long the plan unlocking them runs, or null (not unlocked, or a copy
  // saved on the device before this existed).
  unlockDays: number | null;
  // Holds one of this group's plan seats.
  hasSeat: boolean;
};

export type GroupAccess = {
  paywallEnabled: boolean;
  // The group's free entries left, shared by everyone in it, as far as the
  // server knows — entries still queued on this device aren't counted yet
  // (see freeEntriesLeft in utils/access.ts), and other members may have
  // used some since this was fetched.
  freeEntriesLeft: number;
  plan: GroupPlan | null;
  // Keyed by user id; includes members who left.
  members: Record<string, MemberAccess>;
};

type GroupAccessRow = {
  paywall_enabled: boolean;
  free_entries_left: number;
  plan: {
    id: string;
    kind: PlanKind;
    sponsor_id: string | null;
    seat_count: number;
    seats_used: number;
    deleted_seats: number;
    starts_at?: string;
    ends_at: string;
    will_renew: boolean;
    duration_days?: number;
    can_manage: boolean;
  } | null;
  members: {
    user_id: string;
    unlocked_until: string | null;
    will_renew: boolean;
    unlock_days?: number | null;
    has_seat: boolean;
  }[];
};

function mapGroupAccess(row: GroupAccessRow): GroupAccess {
  return {
    paywallEnabled: row.paywall_enabled,
    freeEntriesLeft: row.free_entries_left,
    plan: row.plan
      ? {
          id: row.plan.id,
          kind: row.plan.kind,
          sponsorId: row.plan.sponsor_id,
          seatCount: row.plan.seat_count,
          seatsUsed: row.plan.seats_used,
          // Missing from a copy saved on the device before this existed.
          deletedSeats: row.plan.deleted_seats ?? 0,
          startsAt: row.plan.starts_at ? new Date(row.plan.starts_at).getTime() : null,
          endsAt: new Date(row.plan.ends_at).getTime(),
          willRenew: row.plan.will_renew,
          durationDays: row.plan.duration_days ?? null,
          canManage: row.plan.can_manage,
          seatHolderIds: row.members
            .filter((member) => member.has_seat)
            .map((member) => member.user_id),
        }
      : null,
    members: Object.fromEntries(
      row.members.map((member) => [
        member.user_id,
        {
          unlockedUntil: member.unlocked_until ? new Date(member.unlocked_until).getTime() : null,
          willRenew: member.will_renew,
          unlockDays: member.unlock_days ?? null,
          hasSeat: member.has_seat,
        },
      ])
    ),
  };
}

// Same shape as useGroupMembers: a plain hook scoped to whichever group is
// open, not an app-wide provider.
export function useGroupAccess(groupId: string | undefined) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [access, setAccess] = useState<GroupAccess | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!groupId || !userId) {
      setAccess(null);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase.rpc("get_group_access", { p_group_id: groupId });

    if (error) {
      console.warn("Failed to load group access", error);
    } else {
      const next = mapGroupAccess(data as GroupAccessRow);
      setAccess(next);
      writeUserData(userId, `group-access:${groupId}`, next);
    }
    setIsLoaded(true);
  }, [groupId, userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // The device's last known copy first (see use-groups.tsx's load for
      // why) — the entry form needs it offline to know who can be on an entry.
      if (groupId && userId) {
        const stored = await readUserData<GroupAccess>(userId, `group-access:${groupId}`);
        if (cancelled) return;
        if (stored) {
          setAccess(stored);
          setIsLoaded(true);
        }
      }
      if (cancelled) return;
      await refresh();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [groupId, userId, refresh]);

  // Seat changes are online-only, like every other group admin action.
  // assign_plan_seats enforces every rule server-side.
  const assignSeats = useCallback(
    async (planId: string, memberIds: string[]) => {
      const { error, status } = await supabase.rpc("assign_plan_seats", {
        p_plan_id: planId,
        p_user_ids: memberIds,
      });
      if (error) {
        console.warn("Failed to assign seats", error);
        return { error: requestErrorMessage(error.message, status) };
      }
      await refresh();
      return {};
    },
    [refresh]
  );

  // Only before the pass starts — after that its seats are locked in.
  // remove_plan_seat enforces that and every other rule server-side.
  const removeSeat = useCallback(
    async (planId: string, memberId: string) => {
      const { error, status } = await supabase.rpc("remove_plan_seat", {
        p_plan_id: planId,
        p_user_id: memberId,
      });
      if (error) {
        console.warn("Failed to remove seat", error);
        return { error: requestErrorMessage(error.message, status) };
      }
      await refresh();
      return {};
    },
    [refresh]
  );

  return { access, isLoaded, refresh, assignSeats, removeSeat };
}
