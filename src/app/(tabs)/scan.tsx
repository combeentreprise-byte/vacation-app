import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";
import { showComingSoon } from "@/utils/coming-soon";

export default function ScanScreen() {
  const handlePress = () => showComingSoon("Scanning receipts");

  return (
    <View style={styles.container}>
      <Pressable onPress={handlePress} hitSlop={12}>
        <Ionicons name="camera-outline" size={28} color={Colors.muted} />
      </Pressable>
      <Pressable onPress={handlePress}>
        <Text style={styles.text}>Scan a receipt</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  text: {
    color: Colors.muted,
    fontSize: 15,
  },
});
