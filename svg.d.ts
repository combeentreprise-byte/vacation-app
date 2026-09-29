declare module "*.svg" {
  import type { FC } from "react";
  import type { SvgProps } from "react-native-svg";

  // `holeColor` fills a motive's light "hole" shapes (see svgr.config.js).
  const content: FC<SvgProps & { holeColor?: string }>;
  export default content;
}
