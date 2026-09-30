import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";

import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { useSyncTriggers } from "@/hooks/use-sync-triggers";
import { supabase } from "@/lib/supabase";
import { isRetryableStatus, requestErrorMessage } from "@/utils/network";
import { readUserData, writeUserData } from "@/utils/offline-storage";

export type LogEntry = {
  id: string;
  groupId: string;
  amount: number;
  // Amount in the group's current currency — always what balances are
  // computed from, never `amount` directly (see schema.sql's converted_amount
  // comment for why: mixed-currency entries and group-currency changes both
  // rely on this being kept in sync, not the originally-entered amount).
  convertedAmount: number;
  currency: string;
  details: string;
  // Either can be null if the person who was part of the split (or who
  // paid) has since deleted their account (see delete_account in
  // schema.sql) — the row is kept, just with the reference nulled out, so
  // shareCount here never silently shrinks and changes everyone else's
  // historical balance. The client renders these as "Deleted user".
  memberIds: (string | null)[];
  paidBy: string | null;
  payerIncluded: boolean;
  isSettlement: boolean;
  createdAt: number;
  // Entered on this device but not on the server yet (see PendingLog) —
  // already counted in balances, just not visible to anyone else so far.
  isPending?: boolean;
  // A pending entry the server turned down because someone on it isn't
  // unlocked (see PendingLog.heldReason) — waiting for that to change rather
  // than syncing, and left out of balances until it does.
  isHeld?: boolean;
  heldReason?: string;
};

type LogRow = {
  id: string;
  group_id: string;
  amount: number;
  converted_amount: number;
  currency: string;
  details: string;
  paid_by: string | null;
  payer_included: boolean;
  is_settlement: boolean;
  created_at: string;
  log_members: { user_id: string | null }[];
};

function mapLog(row: LogRow): LogEntry {
  return {
    id: row.id,
    groupId: row.group_id,
    amount: row.amount,
    convertedAmount: row.converted_amount,
    currency: row.currency,
    details: row.details,
    memberIds: row.log_members.map((member) => member.user_id),
    paidBy: row.paid_by,
    payerIncluded: row.payer_included,
    isSettlement: row.is_settlement,
    createdAt: new Date(row.created_at).getTime(),
  };
}

type NewLogEntry = Omit<
  LogEntry,
  "id" | "createdAt" | "isSettlement" | "isPending" | "isHeld" | "heldReason"
> & {
  // The currency convertedAmount was computed in (the group's currency when
  // the form was submitted). Lets create_log rescale it if the group's
  // currency changes before a queued entry syncs.
  convertedCurrency: string;
};

// A log entered on this device that hasn't reached the server yet. Every
// new entry starts out as one of these — online or not — and is sent by
// flushPending as soon as possible; until then it lives in a queue saved on
// the device, so it survives the app being closed.
type PendingLog = {
  // Generated here rather than by the database, so a retry after a lost
  // response can't insert the expense twice (see create_log's p_id).
  id: string;
  groupId: string;
  amount: number;
  convertedAmount: number;
  convertedCurrency: string;
  currency: string;
  details: string;
  memberIds: (string | null)[];
  payerIncluded: boolean;
  createdAt: number;
  // Set when create_log turned it down with PT402: someone on it (maybe you)
  // isn't unlocked. Kept rather than dropped like other rejections, since
  // that can change — a seat handed out, a plan bought — and it's retried
  // whenever the queue syncs. heldReason is the server's own explanation.
  heldForUnlock?: boolean;
  heldReason?: string;
};

function pendingToEntry(log: PendingLog, userId: string): LogEntry {
  return {
    id: log.id,
    groupId: log.groupId,
    amount: log.amount,
    convertedAmount: log.convertedAmount,
    currency: log.currency,
    details: log.details,
    memberIds: log.memberIds,
    paidBy: userId,
    payerIncluded: log.payerIncluded,
    isSettlement: false,
    createdAt: log.createdAt,
    isPending: true,
    isHeld: !!log.heldForUnlock,
    heldReason: log.heldReason,
  };
}

const SYNCING_NOW_MESSAGE = "This entry is syncing right now. Try again in a moment.";

type SettleDebtParams = {
  groupId: string;
  paidBy: string;
  otherUserId: string;
  amount: number;
  currency: string;
};

