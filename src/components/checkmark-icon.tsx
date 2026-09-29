import Svg, { Path } from "react-native-svg";

type CheckmarkIconProps = {
  size: number;
  color: string;
  strokeWidth?: number;
};

// Ionicons' "checkmark" drawn from its source SVG rather than the icon font,
// so its weight can be adjusted — the font glyph's is fixed. At the default
// strokeWidth (Ionicons' own, on its 512-unit viewBox) it's identical to
// <Ionicons name="checkmark" />.
export function CheckmarkIcon({ size, color, strokeWidth = 32 }: CheckmarkIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512">
      <Path
        d="M416 128L192 384l-96-96"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
