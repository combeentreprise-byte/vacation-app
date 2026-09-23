import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useState } from "react";
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import type { MenuAnchor } from "@/components/menu-anchor";
import { Colors } from "@/constants/colors";
import { popupScaleStyle, usePopupAnimation } from "@/hooks/use-popup-animation";

const BOX_WIDTH = 200;

type IoniconName = ComponentProps<typeof Ionicons>["name"];

type GroupActionsMenuProps = {
  anchor: MenuAnchor | null;
  onClose: () => void;
  onEdit: () => void;
  onInvite: () => void;
  onLeave: () => void;
  // Editing name/description/currency is admin-only; non-admins don't get
  // the option at all rather than seeing it fail after tapping it.
  canEdit: boolean;
};

export function GroupActionsMenu({
  anchor,
  onClose,
  onEdit,
  onInvite,
  onLeave,
  canEdit,
}: GroupActionsMenuProps) {
  const { isMounted, progress } = usePopupAnimation(!!anchor);
  // Kept in sync only while anchor is set, so the box doesn't jump to the
  // top-left corner while it animates closed (the Modal stays mounted for
  // that whole animation — see usePopupAnimation). Set directly during
  // render (not an effect) per React's documented pattern for adjusting
  // state in response to a prop change.
  const [displayAnchor, setDisplayAnchor] = useState(anchor);
  if (anchor && anchor !== displayAnchor) {
    setDisplayAnchor(anchor);
  }

  const screenWidth = Dimensions.get("window").width;
  const left = displayAnchor
    ? Math.min(Math.max(12, displayAnchor.x - BOX_WIDTH + 16), screenWidth - BOX_WIDTH - 12)
    : 0;

  const items: { key: string; icon: IoniconName; label: string; danger?: boolean; onPress: () => void }[] = [
    ...(canEdit
      ? [{ key: "edit", icon: "create-outline" as IoniconName, label: "Edit group", onPress: onEdit }]
      : []),
    { key: "invite", icon: "person-add-outline", label: "Invite member", onPress: onInvite },
    { key: "leave", icon: "log-out-outline", label: "Leave group", danger: true, onPress: onLeave },
  ];

  return (
    <Modal transparent visible={isMounted} animationType="none" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        {displayAnchor ? (
          <Animated.View
            style={[styles.box, { top: displayAnchor.y + 8, left }, popupScaleStyle(progress)]}
          >
            {items.map((item, index) => (
              <View key={item.key}>
                {index > 0 ? <View style={styles.divider} /> : null}
                <Pressable style={styles.item} onPress={item.onPress}>
                  <Ionicons
                    name={item.icon}
                    size={18}
                    color={item.danger ? Colors.danger : Colors.text}
                  />
                  <Text style={[styles.itemText, item.danger && styles.itemTextDanger]}>
                    {item.label}
                  </Text>
                </Pressable>
              </View>
            ))}
          </Animated.View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    width: BOX_WIDTH,
    backgroundColor: Colors.background,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  itemText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  itemTextDanger: {
    color: Colors.danger,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
});
