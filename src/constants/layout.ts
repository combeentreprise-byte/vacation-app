// Screen proportions shared by a screen and its loading skeleton
// (components/screen-skeletons.tsx), so the skeleton lines up with what
// replaces it.

// The group list's cards: every card is a fixed slice of the screen rather
// than sized to its own content, so the list reads as evenly spaced rows
// regardless of how long a name/description runs.
export const GROUP_CARD_HEIGHT_RATIO = 0.2;
export const GROUP_LIST_PADDING = 20;

// The group screen's hero photo placeholder's collapsed height (same idea as
// the group list's fixed-ratio cards, just sized for a full-bleed
// detail-page hero rather than a small list row).
export const GROUP_HERO_HEIGHT_RATIO = 0.28;

// The group screen's summary bar's own height above insets.bottom (its text
// is centered within this + the inset) — used to lift the FAB clear of it,
// since the bar itself has no ListFooter/layout the FAB could measure.
export const GROUP_SUMMARY_BAR_HEIGHT = 50;
