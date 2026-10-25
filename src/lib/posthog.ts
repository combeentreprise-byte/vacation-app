import PostHog from "posthog-react-native";

const projectToken = process.env.EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST;

// Expo Router pre-renders the web build in Node, where there's no `window`
// and no storage for the client to persist to — same reason as the guard in
// supabase.ts. No client there; every call site uses `posthog?.`.
const isServer = typeof window === "undefined";

if (__DEV__ && !isServer && (!projectToken || !host)) {
  throw new Error(
    "Missing EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN or EXPO_PUBLIC_POSTHOG_HOST. Check your .env file."
  );
}

export const posthog =
  projectToken && host && !isServer
    ? new PostHog(projectToken, {
        host,
        captureAppLifecycleEvents: true,
        errorTracking: {
          autocapture: {
            uncaughtExceptions: true,
            unhandledRejections: true,
            console: [],
          },
        },
      })
    : undefined;
