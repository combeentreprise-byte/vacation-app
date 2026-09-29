import { Ionicons } from "@expo/vector-icons";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";

type ModalHeaderProps = {
  title: string;
  onClose: () => void;
};

// Header for the `presentation: "modal"` screens (new-group, add-entry,
// scan-pick-group). On iOS those open as a page sheet that already starts
// below the status bar, but useSafeAreaInsets still reports the full-screen
// notch inset — applying it there leaves a notch-sized gap above the title.
// Android (and web) modals are full-screen, so they still need the inset.
export function ModalHeader({ title, onClose }: ModalHeaderProps) {
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "ios" ? 0 : insets.top;

  return (
    <View style={[styles.header, { paddingTop: topInset + TOP_PADDING }]}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Pressable onPress={onClose} hitSlop={12}>
        <Ionicons name="close" size={24} color={Colors.text} />
      </Pressable>
    </View>
  );
}

// A bit more above than below: the title otherwise reads as crammed against
// the sheet's rounded top edge.
const TOP_PADDING = 28;
const BOTTOM_PADDING = 16;

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: BOTTOM_PADDING,
    backgroundColor: Colors.background,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
  },
});
