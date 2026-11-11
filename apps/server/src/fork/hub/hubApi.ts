import {
  ForkHubError,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type ForkHubAccount,
  type ForkHubAccountStatus,
  type ForkHubDay,
  type ForkHubFinishLoginInput,
  type ForkHubStartLoginInput,
  type ForkHubStatus,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { resolveSettingsSecrets } from "../../secrets/settingsSecretValue.ts";
import * as Settings from "../../serverSettings.ts";

const HISTORY_DAYS = 14;
const LOGIN_POLLS = 40;

const DashboardAccount = Schema.Struct({
  id: Schema.String,
  provider: Schema.optional(Schema.String),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  status_message: Schema.optional(Schema.NullOr(Schema.String)),
  disabled: Schema.optional(Schema.Boolean),
  unavailable: Schema.optional(Schema.Boolean),
  cooldowns: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  route_rank: Schema.optional(Schema.Number),
});
const HistoryPoint = Schema.Struct({
  auth_id: Schema.String,
  t: Schema.Number,
  req: Schema.Number,
  fail: Schema.Number,
  in: Schema.Number,
  cr: Schema.Number,
  cw: Schema.Number,
  out: Schema.Number,
});
const Dashboard = Schema.Struct({
  routing: Schema.Struct({
    strategy: Schema.optional(Schema.String),
    session_affinity: Schema.optional(Schema.Boolean),
    session_affinity_ttl: Schema.optional(Schema.String),
  }),
  accounts: Schema.Array(DashboardAccount),
  history: Schema.NullOr(Schema.Array(HistoryPoint)),
});
const LoginStart = Schema.Struct({ url: Schema.String, state: Schema.String });
const LoginStatus = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.String),
});

const decodeDashboard = Schema.decodeUnknownEffect(Dashboard);
const decodeLoginStart = Schema.decodeUnknownEffect(LoginStart);
const decodeLoginStatus = Schema.decodeUnknownEffect(LoginStatus);

interface Hub {
  readonly origin: URL;
  readonly managementKey: string;
}

const hubError = (detail: string) => new ForkHubError({ detail });

const resolveHub = Effect.fn("ForkHub.resolveHub")(function* (sourceId: UsageLimitSourceId) {
  const settings = yield* (yield* Settings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => hubError("Could not read the hub settings.")),
  );
  const config = settings.usageLimitSources[sourceId];
  if (!config?.enabled) return yield* hubError("This hub is missing or turned off.");
  const resolved = yield* resolveSettingsSecrets(
    yield* SecretResolver.SecretResolver,
    UsageLimitSourceConfig,
    config,
  ).pipe(Effect.mapError(() => hubError("Could not read the hub's management key.")));
  const managementKey = settingsSecretLiteral(resolved.managementKey);
  if (managementKey.length === 0) return yield* hubError("The hub has no management key set.");
  const origin = yield* Effect.try({
    try: () => new URL(config.url),
    catch: () => hubError("The hub URL is not valid."),
  });
  // Users often paste the panel URL, which ends in management.html.
  origin.pathname = origin.pathname.replace(/(\/management\.html)?\/?$/i, "/");
  return { origin, managementKey } satisfies Hub;
});

