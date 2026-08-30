import type { MaterialTopTabBarProps } from "expo-router/js-top-tabs";
import { TopTabs } from "expo-router/js-top-tabs";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { PageHeader } from "@/components/page-header";
import { TabBar } from "@/components/tab-bar";
import { TABS } from "@/constants/tabs";

export default function TabsLayout() {
  const [activeName, setActiveName] = useState<string>(TABS[0].name);
  const activeTab = TABS.find((tab) => tab.name === activeName) ?? TABS[0];

  return (
    <View style={styles.container}>
      <PageHeader title={activeTab.title} />
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
