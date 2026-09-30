// What can be bought to unlock entries (see "Plans" in supabase/schema.sql).
// Each list mirrors what test_purchase_plan there accepts — change both
// together.

export type PlanKind = "trip_pass" | "subscription";
export type PlanPeriod = "week" | "two_weeks" | "month" | "year";

// A Trip Pass is paid once and simply ends; a subscription renews until
// cancelled.
export const PLAN_PERIODS: {
  key: PlanPeriod;
  kind: PlanKind;
  label: string;
  // Only used to work out, before buying, when a plan bought now would end.
  days: number;
}[] = [
  { key: "week", kind: "trip_pass", label: "1 week", days: 7 },
  { key: "two_weeks", kind: "trip_pass", label: "2 weeks", days: 14 },
  { key: "month", kind: "subscription", label: "Monthly", days: 30 },
  { key: "year", kind: "subscription", label: "Yearly", days: 365 },
];

// "Just me" is a single seat for the buyer, tied to no group. The group sizes
// are how many seats the sponsor can hand out to the group's members,
// themselves included.
export const JUST_ME_SEATS = 1;
export const GROUP_PLAN_SIZES = [4, 8, 15] as const;

// Mid-sentence: "Alex's Trip Pass", "your plan".
export function planKindLabel(kind: PlanKind) {
  return kind === "trip_pass" ? "Trip Pass" : "plan";
}

// Placeholder prices in euros until real store products exist, per length
// and size ("Just me" is the 1-seat column).
const PLAN_PRICES: Record<PlanPeriod, Record<number, number>> = {
  week: { 1: 2.99, 4: 7.99, 8: 12.99, 15: 19.99 },
  two_weeks: { 1: 4.99, 4: 12.99, 8: 19.99, 15: 31.99 },
  month: { 1: 3.99, 4: 9.99, 8: 15.99, 15: 25.99 },
  year: { 1: 29.99, 4: 79.99, 8: 129.99, 15: 199.99 },
};

// What a plan of this length and size costs. A size that isn't sold (a plan
// that had seats added one at a time) is priced between its neighbours.
export function planPrice(period: PlanPeriod, seatCount: number) {
  const prices = PLAN_PRICES[period];
  if (prices[seatCount] !== undefined) return prices[seatCount];
  const sizes = [JUST_ME_SEATS, ...GROUP_PLAN_SIZES];
  const above = sizes.find((size) => size > seatCount) ?? sizes[sizes.length - 1];
  const below = [...sizes].reverse().find((size) => size < seatCount) ?? sizes[0];
  if (above === below) return prices[above];
  return prices[below] + ((prices[above] - prices[below]) * (seatCount - below)) / (above - below);
}

export function formatPrice(amount: number) {
  return `€${amount.toFixed(2)}`;
}

// Which length a plan running from startsAt to endsAt was bought as. A Trip
// Pass always lasts exactly its length, since the only way to lengthen one
// (upgrade_plan) sets its end from its start. A subscription is judged by
// its first term (test ones never renew; store ones will need their product
// id instead). Null when the start isn't known.
export function planPeriodOf(kind: PlanKind, startsAt: number | null, endsAt: number) {
  if (startsAt === null) return null;
  const days = Math.round((endsAt - startsAt) / 86_400_000);
  if (kind === "subscription") {
    return PLAN_PERIODS.find((item) => item.key === (days <= 31 ? "month" : "year")) ?? null;
  }
  return PLAN_PERIODS.find((item) => item.kind === "trip_pass" && item.days === days) ?? null;
}

// A group plan's own title. Given its start, a Trip Pass says which one it
// is ("2-week Trip Pass").
export function groupPlanTitle(kind: PlanKind, startsAt?: number | null, endsAt?: number) {
  if (kind !== "trip_pass") return "Group plan";
  const period = endsAt === undefined ? null : planPeriodOf(kind, startsAt ?? null, endsAt);
  return period ? `${period.days / 7}-week Trip Pass` : "Trip Pass";
}
