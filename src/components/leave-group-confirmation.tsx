import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";
import { formatAccessDate } from "@/utils/access";

// Shared by every leave-group confirmation popup (the group screen's
// GroupActionsMenu and the group list's LeaveGroupPopup), so the wording and
// buttons can't drift apart between the two. `isLastMember` switches to the
// copy warning that leaving deletes the group — leave_group itself
// (schema.sql) decides that server-side, so this only picks the warning.
// `isSponsor` adds that the sponsor role passes to someone else for good, and
// `seatStartsAt` (the start of the group's pass, when the leaver holds a
// seat on it and it hasn't started) that leaving gives that seat up
// (free_pending_plan_seat in schema.sql).

export const LEAVE_CONFIRMATION_WIDTH = 280;
// Horizontal inset of the title and message, matching the menu rows'.
export const LEAVE_CONFIRMATION_PADDING_X = 16;

export function leaveConfirmationTitle(isLastMember: boolean) {
  return isLastMember ? "Delete group?" : "Leave group?";
}

// Everything below the title: the message and the Cancel / confirm buttons.
export function LeaveGroupConfirmationBody({
  isLastMember,
  isSponsor = false,
  seatStartsAt = null,
  onCancel,
  onConfirm,
}: {
  isLastMember: boolean;
  isSponsor?: boolean;
  seatStartsAt?: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const seatDate = seatStartsAt !== null ? formatAccessDate(seatStartsAt) : null;
  return (
    <ConfirmationBody
      message={
        isLastMember
          ? "You're the last member of this group. Leaving will permanently delete the group and all its logs and balances — this can't be undone."
          : isSponsor
            ? `You're this group's sponsor. If you leave, another member becomes the sponsor, and you won't get it back even if you rejoin.${
                seatDate ? ` You'll also give up your seat on its pass starting ${seatDate}.` : ""
              }`
            : seatDate
              ? `You have a seat on this group's pass starting ${seatDate}. If you leave, you give it up — rejoining won't bring it back, only the sponsor can give it to you again.`
              : "Are you sure you want to leave this group?"
      }
      confirmLabel={isLastMember ? "Delete" : "Leave"}
      destructive
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

// The generic message + Cancel / confirm buttons behind every in-place
// confirmation morph (leave group here, and the member popup's promote /
// kick / settle in group/[id].tsx), so they all look the same. The insets
// default to the menu's; a popup whose title sits flush left passes its own.
export function ConfirmationBody({
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  disabled = false,
  messageInset = LEAVE_CONFIRMATION_PADDING_X,
  buttonsInset = 12,
  fill = false,
  onCancel,
  onConfirm,
}: {
  message: string;
  confirmLabel: string;
  // For when "Cancel" itself would be ambiguous ("Cancel subscription").
  cancelLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  messageInset?: number;
  buttonsInset?: number;
  // Stretches to fill its parent, with the buttons pinned to the bottom
  // (for a confirmation shown inside a fixed-size area).
  fill?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={fill && styles.fill}>
      <Text style={[styles.message, fill && styles.fillMessage, { paddingHorizontal: messageInset }]}>
        {message}
      </Text>
      <View
        style={[styles.buttonRow, fill && styles.fillButtonRow, { paddingHorizontal: buttonsInset }]}
      >
        <Pressable
          style={[styles.button, styles.cancelButton, disabled && styles.buttonDisabled]}
          onPress={onCancel}
          disabled={disabled}
        >
          <Text style={styles.cancelButtonText}>{cancelLabel}</Text>
        </Pressable>
        <Pressable
          style={[
            styles.button,
            destructive ? styles.destructiveButton : styles.confirmButton,
            disabled && styles.buttonDisabled,
          ]}
          onPress={onConfirm}
          disabled={disabled}
        >
          <Text style={styles.confirmButtonText}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  fillMessage: {
    paddingTop: 6,
  },
  fillButtonRow: {
    marginTop: "auto",
    paddingBottom: 0,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.muted,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    paddingTop: 16,
    paddingBottom: 6,
  },
  button: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
  },
  cancelButton: {
    backgroundColor: Colors.border,
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  confirmButton: {
    backgroundColor: Colors.accent,
  },
  destructiveButton: {
    backgroundColor: Colors.danger,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.accentText,
  },
});
