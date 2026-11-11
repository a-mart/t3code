import type { ForkHubAccount, ForkHubStatus } from "@t3tools/contracts";

const STRATEGY_TEXT: Record<string, string> = {
  "soonest-reset": "Spends the account whose week resets first",
  "fill-first": "Uses one account until it runs out",
  "weighted-round-robin": "Rotates accounts by weight",
  "round-robin": "Rotates accounts on every request",
};

export function routingDescription(status: ForkHubStatus): string {
  const how = STRATEGY_TEXT[status.strategy] ?? `Routing: ${status.strategy}`;
  if (!status.sessionAffinity) return `${how}. Sessions can move between accounts.`;
  return `${how}. Each session stays on one account${
    status.sessionAffinityTtl ? ` for ${status.sessionAffinityTtl}` : ""
  }.`;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const requestCount = (n: number) => `${compact.format(n)} ${n === 1 ? "request" : "requests"}`;

export function hubAccountSummary(
  account: ForkHubAccount,
  strategy: string,
): { readonly badge: string | null; readonly standing: string; readonly activity: string } {
  const totals = account.days.reduce(
    (sum, day) => ({
      requests: sum.requests + day.requests,
      input: sum.input + day.uncached + day.cacheRead + day.cacheWrite,
      cacheRead: sum.cacheRead + day.cacheRead,
    }),
    { requests: 0, input: 0, cacheRead: 0 },
  );
  const activity =
    totals.requests === 0
      ? "No requests in 14 days"
      : totals.input === 0
        ? requestCount(totals.requests)
        : `${requestCount(totals.requests)}, ${Math.round((totals.cacheRead / totals.input) * 100)}% from cache`;
  const ordered = strategy === "soonest-reset" || strategy === "fill-first";
  if (!ordered) return { badge: null, standing: "In rotation", activity };
  if (account.routeRank === 1) return { badge: "Spending now", standing: "", activity };
  return { badge: null, standing: account.routeRank === 2 ? "Up next" : "Waiting", activity };
}
