import { Alert } from "react-native";

// The one place every not-yet-built feature's tap target routes through, so
// tapping a dead button always gives some feedback instead of silently doing
// nothing.
export function showComingSoon(feature: string) {
  Alert.alert("Feature coming soon", `${feature} isn't available yet.`);
}
