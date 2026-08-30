import { Ionicons } from "@expo/vector-icons";
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";

type PageHeaderProps = {
  title?: string;
  onBack?: () => void;
  rightIcon?: "ellipsis" | "checkmark";
  onRightPress?: (event: GestureResponderEvent) => void;
};

function EllipsisIcon() {
  return (
    <View style={styles.ellipsisRow}>
      <View style={styles.dot} />
      <View style={styles.dot} />
      <View style={styles.dot} />
    </View>
  );
}

export function PageHeader({ title, onBack, rightIcon = "ellipsis", onRightPress }: PageHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <View style={styles.left}>
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={12} style={styles.backButton}>
              <Ionicons name="chevron-back" size={24} color={Colors.accentText} />
            </Pressable>
          ) : null}
          {title ? <Text style={styles.title}>{title}</Text> : null}
        </View>
        {onRightPress ? (
          <Pressable onPress={onRightPress} hitSlop={12}>
            {rightIcon === "checkmark" ? (
              <Ionicons name="checkmark" size={24} color={Colors.accentText} />
            ) : (
              <EllipsisIcon />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 30,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
  },
  backButton: {
    marginLeft: -6,
    marginRight: 2,
  },
  title: {
    color: Colors.accentText,
    fontSize: 20,
    fontWeight: "600",
  },
  ellipsisRow: {
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    width: 22,
    paddingVertical: 2,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.accentText,
  },
});
