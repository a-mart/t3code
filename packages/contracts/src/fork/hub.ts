import * as Schema from "effect/Schema";

import { UsageLimitSourceId } from "../usageLimitSourceId.ts";

/**
 * Account routing and health for a CLIProxyAPI hub running Adam's fork build,
 * which adds `GET /v0/management/fork/dashboard`. Limits themselves already
 * arrive through usage limit sources; this adds what those don't carry.
 */

export const ForkHubAccountStatus = Schema.Literals(["active", "cooling", "loggedOut", "disabled"]);
export type ForkHubAccountStatus = typeof ForkHubAccountStatus.Type;

export const ForkHubProvider = Schema.Literals(["claude", "codex"]);
export type ForkHubProvider = typeof ForkHubProvider.Type;

/** One UTC day of an account's traffic through the hub. */
export const ForkHubDay = Schema.Struct({
  date: Schema.String,
  requests: Schema.Number,
  failed: Schema.Number,
  uncached: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type ForkHubDay = typeof ForkHubDay.Type;

export const ForkHubAccount = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  status: ForkHubAccountStatus,
  message: Schema.optional(Schema.String),
  /** 1 is the account new sessions go to now; 0 means it can't take traffic. */
  routeRank: Schema.Number,
  days: Schema.Array(ForkHubDay),
});
export type ForkHubAccount = typeof ForkHubAccount.Type;

export const ForkHubStatus = Schema.Struct({
  sourceId: UsageLimitSourceId,
  /** False when the hub doesn't run the fork build; nothing else is filled in then. */
  supported: Schema.Boolean,
  strategy: Schema.String,
  sessionAffinity: Schema.Boolean,
  sessionAffinityTtl: Schema.optional(Schema.String),
  accounts: Schema.Array(ForkHubAccount),
});
export type ForkHubStatus = typeof ForkHubStatus.Type;

export const ForkHubStatusInput = Schema.Struct({ sourceId: UsageLimitSourceId });
export type ForkHubStatusInput = typeof ForkHubStatusInput.Type;

export const ForkHubStartLoginInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  provider: ForkHubProvider,
  /** The account to log in again; omitted to add a new one. */
  accountId: Schema.optional(Schema.String),
});
export type ForkHubStartLoginInput = typeof ForkHubStartLoginInput.Type;

export const ForkHubLogin = Schema.Struct({ url: Schema.String, state: Schema.String });
export type ForkHubLogin = typeof ForkHubLogin.Type;

export const ForkHubFinishLoginInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  provider: ForkHubProvider,
  state: Schema.String,
  /** The address the browser landed on after approving, with `code` and `state`. */
  redirectUrl: Schema.String,
});
export type ForkHubFinishLoginInput = typeof ForkHubFinishLoginInput.Type;

export class ForkHubError extends Schema.TaggedError<ForkHubError>()("ForkHubError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
