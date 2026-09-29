import { Ionicons } from "@expo/vector-icons";
import type { MaterialTopTabBarProps } from "expo-router/js-top-tabs";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { TABS, type TabConfig } from "@/constants/tabs";

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
            <TabIcon tab={tab} isActive={isActive} />
            <Text style={[styles.label, { color: isActive ? ACTIVE_COLOR : INACTIVE_COLOR }]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Plays the tab's own one-shot animation each time it becomes active. Keyed
// off `isActive` rather than the press handler so a swipe between pages
// triggers it exactly like a tap does — both just change the navigator's
// active index. Skipped on first mount so the initial tab doesn't animate
// on app launch.
function TabIcon({ tab, isActive }: { tab: TabConfig; isActive: boolean }) {
  const translateY = useSharedValue(0);
  const rotate = useSharedValue(0);
  const scale = useSharedValue(1);
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (!isActive) return;

    scale.value = withSequence(
      withTiming(1.15, { duration: 120, easing: Easing.out(Easing.quad) }),
      withTiming(1, { duration: 160, easing: Easing.inOut(Easing.quad) }),
    );

    switch (tab.animation) {
      case "hop":
        translateY.value = withSequence(
          withTiming(-7, { duration: 130, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 170, easing: Easing.in(Easing.quad) }),
        );
        break;
      case "wiggle":
        rotate.value = withSequence(
          withTiming(-14, { duration: 120 }),
          withTiming(10, { duration: 160 }),
          withTiming(-5, { duration: 140 }),
          withTiming(0, { duration: 120 }),
        );
        break;
      case "spin":
        // A full turn, reset to 0 first so repeat visits spin again rather
        // than animating from 360 to 360. The gear looks identical at 0°
        // and 360°, so the reset is invisible.
        rotate.value = 0;
        rotate.value = withTiming(360, {
          duration: 750,
          easing: Easing.out(Easing.cubic),
        });
        break;
    }
  }, [isActive, tab.animation, translateY, rotate, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Ionicons
        name={isActive ? tab.iconActive : tab.icon}
        size={24}
        color={isActive ? ACTIVE_COLOR : INACTIVE_COLOR}
      />
    </Animated.View>
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
