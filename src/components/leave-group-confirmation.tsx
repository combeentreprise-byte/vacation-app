import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";

// Shared by every leave-group confirmation popup (the group screen's
// GroupActionsMenu and the group list's LeaveGroupPopup), so the wording and
// buttons can't drift apart between the two. `isLastMember` switches to the
// copy warning that leaving deletes the group — leave_group itself
// (schema.sql) decides that server-side, so this only picks the warning.

export const LEAVE_CONFIRMATION_WIDTH = 280;
// Horizontal inset of the title and message, matching the menu rows'.
export const LEAVE_CONFIRMATION_PADDING_X = 16;

export function leaveConfirmationTitle(isLastMember: boolean) {
  return isLastMember ? "Delete group?" : "Leave group?";
}

// Everything below the title: the message and the Cancel / confirm buttons.
export function LeaveGroupConfirmationBody({
  isLastMember,
  onCancel,
  onConfirm,
}: {
  isLastMember: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmationBody
      message={
        isLastMember
          ? "You're the last member of this group. Leaving will permanently delete the group and all its logs and balances — this can't be undone."
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
          <Text style={styles.cancelButtonText}>Cancel</Text>
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
