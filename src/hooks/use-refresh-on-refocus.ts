import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";

// Calls `refresh` whenever the screen comes back into focus — e.g. back from
// /unlock with a freshly bought plan, which a per-screen hook like
// useGroupAccess wouldn't otherwise hear about. Not on the first focus: the
// hook's own first fetch already covers that.
export function useRefreshOnRefocus(refresh: () => unknown) {
  const hasFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasFocusedRef.current) refresh();
      hasFocusedRef.current = true;
    }, [refresh])
  );
}
