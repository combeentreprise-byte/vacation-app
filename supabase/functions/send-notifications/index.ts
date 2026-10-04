// Pushes every notification that's due (see "Notifications" in schema.sql)
// to its person's devices through Expo's push service, which hands them on
// to Apple / Google.
//
// Called every minute by pg_cron (trigger_notification_sender), never by the
// app. That call has no user session, so this is deployed with
// --no-verify-jwt and checks a shared secret instead: the x-cron-secret
// header must match NOTIFICATIONS_CRON_SECRET (set in the function secrets,
// and in Vault as 'notifications_cron_secret' for the caller).
//
// Database access is through the service role, which is the only role
// allowed to call claim_due_notifications and remove_push_tokens.

import { createClient } from "npm:@supabase/supabase-js@2";

const CRON_SECRET = Deno.env.get("NOTIFICATIONS_CRON_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Expo takes at most 100 messages per request.
const EXPO_BATCH_SIZE = 100;

type DueNotification = {
  id: string;
  title: string;
  body: string;
  url: string | null;
  tokens: string[];
};

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  sound: "default";
  // Matches the channel the app creates (src/utils/push-notifications.ts).
  channelId: "default";
  data: { url: string | null; notificationId: string };
};

type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string } };

Deno.serve(async (request) => {
  if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc("claim_due_notifications", { p_limit: 500 });
  if (error) {
    console.error("claim_due_notifications failed", error);
    return new Response(error.message, { status: 500 });
  }

  const messages: ExpoMessage[] = (data as DueNotification[]).flatMap((notification) =>
    notification.tokens.map((token) => ({
      to: token,
      title: notification.title,
      body: notification.body,
      sound: "default" as const,
      channelId: "default" as const,
      data: { url: notification.url, notificationId: notification.id },
    }))
  );

  // Tokens Expo says no longer reach a device (the app was uninstalled, or
  // notifications were reset): forgotten, so they aren't tried again.
  const deadTokens: string[] = [];
  let sent = 0;

  for (let start = 0; start < messages.length; start += EXPO_BATCH_SIZE) {
    const batch = messages.slice(start, start + EXPO_BATCH_SIZE);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
      const result = (await response.json()) as { data?: ExpoTicket[]; errors?: unknown };
      if (!response.ok || !result.data) {
        console.error("Expo push request failed", response.status, result.errors);
        continue;
      }
      result.data.forEach((ticket, index) => {
        if (ticket.status === "ok") {
          sent++;
        } else if (ticket.details?.error === "DeviceNotRegistered") {
          deadTokens.push(batch[index].to);
        } else {
          console.error("Expo push ticket error", ticket.message, ticket.details);
        }
      });
    } catch (fetchError) {
      // These notifications are already marked sent; a lost batch is just
      // lost rather than retried, so nobody gets the same one twice.
      console.error("Expo push request threw", fetchError);
    }
  }

  if (deadTokens.length > 0) {
    const { error: removeError } = await supabase.rpc("remove_push_tokens", {
      p_tokens: deadTokens,
    });
    if (removeError) console.error("remove_push_tokens failed", removeError);
  }

  return Response.json({
    notifications: (data as DueNotification[]).length,
    messages: messages.length,
    sent,
    removedTokens: deadTokens.length,
  });
});
