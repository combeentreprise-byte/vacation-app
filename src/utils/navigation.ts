import { router } from "expo-router";

// Screens like /group/[id] and /join/[id] can be entered directly via a deep
// link (invite links, notifications) with no prior screen in history, so
// router.back() has nothing to return to and silently no-ops. Falling back
// to the group list keeps "back" always doing something sensible.
export function goBackOrToGroups() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/");
  }
}
