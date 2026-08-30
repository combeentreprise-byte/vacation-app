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

export function TabBar({ state, navigation, onActiveChange }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const activeRouteName = state.routes[state.index].name;

  useEffect(() => {
    onActiveChange(activeRouteName);
  }, [activeRouteName, onActiveChange]);

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
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
              color={isActive ? Colors.accentText : Colors.accentTextMuted}
            />
            <Text
              style={[
                styles.label,
                { color: isActive ? Colors.accentText : Colors.accentTextMuted },
              ]}
            >
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
    backgroundColor: Colors.accent,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.2)",
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
  },
});
