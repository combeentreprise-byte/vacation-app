import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";

const BOX_WIDTH = 220;

export type MenuAnchor = { x: number; y: number };

type CreateOrJoinMenuProps = {
  anchor: MenuAnchor | null;
  onClose: () => void;
  onCreate: () => void;
  onJoin: () => void;
};

export function CreateOrJoinMenu({ anchor, onClose, onCreate, onJoin }: CreateOrJoinMenuProps) {
  const screenWidth = Dimensions.get("window").width;
  const left = anchor
    ? Math.min(Math.max(12, anchor.x - BOX_WIDTH / 2), screenWidth - BOX_WIDTH - 12)
    : 0;

  return (
    <Modal transparent visible={!!anchor} animationType="fade" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        {anchor ? (
          <View style={[styles.box, { top: anchor.y + 8, left }]}>
            <Pressable style={styles.item} onPress={onCreate}>
              <Text style={styles.itemText}>Create group</Text>
            </Pressable>
            <View style={styles.divider} />
            <Pressable style={styles.item} onPress={onJoin}>
              <Text style={styles.itemText}>Join group</Text>
            </Pressable>
          </View>
        ) : null}
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    width: BOX_WIDTH,
    flexDirection: "row",
    backgroundColor: Colors.background,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  item: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
    textAlign: "center",
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    backgroundColor: Colors.border,
  },
});
