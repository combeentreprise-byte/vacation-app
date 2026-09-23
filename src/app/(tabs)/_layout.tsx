import type { MaterialTopTabBarProps } from "expo-router/js-top-tabs";
import { TopTabs } from "expo-router/js-top-tabs";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TabBar } from "@/components/tab-bar";
import { TABS } from "@/constants/tabs";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // Only the setter is needed now that nothing renders the active tab's
  // title (the blue PageHeader ribbon that used to read it is gone) — the
  // tab bar itself tracks and styles the active tab from its own nav state.
  const [, setActiveName] = useState<string>(TABS[0].name);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TopTabs
        tabBarPosition="bottom"
        tabBar={(props: MaterialTopTabBarProps) => (
          <TabBar {...props} onActiveChange={setActiveName} />
        )}
        style={styles.pager}
      >
        {TABS.map((tab) => (
          <TopTabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title }} />
        ))}
      </TopTabs>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
});
