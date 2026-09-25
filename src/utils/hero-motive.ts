import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";

import BerlinMotive from "@/assets/motives/berlin.svg";
import DubaiMotive from "@/assets/motives/dubai.svg";
import IstanbulMotive from "@/assets/motives/istanbul.svg";
import MarrakeshMotive from "@/assets/motives/marrakesh.svg";
import ParisMotive from "@/assets/motives/paris.svg";
import ShanghaiMotive from "@/assets/motives/shanghai.svg";
import SydneyMotive from "@/assets/motives/sydney.svg";
import TaipeiMotive from "@/assets/motives/taipei.svg";
import TokyoMotive from "@/assets/motives/tokyo.svg";
import ViennaMotive from "@/assets/motives/vienna.svg";

// Each entry is a single-color line-art illustration (see assets/motives/) —
// svgr.config.js rewrites its traced fill to `currentColor` at import time,
// so HeroMotive can recolor it via a plain `color` prop instead of shipping
// a separate flat-color asset per motive per palette variation. Add new
// motives here as they're traced. `key` is what's actually stored on a group
// (see create_group in schema.sql) — keyed rather than index-based so
// reordering/inserting entries here never reshuffles what an existing
// group's stored key points to.
export const HERO_MOTIVES: { key: string; Motive: ComponentType<SvgProps> }[] = [
  { key: "berlin", Motive: BerlinMotive },
  { key: "dubai", Motive: DubaiMotive },
  { key: "istanbul", Motive: IstanbulMotive },
  { key: "marrakesh", Motive: MarrakeshMotive },
  { key: "paris", Motive: ParisMotive },
  { key: "shanghai", Motive: ShanghaiMotive },
  { key: "sydney", Motive: SydneyMotive },
  { key: "taipei", Motive: TaipeiMotive },
  { key: "tokyo", Motive: TokyoMotive },
  { key: "vienna", Motive: ViennaMotive },
];

// One hue per color variation, applied to whichever motive a group gets —
// the background is a pastel (light, softer) tint of the hue and the line
// art a more saturated shade of the *same* hue, derived below rather than
// stored as separate colors so the two always stay visually paired.
// Placeholder set — swap for the real palette once it's picked.
const HERO_HUES = [208, 350, 32, 160, 275, 12];

const BACKGROUND_SATURATION = 55;
const BACKGROUND_LIGHTNESS = 92;
const LINE_SATURATION = 60;
const LINE_LIGHTNESS = 32;

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) =>
    lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (n: number) =>
    Math.round(f(n) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

export type HeroMotiveVariant = {
  Motive: ComponentType<SvgProps>;
  background: string;
  line: string;
};

// Picks a uniformly random motive key + hue — used once at group-creation
// time (see new-group.tsx) for the initial preview and every reroll. The
// result is what actually gets stored on the group; nothing re-derives it
// after that.
export function pickRandomHeroMotive(): { motive: string; hue: number } {
  const { key } = HERO_MOTIVES[Math.floor(Math.random() * HERO_MOTIVES.length)];
  const hue = HERO_HUES[Math.floor(Math.random() * HERO_HUES.length)];
  return { motive: key, hue };
}

// Resolves a group's stored motive/hue (see the `groups.motive`/`groups.hue`
// columns) into the component + colors HeroMotive actually renders. Falls
// back to the first motive if a key doesn't match anything known here —
// which shouldn't happen for a stored value, but is cheaper than crashing.
export function resolveHeroMotiveVariant(motive: string, hue: number): HeroMotiveVariant {
  const entry = HERO_MOTIVES.find((candidate) => candidate.key === motive) ?? HERO_MOTIVES[0];
  return {
    Motive: entry.Motive,
    background: hslToHex(hue, BACKGROUND_SATURATION, BACKGROUND_LIGHTNESS),
    line: hslToHex(hue, LINE_SATURATION, LINE_LIGHTNESS),
  };
}
