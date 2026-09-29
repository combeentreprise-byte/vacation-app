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
import { ensureRatesCached, prefetchRatesForOffline } from "@/utils/exchange-rates";
import { readUserData, writeUserData } from "@/utils/offline-storage";

export type Group = {
  id: string;
  name: string;
  description: string;
  currency: string;
  heroMotive: string;
  heroHue: number;
  photoUrl: string | null;
  createdAt: number;
  // The viewer's own pin (group_members.pinned_at), not a group-wide one.
  pinnedAt: number | null;
};

type GroupRow = {
  id: string;
  name: string;
  description: string;
  currency: string;
  motive: string;
  hue: number;
  photo_url: string | null;
  created_at: string;
};

// The groups query embeds the viewer's own group_members row (filtered to
// their user_id, so exactly one) to pick up their pin.
type GroupWithPinRow = GroupRow & {
  me: { pinned_at: string | null }[];
};

// Pinned groups first (most recently pinned on top), then everything else
// newest-created first.
function sortGroups(groups: Group[]): Group[] {
  return [...groups].sort((a, b) => {
    if (a.pinnedAt !== null || b.pinnedAt !== null) {
      return (b.pinnedAt ?? -Infinity) - (a.pinnedAt ?? -Infinity);
    }
    return b.createdAt - a.createdAt;
  });
}

function mapGroup(row: GroupWithPinRow): Group {
  const pinnedAt = row.me[0]?.pinned_at ?? null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currency: row.currency,
    heroMotive: row.motive,
    heroHue: row.hue,
    photoUrl: row.photo_url,
    createdAt: new Date(row.created_at).getTime(),
    pinnedAt: pinnedAt === null ? null : new Date(pinnedAt).getTime(),
  };
}

// currency deliberately excluded: changing it has to rescale every log's
// converted_amount (see change_group_currency in schema.sql), which a plain
// column update would silently skip. changeGroupCurrency below is the only
// path allowed to change it.
type GroupUpdates = Partial<Pick<Group, "name" | "description" | "heroMotive" | "heroHue" | "photoUrl">>;

type GroupsContextValue = {
  groups: Group[];
  isLoaded: boolean;
  addGroup: (
    name: string,
    description: string,
    currency: string,
    motive: string,
    hue: number,
    photoUrl: string | null
  ) => Promise<{ id?: string; error?: string }>;
  updateGroup: (id: string, updates: GroupUpdates) => Promise<void>;
  changeGroupCurrency: (id: string, currentCurrency: string, newCurrency: string) => Promise<{ error?: string }>;
  removeGroup: (id: string) => Promise<void>;
  setGroupPinned: (id: string, pinned: boolean) => Promise<{ error?: string }>;
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
      .select("*, me:group_members!inner(pinned_at)")
      .eq("me.user_id", userId);

    if (error) {
      // Offline (or otherwise failed): whatever's already showing — the
      // device's stored copy, if nothing else — stays up rather than blanking.
      console.warn("Failed to load groups", error);
    } else {
      const next = sortGroups((data ?? []).map(mapGroup));
      setGroups(next);
      writeUserData(userId, "groups", next);
      prefetchRatesForOffline(next.map((group) => group.currency));
    }
    setIsLoaded(true);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Show the device's last known copy straight away, so the app is
      // usable with no connection; the refresh below replaces it once (if)
      // the server answers.
      if (userId) {
        const stored = await readUserData<Group[]>(userId, "groups");
        if (cancelled) return;
        if (stored) {
          setGroups(stored);
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
  }, [userId, refresh]);

  const addGroup = useCallback(
    async (
      name: string,
      description: string,
      currency: string,
      motive: string,
      hue: number,
      photoUrl: string | null
    ) => {
      if (!userId) return { error: "Not signed in" };

      // Creating the group and joining it as its first member happen
      // atomically server-side (see create_group in schema.sql) rather than
      // as two separate client calls, so a dropped connection can't leave an
      // orphaned group that nobody, not even its creator, can ever see.
      const { data, error } = await supabase.rpc("create_group", {
        group_name: name,
        group_description: description,
        group_currency: currency,
        group_motive: motive,
        group_hue: hue,
        group_photo_url: photoUrl,
      });

      if (error) console.warn("Failed to create group", error);

      await refresh();
      return error ? { error: error.message } : { id: (data as GroupRow).id };
    },
    [userId, refresh]
  );

  const updateGroup = useCallback(
    async (id: string, updates: GroupUpdates) => {
      const { name, description, heroMotive, heroHue, photoUrl } = updates;
      const row: Partial<GroupRow> = {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(heroMotive !== undefined ? { motive: heroMotive } : {}),
        ...(heroHue !== undefined ? { hue: heroHue } : {}),
        ...(photoUrl !== undefined ? { photo_url: photoUrl } : {}),
      };
      const { error } = await supabase.from("groups").update(row).eq("id", id);
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

  const setGroupPinned = useCallback(
    async (id: string, pinned: boolean) => {
      // Reorder immediately rather than waiting on the round-trip; the
      // refresh below reconciles with the server either way (including
      // rolling this back if set_group_pinned rejected it).
      setGroups((prev) =>
        sortGroups(
          prev.map((group) =>
            group.id === id ? { ...group, pinnedAt: pinned ? Date.now() : null } : group
          )
        )
      );

      const { error } = await supabase.rpc("set_group_pinned", {
        p_group_id: id,
        p_pinned: pinned,
      });

      await refresh();

      if (error) {
        console.warn("Failed to pin group", error);
        return { error: error.message };
      }
      return {};
    },
    [refresh]
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
        setGroupPinned,
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
