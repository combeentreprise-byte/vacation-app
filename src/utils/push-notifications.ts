import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { supabase } from "@/lib/supabase";

// Getting this phone onto the server's list of devices to push to (see
// push_tokens and the send-notifications Edge Function). Push needs a phone
// (not the web build), a development or store build (Expo Go can't receive
// push on Android, and on iOS would get Expo Go's own identity), and the
// app's EAS project id, which only exists once EAS is set up — until then
// none of this does anything. Notifications are still recorded on the
// server, just not pushed anywhere.
const projectId: string | undefined =
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

export const canUsePush =
  Platform.OS !== "web" &&
  Constants.executionEnvironment !== ExecutionEnvironment.StoreClient &&
  !!projectId;

// "unavailable": this build can't receive push at all (see canUsePush).
export type PushPermission = "granted" | "denied" | "undetermined" | "unavailable";

// Matches channelId in the send-notifications Edge Function.
const ANDROID_CHANNEL_ID = "default";

if (canUsePush) {
  // Shown even while the app is open, like when it isn't.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// The token this device registered for the signed-in account, so signing
// out can take it off that account.
let registeredToken: string | null = null;

// Asks for permission the first time (the system only ever shows its prompt
// once — after that it's the phone's settings), then registers this device
// for the signed-in account. Run on every launch while signed in, so the
// token follows whoever signed in on this phone last.
export async function registerForPushNotifications(): Promise<PushPermission> {
  if (!canUsePush) return "unavailable";

  try {
    if (Platform.OS === "android") {
      // Has to exist before asking on Android 13+, or there's no prompt.
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: "Notifications",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status === "undetermined") {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== "granted") return status;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const { error } = await supabase.rpc("register_push_token", {
      p_token: token,
      p_platform: Platform.OS,
    });
    if (error) {
      console.warn("Couldn't register for push notifications", error.message);
    } else {
      registeredToken = token;
    }
    return "granted";
  } catch (error) {
    // No connection to Expo's push service, most likely; the next launch or
    // foreground tries again.
    console.warn("Couldn't get a push token", error);
    return "granted";
  }
}

export async function getPushPermission(): Promise<PushPermission> {
  if (!canUsePush) return "unavailable";
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

// Called right before signing out, so this phone stops getting that
// account's notifications. Best effort: offline, the token stays with the
// old account until someone signs in here again (register_push_token moves
// it).
export async function unregisterPushNotifications() {
  const token = registeredToken;
  registeredToken = null;
  if (!token) return;
  const { error } = await supabase.rpc("unregister_push_token", { p_token: token });
  if (error) console.warn("Couldn't unregister push notifications", error.message);
}
