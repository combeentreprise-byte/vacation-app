import Svg, { Path } from "react-native-svg";

// Tilt applied to every pin so it reads as a pushpin stuck in at an angle.
const PIN_ROTATION = "30deg";

type PinIconProps = {
  size: number;
  color: string;
  // Crossed-out variant, shown where tapping would unpin.
  crossed?: boolean;
  strokeWidth?: number;
};

// A hand-drawn, stroked take on MaterialCommunityIcons' "pin" — the icon-font
// glyph has a fixed, fairly heavy weight, whereas a stroke here can be as
// light as the surrounding outline icons.
export function PinIcon({ size, color, crossed = false, strokeWidth = 1.5 }: PinIconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: [{ rotate: PIN_ROTATION }] }}
    >
      <Path d="M7 3H17" />
      <Path d="M9 3V11.5L6.5 14.5H17.5L15 11.5V3" />
      <Path d="M12 14.5V21" />
      {crossed && <Path d="M4 4L20 20" />}
    </Svg>
  );
}
