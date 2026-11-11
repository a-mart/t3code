import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  type EnvironmentId,
  type ForkHubAccount,
  type ForkHubDay,
  type ForkHubProvider,
  type ForkHubStatus,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { providerClients } from "../../components/settings/providerDriverMeta";
import { RedactedSensitiveText } from "../../components/settings/RedactedSensitiveText";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { barColor } from "../../components/usage/UsageLimits";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { forkHub } from "./hubAtoms";
import { hubAccountSummary, routingDescription } from "./hubSection.logic";

/** Hub routing and account health under the pooled limits, for hubs running the fork build. */
export function ForkHubSections({ presentations }: { readonly presentations: LimitPresentations }) {
  const seen = new Set<string>();
  const hubs = [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => {
      // Two environments can list the same hub; show it once.
      if (seen.has(source.label)) return [];
      seen.add(source.label);
      return [{ environmentId, source }];
    }),
  );
  return hubs.map(({ environmentId, source }) => (
    <HubSection
      key={`${environmentId}:${source.id}`}
      environmentId={environmentId}
      source={source}
    />
  ));
}

function HubSection({
  environmentId,
  source,
}: {
  readonly environmentId: EnvironmentId;
  readonly source: UsageLimitSourceSnapshot;
}) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    canManage ? forkHub.status({ environmentId, input: { sourceId: source.id } }) : null,
  );
  const [login, setLogin] = useState<LoginTarget | null>(null);
  const status = query.data;
  if (!canManage || (status === null && query.error === null) || status?.supported === false) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{source.label}</h2>
          {status ? (
            <p className="text-xs text-muted-foreground">{routingDescription(status)}</p>
          ) : null}
        </div>
        <Button variant="ghost" size="xs" onClick={() => setLogin({ provider: null })}>
          <PlusIcon aria-hidden />
          Add account
        </Button>
      </div>
      {status ? (
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          {status.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              status={status}
              onLogin={() =>
                setLogin({
                  provider: account.provider as ForkHubProvider,
                  accountId: account.id,
                })
              }
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Couldn't load this hub's accounts. {query.error}
        </p>
      )}
      <HubLoginDialog
        environmentId={environmentId}
        sourceId={source.id}
        target={login}
        onClose={(loggedIn) => {
          setLogin(null);
          if (loggedIn) query.refresh();
        }}
      />
    </section>
  );
}

const driverFor = (provider: string) =>
  ProviderDriverKind.make(provider === "codex" ? "codex" : "claudeAgent");

function AccountRow({
  account,
  status,
  onLogin,
}: {
  readonly account: ForkHubAccount;
  readonly status: ForkHubStatus;
  readonly onLogin: () => void;
}) {
  const driver = driverFor(account.provider);
  const label = providerClients.get(driver)?.label ?? account.provider;
  const summary = hubAccountSummary(account, status.strategy);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5 shrink-0"
          iconClassName="size-4 text-foreground/80"
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground">{label}</span>
          {account.email ? (
            <RedactedSensitiveText
              value={account.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="w-fit text-xs"
            />
          ) : null}
        </div>
      </div>
      <div className="col-span-full flex min-w-0 items-center gap-3 md:order-none md:col-span-1">
        <Activity days={account.days} color={barColor(driver)} />
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
          {summary.activity}
        </span>
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-3">
        {account.status === "loggedOut" ? (
          <>
            <Badge variant="error">Logged out</Badge>
            <Button size="xs" onClick={onLogin}>
              Log in
            </Button>
          </>
        ) : account.status === "cooling" ? (
          <Badge variant="warning">Cooling down</Badge>
        ) : account.status === "disabled" ? (
          <span className="text-xs text-muted-foreground">Turned off</span>
        ) : summary.badge ? (
          <Badge variant="success">{summary.badge}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{summary.standing}</span>
        )}
      </div>
    </div>
  );
}

