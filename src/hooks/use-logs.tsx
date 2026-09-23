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

type NewLogEntry = Omit<LogEntry, "id" | "createdAt" | "isSettlement">;

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
  settleDebt: (params: SettleDebtParams) => Promise<{ error?: string }>;
  deleteLog: (logId: string) => Promise<{ error?: string }>;
  refresh: () => Promise<void>;
};

const LogsContext = createContext<LogsContextValue | undefined>(undefined);

export function LogsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setLogs([]);
      setIsLoaded(true);
      return;
    }

    const { data, error } = await supabase
      .from("logs")
      .select("*, log_members(user_id)")
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Failed to load logs", error);
    } else {
      setLogs((data ?? []).map(mapLog));
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

  const addLog = useCallback(
    async (entry: NewLogEntry) => {
      // The log and its member-split land together in one RPC call, same
      // reasoning as create_group: two separate inserts could be interrupted
      // in between and leave a log with no recorded split.
      const { error } = await supabase.rpc("create_log", {
        p_group_id: entry.groupId,
        p_amount: entry.amount,
        p_converted_amount: entry.convertedAmount,
        p_currency: entry.currency,
        p_details: entry.details,
        p_payer_included: entry.payerIncluded,
        p_member_ids: entry.memberIds,
      });

      if (error) console.warn("Failed to create log", error);

      await refresh();
    },
    [refresh]
  );

  const settleDebt = useCallback(
    async (params: SettleDebtParams) => {
      const { error } = await supabase.rpc("settle_debt", {
        p_group_id: params.groupId,
        p_paid_by: params.paidBy,
        p_other_user_id: params.otherUserId,
        p_amount: params.amount,
        p_currency: params.currency,
      });

      if (error) {
        console.warn("Failed to settle debt", error);
        return { error: error.message };
      }

      await refresh();
      return {};
    },
    [refresh]
  );

  const deleteLog = useCallback(
    async (logId: string) => {
      // paid_by = auth.uid() is enforced server-side too (delete_log in
      // schema.sql); this just gives an early, friendlier error rather than
      // silently failing when the button shouldn't even be visible.
      const { error } = await supabase.rpc("delete_log", { p_log_id: logId });

      if (error) {
        console.warn("Failed to delete log", error);
        return { error: error.message };
      }

      await refresh();
      return {};
    },
    [refresh]
  );

  return (
    <LogsContext.Provider value={{ logs, isLoaded, addLog, settleDebt, deleteLog, refresh }}>
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
