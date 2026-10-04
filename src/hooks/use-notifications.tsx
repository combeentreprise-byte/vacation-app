import * as Notifications from "expo-notifications";
import { type Href, router, useRootNavigationState } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AppState } from "react-native";

import {
  DEFAULT_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/constants/notifications";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { requestErrorMessage } from "@/utils/network";
import { readUserData, writeUserData } from "@/utils/offline-storage";
import {
  canUsePush,
  getPushPermission,
  type PushPermission,
  registerForPushNotifications,
} from "@/utils/push-notifications";

// Account → Notifications, saved to notification_settings in schema.sql,
// which every notification the server sends checks first (notify()). Its
// switches are NOTIFICATION_SECTIONS in constants/notifications.ts.
export type NotificationSettings = {
  allMuted: boolean;
  categories: Record<NotificationCategory, boolean>;
};

const DEFAULT_SETTINGS: NotificationSettings = {
  allMuted: false,
  categories: DEFAULT_NOTIFICATION_CATEGORIES,
};

type NotificationSettingsRow = {
  all_muted: boolean;
  categories: Partial<Record<NotificationCategory, boolean>>;
  time_zone: string;
};

// The device's time zone, so dates in notifications ("ends on 12 Oct") are
// the person's own day.
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type NotificationsContextValue = {
  settings: NotificationSettings;
  // Saved straight away (online only, like other settings); put back and
  // explained if that fails.
  updateSettings: (next: NotificationSettings) => void;
  // Whether this phone lets the app show notifications at all.
  permission: PushPermission;
};

const NotificationsContext = createContext<NotificationsContextValue | undefined>(undefined);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [permission, setPermission] = useState<PushPermission>(
    canUsePush ? "undetermined" : "unavailable"
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setSettings(DEFAULT_SETTINGS);
      if (!userId) return;

      const stored = await readUserData<NotificationSettings>(userId, "notification-settings");
      if (cancelled) return;
      if (stored) {
        setSettings({
          allMuted: stored.allMuted,
          categories: { ...DEFAULT_NOTIFICATION_CATEGORIES, ...stored.categories },
        });
      }

      const { data, error } = await supabase
        .from("notification_settings")
        .select("all_muted, categories, time_zone")
        .eq("user_id", userId)
        .retry(false)
        .maybeSingle<NotificationSettingsRow>();
      if (cancelled) return;
      if (error) {
        // Offline: keep the device's copy.
        console.warn("Failed to load notification settings", error.message);
        return;
      }

      const next: NotificationSettings = data
        ? {
            allMuted: data.all_muted,
            categories: { ...DEFAULT_NOTIFICATION_CATEGORIES, ...data.categories },
          }
        : DEFAULT_SETTINGS;
      setSettings(next);
      writeUserData(userId, "notification-settings", next);

      const timeZone = deviceTimeZone();
      if (data?.time_zone !== timeZone) {
        const { error: zoneError } = await supabase
          .from("notification_settings")
          .upsert({ user_id: userId, time_zone: timeZone });
        if (zoneError) console.warn("Failed to save time zone", zoneError.message);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Registers this phone for push on every signed-in launch, and again when
  // the app comes back to the front while it isn't allowed yet (someone
  // turning notifications on in the phone's settings).
  useEffect(() => {
    if (!userId || !canUsePush) return;
    let cancelled = false;

    registerForPushNotifications().then((status) => {
      if (!cancelled) setPermission(status);
    });

    const subscription = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const status = await getPushPermission();
      if (cancelled) return;
      if (status === "granted") {
        setPermission(await registerForPushNotifications());
      } else {
        setPermission(status);
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [userId]);

  const updateSettings = useCallback(
    (next: NotificationSettings) => {
      if (!userId) return;
      const previous = settings;
      setSettings(next);
      supabase
        .from("notification_settings")
        .upsert({
          user_id: userId,
          all_muted: next.allMuted,
          categories: next.categories,
          time_zone: deviceTimeZone(),
        })
        .then(({ error, status }) => {
          if (error) {
            setSettings(previous);
            Alert.alert(
              "Couldn't save notification settings",
              requestErrorMessage(error.message, status)
            );
            return;
          }
          writeUserData(userId, "notification-settings", next);
        });
    },
    [userId, settings]
  );

  return (
    <NotificationsContext.Provider value={{ settings, updateSettings, permission }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationsProvider");
  }
  return context;
}

// Opens what a tapped notification is about (its `url`, set by the server —
// see docs/notifications.md), including the one that launched the app.
// Called from RootNavigator, once the signed-in screens exist.
export function useOpenTappedNotifications(enabled: boolean) {
  const rootNavigationState = useRootNavigationState();
  const isNavigationReady = !!rootNavigationState?.key;
  // getLastNotificationResponseAsync keeps returning the launch tap, so it's
  // only ever opened once.
  const openedIds = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !canUsePush || !isNavigationReady) return;

    const open = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (openedIds.current.has(id)) return;
      openedIds.current.add(id);
      const url = response.notification.request.content.data?.url;
      if (typeof url === "string" && url.startsWith("/")) {
        router.push(url as Href);
      }
    };

    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [enabled, isNavigationReady]);
}
