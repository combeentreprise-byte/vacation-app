import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Avatar } from "@/components/avatar";
import { Colors } from "@/constants/colors";

export type PlanMemberStatusTone = "muted" | "success" | "warning";

const STATUS_COLORS: Record<PlanMemberStatusTone, string> = {
  muted: Colors.muted,
  success: Colors.success,
  warning: Colors.warning,
};

// One person in a plan's member list (the seat picker in unlock.tsx and the
// group plan screen): who they are, where they stand — has a seat, unlocked
// until when, locked — and whatever control goes on the right (a checkbox,
// a "Give seat" button). The whole row is the tap target when onPress is set.
export function PlanMemberRow({
  name,
  label = name,
  avatarUrl,
  isActive = true,
  status,
  statusTone = "muted",
  accessory,
  onPress,
  disabled = false,
  children,
}: {
  name: string;
  // Shown instead of `name` (e.g. "You"), while the avatar's initials still
  // come from the real name.
  label?: string;
  avatarUrl: string | null;
  // Grayed out like the Members tab's rows for someone who left the group.
  isActive?: boolean;
  status?: string;
  statusTone?: PlanMemberStatusTone;
  accessory?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  // Anything shown under the row inside the same card, e.g. a confirmation.
  children?: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        style={[styles.row, disabled && styles.rowDisabled]}
        onPress={onPress}
        disabled={!onPress || disabled}
      >
        <Avatar
          name={name}
          avatarUrl={avatarUrl}
          style={[styles.avatar, !isActive && styles.avatarInactive]}
          textStyle={styles.avatarText}
        />
        <View style={styles.textColumn}>
          <Text style={[styles.name, !isActive && styles.nameInactive]} numberOfLines={1}>
            {label}
          </Text>
          {status ? (
            <Text style={[styles.status, { color: STATUS_COLORS[statusTone] }]}>{status}</Text>
          ) : null}
        </View>
        {accessory}
      </Pressable>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same card look as the group screen's member rows.
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarInactive: {
    backgroundColor: Colors.muted,
  },
  avatarText: {
    color: Colors.accentText,
    fontSize: 14,
    fontWeight: "700",
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  nameInactive: {
    color: Colors.muted,
  },
  status: {
    fontSize: 13,
  },
});
