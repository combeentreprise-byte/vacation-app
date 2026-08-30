import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

export type GroupMember = {
  id: string;
  name: string;
  isActive: boolean;
};

type MemberRow = {
  user_id: string;
  left_at: string | null;
  profiles: { name: string } | { name: string }[] | null;
};

function mapMember(row: MemberRow): GroupMember {
  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return { id: row.user_id, name: profile?.name ?? "Unknown", isActive: row.left_at === null };
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
      .select("user_id, left_at, profiles(name)")
      .eq("group_id", groupId);

    if (error) {
      console.warn("Failed to load group members", error);
    } else {
      setMembers((data ?? []).map(mapMember));
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
