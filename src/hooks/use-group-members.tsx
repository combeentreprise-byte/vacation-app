import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useProfile } from "@/hooks/use-profile";
import { supabase } from "@/lib/supabase";
import { DELETED_USER_ID } from "@/utils/balances";
import { readUserData, writeUserData } from "@/utils/offline-storage";

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
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const { profile, isLoaded: isProfileLoaded } = useProfile();
  const [serverMembers, setServerMembers] = useState<GroupMember[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!groupId || !userId) {
      setServerMembers([]);
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
      const next = mapMembers(data ?? []);
      setServerMembers(next);
      writeUserData(userId, `members:${groupId}`, next);
    }
    setIsLoaded(true);
  }, [groupId, userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // The device's last known roster first (see use-groups.tsx's load for
      // why) — without it, the add-entry form would have nobody to split
      // an expense with while offline.
      if (groupId && userId) {
        const stored = await readUserData<GroupMember[]>(userId, `members:${groupId}`);
        if (cancelled) return;
        if (stored) {
          setServerMembers(stored);
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

  // Your own row reflects your profile as this device knows it, including a
  // name/picture change still waiting to sync (see use-profile.tsx), rather
  // than lagging behind until it reaches the server.
  const members = useMemo(
    () =>
      serverMembers.map((member) =>
        isProfileLoaded && member.id === userId
          ? { ...member, name: profile.name, avatarUrl: profile.avatarUrl }
          : member
      ),
    [serverMembers, userId, isProfileLoaded, profile.name, profile.avatarUrl]
  );

  return { members, isLoaded, refresh };
}
