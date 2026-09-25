import { Ionicons } from "@expo/vector-icons";
import type { MaterialTopTabBarProps } from "expo-router/js-top-tabs";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { TABS } from "@/constants/tabs";

type TabBarProps = MaterialTopTabBarProps & {
  onActiveChange: (routeName: string) => void;
};

// Height of the tappable icon/label row, not counting the safe-area inset
// below it — the container centers this row within row height + inset so
// icons stay visually centered regardless of how tall that inset is.
const TAB_ROW_HEIGHT = 56;

const ACTIVE_COLOR = Colors.accent;
const INACTIVE_COLOR = "rgba(32, 138, 239, 0.45)";

export function TabBar({ state, navigation, onActiveChange }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const activeRouteName = state.routes[state.index].name;

  useEffect(() => {
    onActiveChange(activeRouteName);
  }, [activeRouteName, onActiveChange]);

  return (
    <View style={[styles.container, { height: TAB_ROW_HEIGHT + insets.bottom }]}>
      {TABS.map((tab) => {
        const isActive = tab.name === activeRouteName;
        return (
          <Pressable
            key={tab.name}
            style={styles.tab}
            onPress={() => navigation.navigate(tab.name)}
          >
            <Ionicons
              name={isActive ? tab.iconActive : tab.icon}
              size={24}
              color={isActive ? ACTIVE_COLOR : INACTIVE_COLOR}
            />
            <Text style={[styles.label, { color: isActive ? ACTIVE_COLOR : INACTIVE_COLOR }]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
  },
});
