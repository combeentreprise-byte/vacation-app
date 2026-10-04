import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { readUserData, writeUserData } from "@/utils/offline-storage";

// Mirrors group_events_kind_check in schema.sql.
const GROUP_EVENT_KINDS = [
  "group_created",
  "member_joined",
  "member_left",
  "member_kicked",
  "admin_promoted",
  "admin_auto_promoted",
  "admin_demoted",
  "sponsor_handed_over",
  "plan_started",
  "plan_seat_given",
  "plan_seat_removed",
] as const;

export type GroupEventKind = (typeof GROUP_EVENT_KINDS)[number];

// The plan as it was when a plan event happened (group_events.details in
// schema.sql), so the Logs tab shows its history rather than today's plan.
export type PlanEventDetails = {
  planId: string;
  seatCount: number;
  endsAt: number;
  // plan_started only: when it starts (missing from ones recorded before a
  // pass could start later, which started when they were recorded), whether
  // it renews, and who got the seats it started with (they get no
  // plan_seat_given events of their own).
  startsAt?: number;
  willRenew?: boolean;
  seatHolders?: string[];
  // plan_seat_given only: taken seats, counting the one just given.
  seatsUsed?: number;
};

// A membership change shown in the Logs tab alongside expenses (see
// group_events in schema.sql). Never written from the client: each one is
// recorded by the RPC that made the change.
export type GroupEvent = {
  id: string;
  groupId: string;
  kind: GroupEventKind;
  // Who did it — for admin_auto_promoted / sponsor_handed_over, the admin /
  // sponsor whose leaving caused it.
  // Null once that person has deleted their account, same as LogEntry.paidBy.
  actorId: string | null;
  // Who it was done to (member_kicked, admin_promoted, admin_auto_promoted,
  // admin_demoted, sponsor_handed_over, plan_seat_given, plan_seat_removed);
  // null for the other kinds, or once that person has deleted their account.
  targetId: string | null;
  // Plan events only; null for other kinds (and in a copy saved on the
  // device before this existed).
  details: PlanEventDetails | null;
  createdAt: number;
};

type GroupEventRow = {
  id: string;
  group_id: string;
  kind: string;
  actor_id: string | null;
  target_id: string | null;
  details: {
    plan_id: string;
    seat_count: number;
    starts_at?: string;
    ends_at: string;
    will_renew?: boolean;
    seat_holders?: string[];
    seats_used?: number;
  } | null;
  created_at: string;
};

function isKnownKind(kind: string): kind is GroupEventKind {
  return (GROUP_EVENT_KINDS as readonly string[]).includes(kind);
}

function mapEvents(rows: GroupEventRow[]): GroupEvent[] {
  // A kind added server-side after this build shipped is skipped rather than
  // shown as something it isn't.
  return rows.flatMap((row) =>
    isKnownKind(row.kind)
      ? [
          {
            id: row.id,
            groupId: row.group_id,
            kind: row.kind,
            actorId: row.actor_id,
            targetId: row.target_id,
            details: row.details
              ? {
                  planId: row.details.plan_id,
                  seatCount: row.details.seat_count,
                  startsAt: row.details.starts_at
                    ? new Date(row.details.starts_at).getTime()
                    : undefined,
                  endsAt: new Date(row.details.ends_at).getTime(),
                  willRenew: row.details.will_renew,
                  seatHolders: row.details.seat_holders,
                  seatsUsed: row.details.seats_used,
                }
              : null,
            createdAt: new Date(row.created_at).getTime(),
          },
        ]
      : []
  );
}

// Same shape as useGroupMembers: a plain hook scoped to whichever group is
// open, not an app-wide provider.
export function useGroupEvents(groupId: string | undefined) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [events, setEvents] = useState<GroupEvent[]>([]);

  const refresh = useCallback(async () => {
    if (!groupId || !userId) {
      setEvents([]);
      return;
    }

    // Newest first. Two events written in the same transaction (leaving as
    // the only admin, then the auto-promotion) can land within the same
    // millisecond, which createdAt can't tell apart — the Logs tab's sort
    // is stable, so this server order (by the full-precision timestamp) is
    // what keeps them the right way round.
    const { data, error } = await supabase
      .from("group_events")
      .select("id, group_id, kind, actor_id, target_id, details, created_at")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Failed to load group events", error);
    } else {
      const next = mapEvents(data ?? []);
      setEvents(next);
      writeUserData(userId, `events:${groupId}`, next);
    }
  }, [groupId, userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // The device's last known history first (see use-groups.tsx's load
      // for why), so the Logs tab looks the same offline.
      if (groupId && userId) {
        const stored = await readUserData<GroupEvent[]>(userId, `events:${groupId}`);
        if (cancelled) return;
        if (stored) setEvents(stored);
      }
      if (cancelled) return;
      await refresh();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [groupId, userId, refresh]);

  return { events, refresh };
}
