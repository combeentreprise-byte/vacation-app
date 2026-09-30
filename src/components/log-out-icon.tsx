import { Animated } from "react-native";
import Svg, { Path } from "react-native-svg";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// Extra room to the right of the glyph's own 512-unit box, so the arrow has
// somewhere to shoot into without being clipped by the Svg's bounds.
const STRETCH_ROOM = 200;
// How far (in viewBox units) the whole arrow sits forward of rest once
// sprung out.
const TRAVEL = 110;
// How far behind the leading end the trailing end starts, as a fraction of
// the whole timeline.
const LAG = 0.18;

type Keyframe = [time: number, value: number];

// One end of the arrow moving from 0 to 1 over its own time: overshoot,
// bounce back short, settle — a hand-rolled spring.
const SPRING: Keyframe[] = [
  [0, 0],
  [0.4, 1.25],
  [0.65, 0.92],
  [0.82, 1.03],
  [1, 1],
];

// A softer spring for the tail catching up on the way out: one small
// overshoot, no second bounce, so it doesn't keep wobbling after the head
// has already settled.
const DAMPED_SPRING: Keyframe[] = [
  [0, 0],
  [0.55, 1.1],
  [1, 1],
];
// How much of the timeline the tail's catch-up takes on the way out —
// short enough that it finishes just before the head's own settle does.
const DAMPED_SPAN = 0.6;

function springTrack(delay: number, shape = SPRING, span = 1 - LAG): Keyframe[] {
  return shape.map(([time, value]) => [delay + time * span, value]);
}

function sampleTrack(track: Keyframe[], time: number) {
  if (time <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [endTime, endValue] = track[i];
    if (time <= endTime) {
      const [startTime, startValue] = track[i - 1];
      return startValue + ((endValue - startValue) * (time - startTime)) / (endTime - startTime);
    }
  }
  return track[track.length - 1][1];
}

// "out" (progress 0 → 1): the head springs forward and the tail follows.
// "back" (progress 1 → 0): the tail springs back first and the head
// follows. Both agree at 0 (rest) and 1 (sprung forward), so switching
// direction at either end is seamless.
export type LogOutIconDirection = "out" | "back";

type LogOutIconProps = {
  size: number;
  color: string;
  // 0 = arrow at rest, 1 = sprung forward. Must be driven with
  // useNativeDriver: false, since it animates path data rather than a
  // transform.
  progress: Animated.Value;
  direction: LogOutIconDirection;
};

// Ionicons' "log-out-outline" drawn from its source SVG rather than the icon
// font, with the arrow split off from the door so its head and tail can
// move on their own. At rest it's identical to
// <Ionicons name="log-out-outline" />, and it takes up the same size×size
// layout box — the stretch room hangs off the right as negative margin.
export function LogOutIcon({ size, color, progress, direction }: LogOutIconProps) {
  const extraWidth = (size * STRETCH_ROOM) / 512;
  const isOut = direction === "out";
  // Tracks run on each direction's own elapsed time: equal to progress going
  // out, but 1 - progress coming back, since that plays 1 → 0.
  const headTrack = springTrack(isOut ? 0 : LAG);
  const tailTrack = isOut ? springTrack(LAG, DAMPED_SPRING, DAMPED_SPAN) : springTrack(0);
  const offsetAt = (track: Keyframe[], elapsed: number) =>
    (isOut ? sampleTrack(track, elapsed) : 1 - sampleTrack(track, elapsed)) * TRAVEL;
  // Both ends are baked into each keyframe's path string, so the keyframes
  // need every breakpoint from either end's track.
  const elapsedTimes = [...new Set([...headTrack, ...tailTrack].map(([time]) => time))];
  const keyframes = elapsedTimes
    .map((elapsed) => ({
      progress: isOut ? elapsed : 1 - elapsed,
      head: offsetAt(headTrack, elapsed),
      tail: offsetAt(tailTrack, elapsed),
    }))
    .sort((a, b) => a.progress - b.progress);
  const inputRange = keyframes.map((keyframe) => keyframe.progress);
  const shaft = progress.interpolate({
    inputRange,
    outputRange: keyframes.map(({ head, tail }) => `M${176 + tail} 256H${432 + head}`),
  });
  const head = progress.interpolate({
    inputRange,
    outputRange: keyframes.map(({ head: offset }) => `M${368 + offset} 336l80-80-80-80`),
  });
  const strokeProps = {
    fill: "none",
    stroke: color,
    strokeWidth: 32,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;

  return (
    <Svg
      width={size + extraWidth}
      height={size}
      viewBox={`0 0 ${512 + STRETCH_ROOM} 512`}
      style={{ marginRight: -extraWidth }}
    >
      <Path
        d="M304 336v40a40 40 0 01-40 40H104a40 40 0 01-40-40V136a40 40 0 0140-40h152c22.09 0 48 17.91 48 40v40"
        {...strokeProps}
      />
      <AnimatedPath d={shaft} {...strokeProps} />
      <AnimatedPath d={head} {...strokeProps} />
    </Svg>
  );
}
