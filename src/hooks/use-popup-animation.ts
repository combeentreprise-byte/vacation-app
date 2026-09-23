import { useEffect, useState } from "react";
import { Animated } from "react-native";

// Shared entrance/exit animation for every popup in the app (member/log
// detail overlays, the create-group menu, ...): the backdrop fades while the
// box scales up from a slight shrink, and reverses symmetrically on close.
// RN's Modal has no exit-animation hook of its own (setting visible={false}
// unmounts immediately), so this keeps the Modal mounted through the closing
// animation via its own `isMounted` state and only lets the caller's `isOpen`
// go false once that animation finishes.
export const POPUP_CLOSE_DURATION_MS = 160;

export function usePopupAnimation(isOpen: boolean) {
  const [isMounted, setIsMounted] = useState(isOpen);
  const [progress] = useState(() => new Animated.Value(isOpen ? 1 : 0));

  // Mounting has to happen in time for the entrance animation to have
  // something to animate, so it's applied directly during render (React's
  // documented pattern for "adjust state when a prop changes") rather than
  // in the effect below, which only kicks off the imperative Animated calls.
  if (isOpen && !isMounted) {
    setIsMounted(true);
  }

  useEffect(() => {
    if (isOpen) {
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        speed: 18,
        bounciness: 6,
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: POPUP_CLOSE_DURATION_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setIsMounted(false);
      });
    }
  }, [isOpen, progress]);

  return { isMounted, progress };
}

// Standard entrance/exit transform for a popup box driven by the `progress`
// value above — scales up from a slight shrink as it fades in.
export function popupScaleStyle(progress: Animated.Value) {
  return {
    opacity: progress,
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0.92, 1],
        }),
      },
    ],
  };
}
