import { describe, expect, it } from "@effect/vitest";
import type { UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { checkRedirect, statusFromDashboard } from "./hubApi.ts";

const sourceId = "dev1" as UsageLimitSourceId;
const now = Date.UTC(2026, 10, 11, 18, 0);
const hour = (daysAgo: number, h: number) => (Date.UTC(2026, 10, 11 - daysAgo, h) / 1000) | 0;

const dashboard = {
  routing: { strategy: "soonest-reset", session_affinity: true, session_affinity_ttl: "1h" },
  accounts: [
    {
      id: "claude-a.json",
      provider: "claude",
      email: "a@example.com",
      status: "active",
      route_rank: 1,
    },
    {
      id: "claude-b.json",
      provider: "claude",
      email: "b@example.com",
      status: "error",
      status_message: "invalid grant (retrying)",
      route_rank: 0,
    },
    { id: "codex-c.json", provider: "codex", status: "active", unavailable: true, route_rank: 0 },
    { id: "codex-d.json", provider: "codex", disabled: true },
    { id: "gemini-e.json", provider: "gemini", status: "active" },
  ],
  history: [
    { auth_id: "claude-a.json", t: hour(0, 9), req: 2, fail: 0, in: 10, cr: 900, cw: 90, out: 5 },
    { auth_id: "claude-a.json", t: hour(0, 15), req: 3, fail: 1, in: 20, cr: 100, cw: 10, out: 5 },
    { auth_id: "claude-a.json", t: hour(13, 1), req: 1, fail: 0, in: 1, cr: 1, cw: 1, out: 1 },
    { auth_id: "claude-a.json", t: hour(14, 1), req: 99, fail: 0, in: 1, cr: 1, cw: 1, out: 1 },
  ],
};

describe("fork hub status", () => {
  it.effect("maps hub accounts to app statuses and keeps only Claude and Codex", () =>
    Effect.gen(function* () {
      const status = yield* statusFromDashboard(sourceId, dashboard, now);
      expect(status).toMatchObject({
        supported: true,
        strategy: "soonest-reset",
        sessionAffinity: true,
        sessionAffinityTtl: "1h",
      });
      expect(status.accounts.map((a) => [a.id, a.status, a.routeRank])).toEqual([
        ["claude-a.json", "active", 1],
        ["claude-b.json", "loggedOut", 0],
        ["codex-c.json", "cooling", 0],
        ["codex-d.json", "disabled", 0],
      ]);
      expect(status.accounts[1]?.message).toBe("invalid grant (retrying)");
    }),
  );

  it.effect("rolls hourly history into the last 14 UTC days", () =>
    Effect.gen(function* () {
      const days = (yield* statusFromDashboard(sourceId, dashboard, now)).accounts[0]!.days;
      expect(days).toHaveLength(14);
      expect(days[0]).toMatchObject({ date: "2026-10-29", requests: 1 });
      expect(days[13]).toEqual({
        date: "2026-11-11",
        requests: 5,
        failed: 1,
        uncached: 30,
        cacheRead: 1000,
        cacheWrite: 100,
        output: 10,
      });
      expect(days.reduce((sum, day) => sum + day.requests, 0)).toBe(6);
    }),
  );

  it.effect("rejects a hub response it can't read", () =>
    Effect.gen(function* () {
      const error = yield* statusFromDashboard(sourceId, { accounts: "nope" }, now).pipe(
        Effect.flip,
      );
      expect(error.detail).toBe("The hub sent a status this app can't read.");
    }),
  );
});

describe("fork hub login redirect", () => {
  const cases = [
    ["http://localhost:54545/callback?code=abc&state=s1", "s1", null],
    ["not a url", "s1", "That isn't a web address. Copy the whole address from the address bar."],
    [
      "http://localhost:54545/callback?state=s1",
      "s1",
      "That address has no login code. Copy it after approving the login.",
    ],
    [
      "http://localhost:54545/callback?code=abc&state=other",
      "s1",
      "That address belongs to a different login attempt. Start again.",
    ],
  ] as const;
  it.effect.each(cases)("checks %s", ([url, state, expected]) =>
    Effect.gen(function* () {
      const result = yield* checkRedirect(url, state).pipe(Effect.result);
      if (expected === null) {
        expect(result._tag).toBe("Success");
      } else {
        expect(result._tag === "Failure" && result.failure.detail).toBe(expected);
      }
    }),
  );
});