/** Calls the hub's management API. Hub responses can hold credentials, so errors carry only the status. */
const call = Effect.fn("ForkHub.call")(function* (
  hub: Hub,
  path: string,
  body?: unknown,
): Effect.fn.Return<
  { readonly status: number; readonly json: unknown },
  ForkHubError,
  HttpClient.HttpClient
> {
  const url = new URL(path, hub.origin).toString();
  const request = (
    body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${hub.managementKey}`));
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
    .pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() => hubError("Couldn't reach the hub.")),
    );
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  return { status: response.status, json };
});

const requireOk = (result: { readonly status: number; readonly json: unknown }, what: string) =>
  result.status >= 200 && result.status < 300
    ? Effect.succeed(result.json)
    : Effect.fail(hubError(`The hub refused to ${what} (HTTP ${result.status}).`));

function accountStatus(account: typeof DashboardAccount.Type): {
  readonly status: ForkHubAccountStatus;
  readonly message?: string;
} {
  const message = account.status_message?.trim() || undefined;
  if (account.disabled || account.status === "disabled") return { status: "disabled" };
  if (account.status === "error" || /invalid.grant|expired|unauthori[sz]ed/i.test(message ?? "")) {
    return { status: "loggedOut", ...(message ? { message } : {}) };
  }
  if (account.unavailable || (account.cooldowns?.length ?? 0) > 0) {
    return { status: "cooling", ...(message ? { message } : {}) };
  }
  return { status: "active" };
}

/** Rolls hourly points into one entry per UTC day for the last `HISTORY_DAYS` days. */
function dailyHistory(
  points: ReadonlyArray<typeof HistoryPoint.Type>,
  accountId: string,
  nowMs: number,
): ReadonlyArray<ForkHubDay> {
  const today = Math.floor(nowMs / 86_400_000);
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => ({
    date: DateTime.formatIso(
      DateTime.makeUnsafe((today - HISTORY_DAYS + 1 + i) * 86_400_000),
    ).slice(0, 10),
    requests: 0,
    failed: 0,
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  }));
  for (const point of points) {
    if (point.auth_id !== accountId) continue;
    const day = days[Math.floor((point.t * 1000) / 86_400_000) - (today - HISTORY_DAYS + 1)];
    if (!day) continue;
    day.requests += point.req;
    day.failed += point.fail;
    day.uncached += point.in;
    day.cacheRead += point.cr;
    day.cacheWrite += point.cw;
    day.output += point.out;
  }
  return days;
}

/** Maps the fork hub's dashboard response to what the app shows. */
export const statusFromDashboard = Effect.fn("ForkHub.statusFromDashboard")(function* (
  sourceId: UsageLimitSourceId,
  raw: unknown,
  nowMs: number,
) {
  const dashboard = yield* decodeDashboard(raw).pipe(
    Effect.mapError(() => hubError("The hub sent a status this app can't read.")),
  );
  const accounts = dashboard.accounts.flatMap((account): ReadonlyArray<ForkHubAccount> => {
    if (account.provider !== "claude" && account.provider !== "codex") return [];
    return [
      {
        id: account.id,
        provider: account.provider,
        ...(account.email ? { email: account.email } : {}),
        ...accountStatus(account),
        routeRank: account.route_rank ?? 0,
        days: dailyHistory(dashboard.history ?? [], account.id, nowMs),
      },
    ];
  });
  return {
    sourceId,
    supported: true,
    strategy: dashboard.routing.strategy || "round-robin",
    sessionAffinity: dashboard.routing.session_affinity ?? false,
    ...(dashboard.routing.session_affinity_ttl
      ? { sessionAffinityTtl: dashboard.routing.session_affinity_ttl }
      : {}),
    accounts,
  } satisfies ForkHubStatus;
});

/** Checks the address pasted after approving a login before it goes to the hub. */
export const checkRedirect = Effect.fn("ForkHub.checkRedirect")(function* (
  redirectUrl: string,
  state: string,
) {
  const redirect = yield* Effect.try({
    try: () => new URL(redirectUrl.trim()),
    catch: () => hubError("That isn't a web address. Copy the whole address from the address bar."),
  });
  if (!redirect.searchParams.get("code")) {
    return yield* hubError("That address has no login code. Copy it after approving the login.");
  }
  if (redirect.searchParams.get("state") !== state) {
    return yield* hubError("That address belongs to a different login attempt. Start again.");
  }
  return redirect;
});

export const getStatus = Effect.fn("ForkHub.getStatus")(function* (sourceId: UsageLimitSourceId) {
  const hub = yield* resolveHub(sourceId);
  const result = yield* call(hub, `v0/management/fork/dashboard?days=${HISTORY_DAYS}`);
  if (result.status === 404) {
    return {
      sourceId,
      supported: false,
      strategy: "",
      sessionAffinity: false,
      accounts: [],
    } satisfies ForkHubStatus;
  }
  const raw = yield* requireOk(result, "share its status");
  return yield* statusFromDashboard(sourceId, raw, DateTime.toEpochMillis(yield* DateTime.now));
});

export const startLogin = Effect.fn("ForkHub.startLogin")(function* (
  input: ForkHubStartLoginInput,
) {
  const hub = yield* resolveHub(input.sourceId);
  const result = yield* call(hub, "v8/management/oauth/auth-url", {
    provider: input.provider,
    ...(input.accountId ? { auth_id: input.accountId } : {}),
  });
  return yield* requireOk(result, "start a login").pipe(
    Effect.flatMap(decodeLoginStart),
    Effect.mapError((error) =>
      error._tag === "ForkHubError" ? error : hubError("The hub didn't return a login link."),
    ),
  );
});

export const finishLogin = Effect.fn("ForkHub.finishLogin")(function* (
  input: ForkHubFinishLoginInput,
) {
  const redirect = yield* checkRedirect(input.redirectUrl, input.state);
  const hub = yield* resolveHub(input.sourceId);
  yield* call(hub, "v0/management/oauth-callback", {
    provider: input.provider,
    redirect_url: redirect.toString(),
  }).pipe(Effect.flatMap((result) => requireOk(result, "accept the login")));
  for (let attempt = 0; attempt < LOGIN_POLLS; attempt += 1) {
    const status = yield* call(
      hub,
      `v0/management/get-auth-status?state=${encodeURIComponent(input.state)}`,
    ).pipe(
      Effect.flatMap((result) => requireOk(result, "report the login")),
      Effect.flatMap(decodeLoginStatus),
      Effect.mapError((error) =>
        error._tag === "ForkHubError"
          ? error
          : hubError("The hub sent a login status this app can't read."),
      ),
    );
    if (status.status === "ok") return {};
    if (status.status === "error") {
      return yield* hubError(status.error ? `Login failed: ${status.error}` : "Login failed.");
    }
    yield* Effect.sleep("1500 millis");
  }
  return yield* hubError("The hub didn't confirm the login within a minute. Try again.");
});
