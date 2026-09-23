import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { ensureRatesCached } from "@/utils/exchange-rates";

export type Group = {
  id: string;
  name: string;
  description: string;
  currency: string;
  createdAt: number;
};

type GroupRow = {
  id: string;
  name: string;
  description: string;
  currency: string;
  created_at: string;
};

function mapGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currency: row.currency,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// currency deliberately excluded: changing it has to rescale every log's
// converted_amount (see change_group_currency in schema.sql), which a plain
// column update would silently skip. changeGroupCurrency below is the only
// path allowed to change it.
type GroupUpdates = Partial<Pick<Group, "name" | "description">>;

type GroupsContextValue = {
  groups: Group[];
  isLoaded: boolean;
  addGroup: (name: string, description: string, currency: string) => Promise<void>;
  updateGroup: (id: string, updates: GroupUpdates) => Promise<void>;
  changeGroupCurrency: (id: string, currentCurrency: string, newCurrency: string) => Promise<{ error?: string }>;
  removeGroup: (id: string) => Promise<void>;
  joinGroup: (groupId: string) => Promise<{ error?: string }>;
  promoteToAdmin: (groupId: string, userId: string) => Promise<{ error?: string }>;
  kickMember: (groupId: string, userId: string) => Promise<{ error?: string }>;
};

const GroupsContext = createContext<GroupsContextValue | undefined>(undefined);

export function GroupsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [groups, setGroups] = useState<Group[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setGroups([]);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase
      .from("groups")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Failed to load groups", error);
    } else {
      setGroups((data ?? []).map(mapGroup));
    }
    setIsLoaded(true);
  }, [userId]);

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

  const addGroup = useCallback(
    async (name: string, description: string, currency: string) => {
      if (!userId) return;

      // Creating the group and joining it as its first member happen
      // atomically server-side (see create_group in schema.sql) rather than
      // as two separate client calls, so a dropped connection can't leave an
      // orphaned group that nobody, not even its creator, can ever see.
      const { error } = await supabase.rpc("create_group", {
        group_name: name,
        group_description: description,
        group_currency: currency,
      });

      if (error) console.warn("Failed to create group", error);

      await refresh();
    },
    [userId, refresh]
  );

  const updateGroup = useCallback(
    async (id: string, updates: GroupUpdates) => {
      const { error } = await supabase.from("groups").update(updates).eq("id", id);
      if (error) console.warn("Failed to update group", error);
      await refresh();
    },
    [refresh]
  );

  const changeGroupCurrency = useCallback(
    async (id: string, currentCurrency: string, newCurrency: string) => {
      if (currentCurrency === newCurrency) return {};

      try {
        // Warms the shared rate cache for the OLD currency so
        // change_group_currency (which re-reads that cache itself rather
        // than trusting a client-supplied rate) has something fresh to use.
        await ensureRatesCached(currentCurrency);
      } catch {
        return { error: "Couldn't look up exchange rates. Check your connection." };
      }

      const { error } = await supabase.rpc("change_group_currency", {
        p_group_id: id,
        p_new_currency: newCurrency,
      });

      if (error) {
        console.warn("Failed to change group currency", error);
        return { error: error.message };
      }

      await refresh();
      return {};
    },
    [refresh]
  );

  const removeGroup = useCallback(
    async (id: string) => {
      if (!userId) return;
      // Soft-leave (marks the row inactive server-side) rather than
      // deleting it, so historical logs/balances involving this group stay
      // intact for the other members. See leave_group in schema.sql.
      const { error } = await supabase.rpc("leave_group", { p_group_id: id });
      if (error) console.warn("Failed to leave group", error);
      await refresh();
    },
    [userId, refresh]
  );

  const joinGroup = useCallback(
    async (groupId: string) => {
      if (!userId) return { error: "Not signed in" };

      // Also reactivates a membership previously left, rather than erroring
      // on the primary-key conflict a plain insert would hit. See
      // join_group in schema.sql.
      const { error } = await supabase.rpc("join_group", { p_group_id: groupId });

      if (error) {
        console.warn("Failed to join group", error);
        await refresh();
        return { error: error.message };
      }

      await refresh();
      return {};
    },
    [userId, refresh]
  );

  const promoteToAdmin = useCallback(async (groupId: string, userId: string) => {
    const { error } = await supabase.rpc("promote_to_admin", {
      p_group_id: groupId,
      p_user_id: userId,
    });

    if (error) {
      console.warn("Failed to promote member", error);
      return { error: error.message };
    }

    return {};
  }, []);

  const kickMember = useCallback(async (groupId: string, userId: string) => {
    const { error } = await supabase.rpc("kick_member", {
      p_group_id: groupId,
      p_user_id: userId,
    });

    if (error) {
      console.warn("Failed to kick member", error);
      return { error: error.message };
    }

    return {};
  }, []);

  return (
    <GroupsContext.Provider
      value={{
        groups,
        isLoaded,
        addGroup,
        updateGroup,
        changeGroupCurrency,
        removeGroup,
        joinGroup,
        promoteToAdmin,
        kickMember,
      }}
    >
      {children}
    </GroupsContext.Provider>
  );
}

export function useGroups() {
  const context = useContext(GroupsContext);
  if (!context) {
    throw new Error("useGroups must be used within a GroupsProvider");
  }
  return context;
}
