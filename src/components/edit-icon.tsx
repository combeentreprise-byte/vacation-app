import Svg, { Path } from "react-native-svg";

// Ionicons' own stroke width for "create-outline", on its 512-unit viewBox.
const BASE_STROKE_WIDTH = 32;

type EditIconProps = {
  size: number;
  color: string;
  strokeWidth?: number;
};

// Ionicons' "create-outline" drawn from its source SVG rather than the icon
// font, so its weight can be adjusted — the font glyph's is fixed. At the
// default strokeWidth it's identical to <Ionicons name="create-outline" />.
export function EditIcon({ size, color, strokeWidth = BASE_STROKE_WIDTH }: EditIconProps) {
  // The pencil is a filled shape, not a stroke, so it's thickened by the
  // same amount via an outline stroke of the extra width.
  const extraWidth = Math.max(0, strokeWidth - BASE_STROKE_WIDTH);
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512">
      <Path
        d="M384 224v184a40 40 0 01-40 40H104a40 40 0 01-40-40V168a40 40 0 0140-40h167.48"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M459.94 53.25a16.06 16.06 0 00-23.22-.56L424.35 65a8 8 0 000 11.31l11.34 11.32a8 8 0 0011.34 0l12.06-12c6.1-6.09 6.67-16.01.85-22.38zM399.34 90L218.82 270.2a9 9 0 00-2.31 3.93L208.16 299a3.91 3.91 0 004.86 4.86l24.85-8.35a9 9 0 003.93-2.31L422 112.66a9 9 0 000-12.66l-9.95-10a9 9 0 00-12.71 0z"
        fill={color}
        stroke={extraWidth > 0 ? color : "none"}
        strokeWidth={extraWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