function Activity({
  days,
  color,
}: {
  readonly days: readonly ForkHubDay[];
  readonly color: string;
}) {
  const totals = days.map((day) => day.uncached + day.cacheRead + day.cacheWrite + day.output);
  const max = Math.max(...totals);
  if (max === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="flex h-5 w-28 shrink-0 items-end gap-px"
            aria-label="Tokens per day, last 14 days"
            role="img"
          />
        }
      >
        {totals.map((total, index) => (
          <span
            key={days[index]!.date}
            className="min-h-px flex-1 rounded-xs"
            style={{
              height: `${Math.max(4, (total / max) * 100)}%`,
              backgroundColor: color,
              opacity: total === 0 ? 0.15 : 0.7,
            }}
          />
        ))}
      </TooltipTrigger>
      <TooltipPopup>Tokens per day through the hub, last 14 days</TooltipPopup>
    </Tooltip>
  );
}

type LoginTarget = {
  readonly provider: ForkHubProvider | null;
  readonly accountId?: string;
};

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message
    ? failure.message
    : "Something went wrong. Try again.";
}

function HubLoginDialog({
  environmentId,
  sourceId,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceSnapshot["id"];
  readonly target: LoginTarget | null;
  readonly onClose: (loggedIn: boolean) => void;
}) {
  const startLogin = useAtomCommand(forkHub.startLogin, { reportFailure: false });
  const finishLogin = useAtomCommand(forkHub.finishLogin, { reportFailure: false });
  const [provider, setProvider] = useState<ForkHubProvider | null>(null);
  const [login, setLogin] = useState<{ readonly url: string; readonly state: string } | null>(null);
  const [redirect, setRedirect] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = target?.provider ?? provider;
  const providerLabel = chosen ? (providerClients.get(driverFor(chosen))?.label ?? chosen) : "an";

  const close = (loggedIn: boolean) => {
    setProvider(null);
    setLogin(null);
    setRedirect("");
    setError(null);
    onClose(loggedIn);
  };

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const result = await startLogin({
      environmentId,
      input: {
        sourceId,
        provider: chosen,
        ...(target?.accountId ? { accountId: target.accountId } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setLogin(result.value);
      void ensureLocalApi().shell.openExternal(result.value.url);
    } else {
      setError(failureMessage(result));
    }
  };

  const finish = async () => {
    if (!chosen || !login) return;
    setBusy(true);
    setError(null);
    const result = await finishLogin({
      environmentId,
      input: { sourceId, provider: chosen, state: login.state, redirectUrl: redirect },
    });
    setBusy(false);
    if (result._tag === "Success") close(true);
    else setError(failureMessage(result));
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close(false))}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.accountId
              ? "Log in again"
              : `Add ${chosen ? `a ${providerLabel}` : "an"} account`}
          </DialogTitle>
          <DialogDescription>
            {login
              ? "Approve the login in your browser. It then opens a localhost address that won't load. Copy that whole address and paste it here."
              : target?.accountId && chosen === "claude"
                ? "Sign in to claude.ai as this account first. Otherwise the hub attaches whichever account is signed in."
                : "The login opens in your browser. Sign in with the account you want the hub to use."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            {!target?.provider && !login ? (
              <div className="flex gap-2">
                {(["claude", "codex"] as const).map((option) => (
                  <Button
                    key={option}
                    variant={provider === option ? "default" : "outline"}
                    onClick={() => setProvider(option)}
                  >
                    {providerClients.get(driverFor(option))?.label ?? option}
                  </Button>
                ))}
              </div>
            ) : null}
            {login ? (
              <>
                <Button
                  variant="outline"
                  className="w-fit"
                  onClick={() => void ensureLocalApi().shell.openExternal(login.url)}
                >
                  Open the login page again
                  <ExternalLinkIcon aria-hidden />
                </Button>
                <Textarea
                  aria-label="Address after login"
                  placeholder={`http://localhost:${chosen === "codex" ? 1455 : 54545}/…`}
                  value={redirect}
                  onChange={(event) => setRedirect(event.target.value)}
                  autoFocus
                />
              </>
            ) : null}
            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {login ? (
            <Button onClick={() => void finish()} disabled={busy || redirect.trim() === ""}>
              {busy ? "Logging in…" : "Finish login"}
            </Button>
          ) : (
            <Button onClick={() => void start()} disabled={busy || !chosen}>
              {busy ? "Starting…" : "Start login"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
