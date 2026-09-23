import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";
import { DELETED_USER_ID } from "@/utils/balances";

export type GroupMember = {
  id: string;
  name: string;
  avatarUrl: string | null;
  isActive: boolean;
  isAdmin: boolean;
};

type MemberProfile = { name: string; avatar_url: string | null };

type MemberRow = {
  // Null once that person's account has been fully deleted (see
  // delete_account in schema.sql) — the row itself is kept (left_at already
  // set, since delete_account leaves every group first) rather than
  // vanishing, so the group's roster still accounts for them.
  user_id: string | null;
  left_at: string | null;
  is_admin: boolean;
  profiles: MemberProfile | MemberProfile[] | null;
};

function mapMember(row: MemberRow): GroupMember | null {
  if (row.user_id === null) return null;
  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return {
    id: row.user_id,
    name: profile?.name ?? "Unknown",
    avatarUrl: profile?.avatar_url ?? null,
    isActive: row.left_at === null,
    isAdmin: row.is_admin,
  };
}

function mapMembers(rows: MemberRow[]): GroupMember[] {
  const members = rows.map(mapMember).filter((member): member is GroupMember => !!member);

  // Deleted accounts are collapsed into a single placeholder rather than one
  // row per deleted row: their balances already merge into one shared
  // DELETED_USER_ID bucket (see balances.ts), since a truly erased identity
  // can't be told apart from another one — showing several identical rows
  // here would just look like separate debts without actually being able to
  // back that up with distinct amounts.
  if (rows.some((row) => row.user_id === null)) {
    members.push({
      id: DELETED_USER_ID,
      name: "Deleted user",
      avatarUrl: null,
      isActive: false,
      isAdmin: false,
    });
  }

  return members;
}

export function useGroupMembers(groupId: string | undefined) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!groupId) {
      setMembers([]);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase
      .from("group_members")
      .select("user_id, left_at, is_admin, profiles(name, avatar_url)")
      .eq("group_id", groupId);

    if (error) {
      console.warn("Failed to load group members", error);
    } else {
      setMembers(mapMembers(data ?? []));
    }
    setIsLoaded(true);
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (cancelled) return;
      await refresh();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { members, isLoaded, refresh };
}