type LogsContextValue = {
  logs: LogEntry[];
  isLoaded: boolean;
  addLog: (entry: NewLogEntry) => Promise<void>;
  updateLog: (logId: string, entry: NewLogEntry) => Promise<{ error?: string }>;
  settleDebt: (params: SettleDebtParams) => Promise<{ error?: string }>;
  deleteLog: (logId: string) => Promise<{ error?: string }>;
  refresh: () => Promise<void>;
  // Entries still waiting to reach the server (see PendingLog), held ones
  // included.
  pendingCount: number;
  // Tries the queue right away — e.g. after a purchase or a handed-out seat,
  // which may be what a held entry was waiting for.
  syncPending: () => void;
};

const LogsContext = createContext<LogsContextValue | undefined>(undefined);

export function LogsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const { groups } = useGroups();
  const [serverLogs, setServerLogs] = useState<LogEntry[]>([]);
  const [pendingLogs, setPendingLogs] = useState<PendingLog[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  // The queue's source of truth between renders: flushPending walks it
  // across several awaits and has to see entries edited, discarded or added
  // in the meantime, not the copy its closure captured.
  const pendingRef = useRef<PendingLog[]>([]);
  const isFlushingRef = useRef(false);
  // The queued entry whose create_log call is in flight right now — editing
  // or discarding it mid-request would be silently overwritten by the
  // version already on its way to the server.
  const syncingIdRef = useRef<string | null>(null);
  // Only read to name the group in a "couldn't be saved" alert.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const savePending = useCallback(
    (next: PendingLog[]) => {
      pendingRef.current = next;
      setPendingLogs(next);
      if (userId) writeUserData(userId, "pending-logs", next);
    },
    [userId]
  );

  const refresh = useCallback(async () => {
    if (!userId) {
      setServerLogs([]);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase
      .from("logs")
      .select("*, log_members(user_id)")
      .order("created_at", { ascending: false });

    if (error) {
      // Offline: keep showing what's there (see use-groups.tsx's refresh).
      console.warn("Failed to load logs", error);
    } else {
      const next = (data ?? []).map(mapLog);
      setServerLogs(next);
      writeUserData(userId, "logs", next);
    }
    setIsLoaded(true);
  }, [userId]);

  const flushPending = useCallback(async () => {
    if (!userId || isFlushingRef.current || pendingRef.current.length === 0) return;
    isFlushingRef.current = true;
    const rejected: { log: PendingLog; message: string }[] = [];
    const newlyHeld: { log: PendingLog; message: string }[] = [];
    let syncedAny = false;

    try {
      // An access token that expired while offline can't be refreshed until
      // the connection is back, and getSession comes back empty until then.
      // Sending anyway would go out as the anonymous role, which create_log
      // rejects as "not a member" — throwing away a perfectly good entry
      // over a connectivity blip.
      const { data } = await supabase.auth.getSession();
      if (data.session?.user.id !== userId) return;

      // Oldest first, one at a time, re-reading the queue each round so
      // entries added while this runs get sent too and discarded ones don't.
      const attempted = new Set<string>();
      for (;;) {
        const log = pendingRef.current.find((item) => !attempted.has(item.id));
        if (!log) break;
        attempted.add(log.id);

        syncingIdRef.current = log.id;
        const { error, status } = await supabase.rpc("create_log", {
          p_id: log.id,
          p_group_id: log.groupId,
          p_amount: log.amount,
          p_converted_amount: log.convertedAmount,
          p_converted_currency: log.convertedCurrency,
          p_currency: log.currency,
          p_details: log.details,
          p_payer_included: log.payerIncluded,
          p_member_ids: log.memberIds,
          p_created_at: new Date(log.createdAt).toISOString(),
        });
        syncingIdRef.current = null;

        // Still offline (or the server's having a moment): leave this and
        // everything after it queued for the next attempt, in order.
        if (error && isRetryableStatus(status)) break;

        // Someone on it isn't unlocked (see check_entry_access in
        // schema.sql). Unlike a real rejection that can change, so it stays
        // queued, marked, rather than being thrown away — and the entries
        // after it still go ahead.
        if (error?.code === "PT402") {
          if (!log.heldForUnlock) newlyHeld.push({ log, message: error.message });
          savePending(
            pendingRef.current.map((item) =>
              item.id === log.id
                ? { ...item, heldForUnlock: true, heldReason: error.message }
                : item
            )
          );
          continue;
        }

        savePending(pendingRef.current.filter((item) => item.id !== log.id));
        if (error) {
          // The server actually said no — e.g. you were removed from the
          // group while offline. Retrying would never succeed.
          console.warn("Failed to sync log", error);
          rejected.push({ log, message: error.message });
          continue;
        }

        syncedAny = true;
        // Stays on screen as a regular entry until the refresh below lands,
        // instead of blinking out between leaving the queue and the refetch.
        setServerLogs((prev) =>
          prev.some((item) => item.id === log.id)
            ? prev
            : [{ ...pendingToEntry(log, userId), isPending: false }, ...prev]
        );
      }
    } finally {
      syncingIdRef.current = null;
      isFlushingRef.current = false;
    }

    if (syncedAny) await refresh();

    const describe = ({ log, message }: { log: PendingLog; message: string }) => {
      const groupName = groupsRef.current.find((group) => group.id === log.groupId)?.name;
      const label = log.details ? `"${log.details}"` : `${log.amount} ${log.currency}`;
      return `${label}${groupName ? ` in ${groupName}` : ""}: ${message}`;
    };

    if (rejected.length > 0) {
      Alert.alert(
        rejected.length === 1 ? "An entry couldn't be saved" : "Some entries couldn't be saved",
        rejected.map(describe).join("\n\n")
      );
    }

    // Only when an entry first gets held, not on every retry that still
    // can't go through.
    if (newlyHeld.length > 0) {
      Alert.alert(
        newlyHeld.length === 1 ? "An entry needs an unlock" : "Some entries need an unlock",
        `${newlyHeld.map(describe).join("\n\n")}\n\n${
          newlyHeld.length === 1
            ? "It's kept on this device and syncs once everyone on it is unlocked. You can also edit or delete it."
            : "They're kept on this device and sync once everyone on them is unlocked. You can also edit or delete them."
        }`
      );
    }
  }, [userId, savePending, refresh]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!userId) {
        pendingRef.current = [];
        setPendingLogs([]);
      } else {
        // The device's last known logs and its own not-yet-synced ones
        // first, so the app works with no connection at all; the refresh
        // below replaces the former once (if) the server answers.
        const [storedLogs, storedPending] = await Promise.all([
          readUserData<LogEntry[]>(userId, "logs"),
          readUserData<PendingLog[]>(userId, "pending-logs"),
        ]);
        if (cancelled) return;
        pendingRef.current = storedPending ?? [];
        setPendingLogs(pendingRef.current);
        if (storedLogs) {
          setServerLogs(storedLogs);
          setIsLoaded(true);
        }
      }
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      flushPending();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [userId, refresh, flushPending]);

  // Held entries still go out on every other trigger, but don't keep the
  // 30-second retry running on their own: they're waiting on someone being
  // unlocked, not on the connection.
  useSyncTriggers(
    flushPending,
    pendingLogs.some((log) => !log.heldForUnlock)
  );

  const logs = useMemo(() => {
    if (!userId || pendingLogs.length === 0) return serverLogs;
    const pendingEntries = pendingLogs
      .filter((log) => !serverLogs.some((item) => item.id === log.id))
      .map((log) => pendingToEntry(log, userId));
    return [...pendingEntries, ...serverLogs].sort((a, b) => b.createdAt - a.createdAt);
  }, [userId, serverLogs, pendingLogs]);

  const addLog = useCallback(
    async (entry: NewLogEntry) => {
      if (!userId) return;
      // Queued even when online — one path for both cases, and the entry
      // shows up instantly rather than after a round trip. flushPending
      // sends it straight away if it can. The log and its member split
      // still land together in one create_log call (same reasoning as
      // create_group: two separate inserts could be interrupted in between
      // and leave a log with no recorded split).
      savePending([
        ...pendingRef.current,
        {
          id: Crypto.randomUUID(),
          groupId: entry.groupId,
          amount: entry.amount,
          convertedAmount: entry.convertedAmount,
          convertedCurrency: entry.convertedCurrency,
          currency: entry.currency,
          details: entry.details,
          memberIds: entry.memberIds,
          payerIncluded: entry.payerIncluded,
          createdAt: Date.now(),
        },
      ]);
      flushPending();
    },
    [userId, savePending, flushPending]
  );

  const updateLog = useCallback(
    async (logId: string, entry: NewLogEntry) => {
      // Not on the server yet, so there's nothing to update there — just
      // change what's queued.
      if (pendingRef.current.some((log) => log.id === logId)) {
        if (syncingIdRef.current === logId) return { error: SYNCING_NOW_MESSAGE };
        savePending(
          pendingRef.current.map((log) =>
            log.id === logId
              ? {
                  ...log,
                  amount: entry.amount,
                  convertedAmount: entry.convertedAmount,
                  convertedCurrency: entry.convertedCurrency,
                  currency: entry.currency,
                  details: entry.details,
                  memberIds: entry.memberIds,
                  payerIncluded: entry.payerIncluded,
                  // An edit (e.g. taking a locked person off it) may be
                  // exactly what a held entry was waiting for.
                  heldForUnlock: false,
                  heldReason: undefined,
                }
              : log
          )
        );
        flushPending();
        return {};
      }

      // paid_by = auth.uid() (and is_settlement = false) is enforced
      // server-side too (update_log in schema.sql) — same early-friendlier-
      // error reasoning as deleteLog below.
      const { error, status } = await supabase.rpc("update_log", {
        p_log_id: logId,
        p_amount: entry.amount,
        p_converted_amount: entry.convertedAmount,
        p_currency: entry.currency,
        p_details: entry.details,
        p_payer_included: entry.payerIncluded,
        p_member_ids: entry.memberIds,
      });

      if (error) {
        console.warn("Failed to update log", error);
        return { error: requestErrorMessage(error.message, status) };
      }

      await refresh();
      return {};
    },
    [savePending, refresh, flushPending]
  );

  const settleDebt = useCallback(
    async (params: SettleDebtParams) => {
      const { error, status } = await supabase.rpc("settle_debt", {
        p_group_id: params.groupId,
        p_paid_by: params.paidBy,
        p_other_user_id: params.otherUserId,
        p_amount: params.amount,
        p_currency: params.currency,
      });

      if (error) {
        console.warn("Failed to settle debt", error);
        return { error: requestErrorMessage(error.message, status) };
      }

      await refresh();
      return {};
    },
    [refresh]
  );

  const deleteLog = useCallback(
    async (logId: string) => {
      // Never reached the server — dropping it from the queue is the whole
      // delete.
      if (pendingRef.current.some((log) => log.id === logId)) {
        if (syncingIdRef.current === logId) return { error: SYNCING_NOW_MESSAGE };
        savePending(pendingRef.current.filter((log) => log.id !== logId));
        return {};
      }

      // paid_by = auth.uid() is enforced server-side too (delete_log in
      // schema.sql); this just gives an early, friendlier error rather than
      // silently failing when the button shouldn't even be visible.
      //
      // Optimistic: the entry is dropped locally before the RPC even goes
      // out, so the UI updates instantly, and put back if the delete fails.
      // No refresh() afterwards — balances derive from `logs`, so removing
      // the one row locally is already the full effect of the delete.
      const restored = serverLogs.find((log) => log.id === logId);
      setServerLogs((prev) => prev.filter((log) => log.id !== logId));

      const { error, status } = await supabase.rpc("delete_log", { p_log_id: logId });

      if (error) {
        console.warn("Failed to delete log", error);
        if (restored) {
          setServerLogs((prev) =>
            prev.some((log) => log.id === restored.id)
              ? prev
              : [...prev, restored].sort((a, b) => b.createdAt - a.createdAt)
          );
        }
        return { error: requestErrorMessage(error.message, status) };
      }

      return {};
    },
    [serverLogs, savePending]
  );

  return (
    <LogsContext.Provider
      value={{
        logs,
        isLoaded,
        addLog,
        updateLog,
        settleDebt,
        deleteLog,
        refresh,
        pendingCount: pendingLogs.length,
        syncPending: flushPending,
      }}
    >
      {children}
    </LogsContext.Provider>
  );
}

export function useLogs() {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useLogs must be used within a LogsProvider");
  }
  return context;
}
