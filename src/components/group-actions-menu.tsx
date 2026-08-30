import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { Dimensions, Pressable, StyleSheet, Text, View } from "react-native";

import type { MenuAnchor } from "@/components/create-or-join-menu";
import { Colors } from "@/constants/colors";

const BOX_WIDTH = 200;

type IoniconName = ComponentProps<typeof Ionicons>["name"];

type GroupActionsMenuProps = {
  anchor: MenuAnchor | null;
  onClose: () => void;
  onEdit: () => void;
  onInvite: () => void;
  onLeave: () => void;
};

export function GroupActionsMenu({
  anchor,
  onClose,
  onEdit,
  onInvite,
  onLeave,
}: GroupActionsMenuProps) {
  if (!anchor) {
    return null;
  }

  const screenWidth = Dimensions.get("window").width;
  const left = Math.min(Math.max(12, anchor.x - BOX_WIDTH + 16), screenWidth - BOX_WIDTH - 12);

  const items: { key: string; icon: IoniconName; label: string; danger?: boolean; onPress: () => void }[] = [
    { key: "edit", icon: "create-outline", label: "Edit group", onPress: onEdit },
    { key: "invite", icon: "person-add-outline", label: "Invite member", onPress: onInvite },
    { key: "leave", icon: "log-out-outline", label: "Leave group", danger: true, onPress: onLeave },
  ];

  return (
    <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
      <View style={[styles.box, { top: anchor.y + 8, left }]}>
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
      </View>
    </Pressable>
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
