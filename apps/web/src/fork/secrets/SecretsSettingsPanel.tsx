import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ForkSecretItem,
  type ForkSecretsCollection,
  type ForkSecretsConfigureInput,
  type ForkSecretsState,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  LogOutIcon,
  RefreshCwIcon,
  StickyNoteIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { forkSecrets } from "./secretsAtoms";
import {
  BITWARDEN_SERVERS,
  aliasProblem,
  bitwardenServerChoice,
  grantSummary,
  matchesSecretQuery,
  serverHost,
  toggleProjectGrant,
  unlockTransportProblem,
  type BitwardenServerChoice,
  type UnlockTransportProblem,
} from "./secretsSettings.logic";

const ITEM_FILTER_THRESHOLD = 8;

type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string | null };

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message
    ? failure.message
    : "Something went wrong. Try again.";
}

export function SecretsSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environment } = useSettingsScope();
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    canManage ? forkSecrets.state({ environmentId, input: {} }) : null,
  );
  // Mutations return the new state; show it until a newer query result arrives.
  const [snapshot, setSnapshot] = useState<{
    readonly state: ForkSecretsState;
    readonly at: number;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const commands = {
    configure: useAtomCommand(forkSecrets.configure, {
      label: "secrets settings",
      reportFailure: false,
    }),
    unlock: useAtomCommand(forkSecrets.unlock, { label: "unlock Bitwarden", reportFailure: false }),
    lock: useAtomCommand(forkSecrets.lock, { label: "lock Bitwarden", reportFailure: false }),
    logout: useAtomCommand(forkSecrets.logout, {
      label: "log out of Bitwarden",
      reportFailure: false,
    }),
    sync: useAtomCommand(forkSecrets.sync, { label: "sync Bitwarden", reportFailure: false }),
    setCollections: useAtomCommand(forkSecrets.setCollections, {
      label: "choose Bitwarden collections",
      reportFailure: false,
    }),
    updateItem: useAtomCommand(forkSecrets.updateItem, {
      label: "update secret",
      reportFailure: false,
    }),
    installCli: useAtomCommand(forkSecrets.installCli, {
      label: "install the Bitwarden CLI",
      reportFailure: false,
    }),
    installSandbox: useAtomCommand(forkSecrets.installSandbox, {
      label: "install nono",
      reportFailure: false,
    }),
  };

  const state =
    snapshot !== null && (query.data === null || snapshot.at >= query.dataUpdatedAt)
      ? snapshot.state
      : query.data;
  const environmentLabel = environment?.label ?? "this environment";
  const transportProblem =
    environment === null ? null : unlockTransportProblem(environment.entry, prepared);

  const run = async (
    label: string,
    execute: () => Promise<AtomCommandResult<ForkSecretsState, unknown>>,
  ): Promise<Outcome> => {
    setBusy(label);
    const result = await execute();
    setBusy(null);
    if (result._tag === "Success") {
      setSnapshot({ state: result.value, at: Date.now() });
      return { ok: true };
    }
    // A failed command can still change state, as when an unlock finds the account signed out.
    if (!isAtomCommandInterrupted(result)) query.refresh();
    return { ok: false, message: failureMessage(result) };
  };

  if (!canManage) {
    return (
      <SettingsPageContainer>
        <Notice title="Settings permission needed">
          This connection can't manage secrets on {environmentLabel}. Pair with settings access to
          connect Bitwarden.
        </Notice>
      </SettingsPageContainer>
    );
  }
  if (state === null) {
    return (
      <SettingsPageContainer>
        {query.error ? (
          <Notice
            title="Secrets aren't available here"
            action={<RetryButton onClick={query.refresh} />}
          >
            {environmentLabel} didn't answer the secrets request. It may run a T3 build without
            Bitwarden secrets. ({query.error})
          </Notice>
        ) : (
          <div className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
            <Spinner /> Checking Bitwarden on {environmentLabel}…
          </div>
        )}
      </SettingsPageContainer>
    );
  }
  if (!state.secureCommandsSupported) {
    return (
      <SettingsPageContainer>
        <Notice title="Not available on Windows hosts">
          Agents run secret-backed commands with bash, so secrets work on macOS and Linux hosts.
        </Notice>
      </SettingsPageContainer>
    );
  }

  const env = { environmentId };
  const connected = state.status === "ready" || state.status === "locked";
  return (
    <SettingsPageContainer>
      <BitwardenSection
        state={state}
        environmentLabel={environmentLabel}
        transportProblem={transportProblem}
        busy={busy}
        onRefresh={query.refresh}
        onConfigure={(input) => run("configure", () => commands.configure({ ...env, input }))}
        onUnlock={(password) =>
          run("unlock", () => commands.unlock({ ...env, input: { password } }))
        }
        onLock={() => run("lock", () => commands.lock({ ...env, input: {} }))}
        onLogout={async () => {
          const message = `Log out of Bitwarden on ${environmentLabel}?\nAgents lose access to secrets until you sign in again. Collections and grants are kept.`;
          const confirmed =
            (await requestConfirmDialog(message, { variant: "destructive" })) ??
            window.confirm(message);
          if (!confirmed) return { ok: false, message: null };
          return run("logout", () => commands.logout({ ...env, input: {} }));
        }}
        onSync={() => run("sync", () => commands.sync({ ...env, input: {} }))}
        onInstall={() => run("install", () => commands.installCli({ ...env, input: {} }))}
      />
      {connected ? (
        <CollectionsSection
          state={state}
          busy={busy}
          onSave={(collectionIds) =>
            run("collections", () => commands.setCollections({ ...env, input: { collectionIds } }))
          }
        />
      ) : null}
      {state.items.length > 0 || state.selectedCollections.length > 0 ? (
        <SecretsSection
          state={state}
          projects={projects.map((project) => ({ id: project.id, title: project.title }))}
          onUpdate={(input) =>
            run(`item:${input.itemId}`, () => commands.updateItem({ ...env, input }))
          }
        />
      ) : null}
      <AgentsSection
        state={state}
        busy={busy}
        onConfigure={(input) => run("configure", () => commands.configure({ ...env, input }))}
        onInstallSandbox={() =>
          run("install-sandbox", () => commands.installSandbox({ ...env, input: {} }))
        }
      />
    </SettingsPageContainer>
  );
}

function Notice({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{children}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </AlertDescription>
    </Alert>
  );
}

function RetryButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onClick}>
      <RefreshCwIcon /> Check again
    </Button>
  );
}

function FormError({ message }: { readonly message: string | null }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function CopyableCommand({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/40 py-1.5 ps-3 pe-1.5">
      <code className="min-w-0 flex-1 py-0.5 font-mono text-xs leading-5 break-all text-foreground">
        {command}
      </code>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={isCopied ? "Copied" : "Copy command"}
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function statusBadge(state: ForkSecretsState) {
  switch (state.status) {
    case "ready":
      return (
        <Badge variant="success">
          <LockOpenIcon aria-hidden /> Unlocked
        </Badge>
      );
    case "locked":
      return (
        <Badge variant="warning">
          <LockIcon aria-hidden /> Locked
        </Badge>
      );
    case "unauthenticated":
      return <Badge variant="secondary">Not signed in</Badge>;
    case "cli_missing":
    case "cli_unusable":
      return <Badge variant="warning">CLI needed</Badge>;
  }
}

interface BitwardenSectionProps {
  readonly state: ForkSecretsState;
  readonly environmentLabel: string;
  readonly transportProblem: UnlockTransportProblem | null;
  readonly busy: string | null;
  readonly onRefresh: () => void;
  readonly onConfigure: (input: ForkSecretsConfigureInput) => Promise<Outcome>;
  readonly onUnlock: (password: string) => Promise<Outcome>;
  readonly onLock: () => Promise<Outcome>;
  readonly onLogout: () => Promise<Outcome>;
  readonly onSync: () => Promise<Outcome>;
  readonly onInstall: () => Promise<Outcome>;
}

function BitwardenSection(props: BitwardenSectionProps) {
  const { state } = props;
  const nowMinute = useNowMinute();
  const connected = state.status === "ready" || state.status === "locked";
  const account = state.account;
  const description =
    state.status === "ready" || state.status === "locked"
      ? [
          account?.email ? `Signed in as ${account.email}` : "Signed in",
          `on ${serverHost(account?.serverUrl ?? state.serverUrl)}`,
          state.lastSyncedAt
            ? `· synced ${formatRelativeTimeLabel(state.lastSyncedAt, Date.parse(`${nowMinute}:00.000Z`))}`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : state.status === "unauthenticated"
        ? `Sign in with a Bitwarden account so agents on ${props.environmentLabel} can use its secrets.`
        : `T3 uses the official Bitwarden CLI (bw) on ${props.environmentLabel}.`;

  return (
    <SettingsSection
      {...searchableSetting("fork-secrets-bitwarden")}
      title="Password manager"
      icon={<KeyRoundIcon className="size-3.5" />}
    >
      <SettingsRow
        title="Bitwarden"
        description={description}
        status={statusBadge(state)}
        control={
          state.status === "ready" ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={props.busy !== null}
                onClick={() => void props.onSync()}
              >
                {props.busy === "sync" ? <Spinner /> : <RefreshCwIcon />} Sync now
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={props.busy !== null}
                onClick={() => void props.onLock()}
              >
                <LockIcon /> Lock
              </Button>
              <AccountMenu busy={props.busy} onLogout={props.onLogout} />
            </div>
          ) : state.status === "locked" ? (
            <AccountMenu busy={props.busy} onLogout={props.onLogout} />
          ) : null
        }
      >
        <div className="grid gap-3 pt-1 pb-3">
          {props.transportProblem &&
          (state.status === "locked" || state.status === "unauthenticated") ? (
            <TransportNotice
              problem={props.transportProblem}
              environmentLabel={props.environmentLabel}
            />
          ) : null}
          {state.status === "cli_missing" || state.status === "cli_unusable" ? (
            <CliSetup {...props} />
          ) : null}
          {state.status === "unauthenticated" ? <SignInForm {...props} /> : null}
          {state.status === "locked" ? <UnlockForm {...props} /> : null}
        </div>
      </SettingsRow>
      {connected ? <KeepUnlockedRow {...props} /> : null}
      {state.status !== "cli_missing" ? <CliRow {...props} /> : null}
    </SettingsSection>
  );
}

function AccountMenu({
  busy,
  onLogout,
}: {
  readonly busy: string | null;
  readonly onLogout: () => Promise<Outcome>;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost-muted" disabled={busy !== null} />}
        aria-label="Bitwarden account actions"
      >
        {busy === "logout" ? <Spinner /> : <LogOutIcon />}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void onLogout()}>
          <LogOutIcon /> Log out of Bitwarden
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function TransportNotice({
  problem,
  environmentLabel,
}: {
  readonly problem: UnlockTransportProblem;
  readonly environmentLabel: string;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Use a private connection for your master password</AlertTitle>
      <AlertDescription>
        {problem === "relay"
          ? `You're reaching ${environmentLabel} through T3 Connect, where Cloudflare can read the traffic. Connect over Tailscale or from this machine to unlock.`
          : `This connection to ${environmentLabel} isn't encrypted. Connect over Tailscale, HTTPS, or from this machine to unlock.`}
      </AlertDescription>
    </Alert>
  );
}

function CliSetup(props: BitwardenSectionProps) {
  const { cli } = props.state;
  const [path, setPath] = useState(cli.configuredPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const unusable = props.state.status === "cli_unusable";
  const canInstall = cli.installVersion !== null && !cli.managed;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const outcome = await props.onConfigure({ cliPath: path.trim() === "" ? null : path.trim() });
    setError(outcome.ok ? null : outcome.message);
  };
  const install = async () => {
    const outcome = await props.onInstall();
    setError(outcome.ok ? null : outcome.message);
  };
  return (
    <div className="grid gap-3">
      {unusable ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>This Bitwarden CLI can't keep a separate login</AlertTitle>
          <AlertDescription>
            {cli.path} keeps its data in a bw-data folder beside it, which would mix T3's login with
            yours. {canInstall ? "Install T3's own copy, " : "Install bw another way, "}or choose a
            different executable.
          </AlertDescription>
        </Alert>
      ) : null}
      {canInstall ? (
        <div className="grid justify-items-start gap-2">
          <Button size="sm" disabled={props.busy !== null} onClick={() => void install()}>
            {props.busy === "install" ? <Spinner /> : <DownloadIcon />} Install Bitwarden CLI
          </Button>
          <p className="max-w-md text-xs text-muted-foreground">
            Downloads the official bw {cli.installVersion} from Bitwarden's GitHub releases onto{" "}
            {props.environmentLabel}, checks it against a pinned SHA-256, and keeps it in T3's data
            folder.
          </p>
        </div>
      ) : null}
      {props.state.status !== "cli_missing" ? null : (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            {canInstall
              ? "Or install it yourself, then check again:"
              : `Install the Bitwarden CLI on ${props.environmentLabel}, then check again:`}
          </p>
          <CopyableCommand command="brew install bitwarden-cli" />
          <CopyableCommand command="npm install -g @bitwarden/cli" />
        </div>
      )}
      <form className="grid gap-1.5" onSubmit={(event) => void save(event)}>
        <Label htmlFor="secrets-cli-path">Or use a bw executable at</Label>
        <div className="flex gap-2">
          <Input
            id="secrets-cli-path"
            size="sm"
            autoComplete="off"
            spellCheck={false}
            placeholder="/usr/local/bin/bw"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={props.busy !== null}>
            Use path
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={props.onRefresh}>
            <RefreshCwIcon /> Check again
          </Button>
        </div>
        <FormError message={error} />
      </form>
    </div>
  );
}

function selectedServerUrl(choice: BitwardenServerChoice, selfHostedUrl: string) {
  return choice === "self-hosted"
    ? selfHostedUrl.trim()
    : (BITWARDEN_SERVERS.find((entry) => entry.id === choice)?.url ?? null);
}

function SignInForm(props: BitwardenSectionProps) {
  const [server, setServer] = useState<BitwardenServerChoice>(() =>
    bitwardenServerChoice(props.state.serverUrl),
  );
  const [selfHostedUrl, setSelfHostedUrl] = useState(
    server === "self-hosted" ? (props.state.serverUrl ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);

  const applyServer = async (choice: BitwardenServerChoice, url: string) => {
    const serverUrl = selectedServerUrl(choice, url);
    if (serverUrl === "") return;
    const outcome = await props.onConfigure({ serverUrl });
    setError(outcome.ok ? null : outcome.message);
  };

  return (
    <div className="grid gap-3">
      <fieldset disabled={props.busy !== null} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="secrets-server">Server</Label>
          <Select
            value={server}
            onValueChange={(value) => {
              const choice = BITWARDEN_SERVERS.find((entry) => entry.id === value)?.id;
              if (choice === undefined) return;
              setServer(choice);
              if (choice !== "self-hosted") void applyServer(choice, "");
            }}
          >
            <SelectTrigger id="secrets-server" size="sm">
              <SelectValue>
                {BITWARDEN_SERVERS.find((entry) => entry.id === server)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {BITWARDEN_SERVERS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {server === "self-hosted" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="secrets-server-url">Server URL</Label>
            <Input
              id="secrets-server-url"
              size="sm"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://vault.example.com"
              value={selfHostedUrl}
              onChange={(event) => setSelfHostedUrl(event.target.value)}
              onBlur={() => void applyServer("self-hosted", selfHostedUrl)}
            />
          </div>
        ) : null}
      </fieldset>
      <FormError message={error} />
      {props.state.loginCommand ? (
        <div className="grid gap-2">
          <p className="max-w-md text-xs text-muted-foreground">
            Run this once in a terminal on {props.environmentLabel} and sign in as the account
            agents should use. It keeps T3's login separate from your own bw. Then check again and
            unlock here.
          </p>
          <CopyableCommand command={props.state.loginCommand} />
          <div>
            <RetryButton onClick={props.onRefresh} />
          </div>
        </div>
      ) : null}
      <p className="max-w-md text-xs text-muted-foreground">
        Use a dedicated account that can see only what agents should reach.
      </p>
    </div>
  );
}

function UnlockForm(props: BitwardenSectionProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const blocked = props.transportProblem !== null;
  const pending = props.busy === "unlock";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || pending || !password) return;
    const outcome = await props.onUnlock(password);
    setPassword("");
    setError(outcome.ok ? null : outcome.message);
  };
  return (
    <form className="grid gap-1.5" onSubmit={(event) => void submit(event)}>
      <Label htmlFor="secrets-unlock-password">Master password</Label>
      <div className="flex gap-2">
        <SecretInput
          id="secrets-unlock-password"
          size="sm"
          value={password}
          placeholder="Unlock to let agents use secrets"
          disabled={blocked || pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={blocked || pending || !password}>
          {pending ? <Spinner /> : <LockOpenIcon />} Unlock
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}

function KeepUnlockedRow(props: BitwardenSectionProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      {...searchableSetting("fork-secrets-keep-unlocked")}
      description="Restores the unlock after this server restarts, so scheduled tasks keep working. The session key then sits in T3's data folder, where any process running as this user can read it; use a dedicated account."
      status={error ? <span className="text-destructive">{error}</span> : null}
      control={
        <Switch
          checked={props.state.keepUnlocked}
          disabled={props.busy !== null}
          aria-label="Stay unlocked across restarts"
          onCheckedChange={(keepUnlocked) =>
            void props
              .onConfigure({ keepUnlocked })
              .then((outcome) => setError(outcome.ok ? null : outcome.message))
          }
        />
      }
    />
  );
}

function CliRow(props: BitwardenSectionProps) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cli } = props.state;
  if (cli.path === null || props.state.status === "cli_unusable") return null;
  const outdated = cli.managed && cli.installVersion !== null && cli.version !== cli.installVersion;
  const origin = cli.managed
    ? " (installed by T3)"
    : cli.configuredPath
      ? ""
      : " (found automatically)";
  return (
    <SettingsRow
      title="Bitwarden CLI"
      description={`bw ${cli.version ?? ""} at ${cli.path}${origin}`}
      status={error ? <span className="text-destructive">{error}</span> : null}
      control={
        <div className="flex items-center gap-1.5">
          {outdated ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.busy !== null}
              onClick={() =>
                void props
                  .onInstall()
                  .then((outcome) => setError(outcome.ok ? null : outcome.message))
              }
            >
              {props.busy === "install" ? <Spinner /> : <DownloadIcon />} Update to{" "}
              {cli.installVersion}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={() => setEditing((open) => !open)}>
            {editing ? "Done" : "Change"}
          </Button>
        </div>
      }
    >
      {editing ? (
        <div className="pb-3">
          <CliSetup {...props} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function collectionLabel(collection: ForkSecretsCollection) {
  return collection.organizationName
    ? `${collection.organizationName} / ${collection.name}`
    : collection.name;
}

function CollectionsSection({
  state,
  busy,
  onSave,
}: {
  readonly state: ForkSecretsState;
  readonly busy: string | null;
  readonly onSave: (collectionIds: ReadonlyArray<string>) => Promise<Outcome>;
}) {
  const savedIds = state.selectedCollections.map((collection) => collection.id);
  const [draft, setDraft] = useState<ReadonlyArray<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = new Set(draft ?? savedIds);
  const changed =
    draft !== null &&
    (draft.length !== savedIds.length || draft.some((id) => !savedIds.includes(id)));
  const pending = busy === "collections";

  if (state.status !== "ready") {
    return (
      <SettingsSection {...searchableSetting("fork-secrets-collections")}>
        <SettingsRow
          title="Synced collections"
          description={
            state.selectedCollections.length === 0
              ? "Unlock Bitwarden to choose collections."
              : `${state.selectedCollections.map(collectionLabel).join(", ")}. Unlock Bitwarden to change them.`
          }
        />
      </SettingsSection>
    );
  }

  const save = async () => {
    const outcome = await onSave([...selected]);
    if (outcome.ok) setDraft(null);
    setError(outcome.ok ? null : outcome.message);
  };

  return (
    <SettingsSection {...searchableSetting("fork-secrets-collections")}>
      <SettingsRow
        title="Synced collections"
        description="Items in these organization collections become secrets you can grant. Logins share their password, notes their text, and SSH keys their private key."
        control={
          <Button size="xs" disabled={!changed || pending} onClick={() => void save()}>
            {pending ? <Spinner /> : null} Save and sync
          </Button>
        }
      >
        <div className="grid gap-1 pb-3">
          {state.availableCollections.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This account can't see any organization collections. Add it to a collection in
              Bitwarden, then sync.
            </p>
          ) : (
            state.availableCollections.map((collection) => {
              const id = `secrets-collection-${collection.id}`;
              return (
                <div key={collection.id} className="flex items-center gap-2 py-0.5">
                  <Checkbox
                    id={id}
                    checked={selected.has(collection.id)}
                    disabled={pending}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked) next.add(collection.id);
                      else next.delete(collection.id);
                      setDraft([...next]);
                    }}
                  />
                  <Label htmlFor={id}>{collectionLabel(collection)}</Label>
                </div>
              );
            })
          )}
          <FormError message={error} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

interface ProjectOption {
  readonly id: ProjectId;
  readonly title: string;
}

function SecretsSection({
  state,
  projects,
  onUpdate,
}: {
  readonly state: ForkSecretsState;
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly onUpdate: (input: {
    readonly itemId: string;
    readonly alias?: string;
    readonly grant?: ForkSecretItem["grant"];
  }) => Promise<Outcome>;
}) {
  const [filter, setFilter] = useState("");
  const visible = state.items.filter((item) => matchesSecretQuery(item, filter));
  const grantedCount = state.items.filter(
    (item) => item.grant === "all" || item.grant.length > 0,
  ).length;
  return (
    <SettingsSection
      {...searchableSetting("fork-secrets-access")}
      title="Secrets"
      headerAction={
        state.items.length > ITEM_FILTER_THRESHOLD ? (
          <div className="w-48">
            <Input
              size="sm"
              aria-label="Filter secrets"
              placeholder="Filter secrets"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        ) : null
      }
    >
      {state.items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No secrets in these collections</EmptyTitle>
            <EmptyDescription>
              Add logins, secure notes, or SSH keys to the synced collections in Bitwarden, then
              sync.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="px-3 pt-3 text-xs text-muted-foreground sm:px-4">
            {grantedCount === 0
              ? "Nothing is granted yet. Grant a secret to the projects whose agents should use it."
              : `${grantedCount} of ${state.items.length} granted. Agents use a secret by its alias, which is also its environment variable.`}
          </p>
          {visible.map((item) => (
            <SecretRow
              key={item.itemId}
              item={item}
              items={state.items}
              projects={projects}
              onUpdate={onUpdate}
            />
          ))}
          {visible.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">No secrets match “{filter}”.</p>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

const KIND_LABELS = { login: "Login", note: "Secure note", ssh_key: "SSH key" } as const;

function KindIcon({ kind }: { readonly kind: ForkSecretItem["kind"] }) {
  const Icon = kind === "login" ? KeyRoundIcon : kind === "note" ? StickyNoteIcon : TerminalIcon;
  return (
    <Icon aria-label={KIND_LABELS[kind]} className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

function SecretRow({
  item,
  items,
  projects,
  onUpdate,
}: {
  readonly item: ForkSecretItem;
  readonly items: ReadonlyArray<ForkSecretItem>;
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly onUpdate: (input: {
    readonly itemId: string;
    readonly alias?: string;
    readonly grant?: ForkSecretItem["grant"];
  }) => Promise<Outcome>;
}) {
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const alias = aliasDraft ?? item.alias;
  const problem = aliasDraft === null ? null : aliasProblem(aliasDraft, items, item.itemId);

  const update = async (input: {
    readonly alias?: string;
    readonly grant?: ForkSecretItem["grant"];
  }) => {
    setPending(true);
    const outcome = await onUpdate({ itemId: item.itemId, ...input });
    setPending(false);
    setError(outcome.ok ? null : outcome.message);
    return outcome;
  };

  const commitAlias = async () => {
    if (aliasDraft === null) return;
    if (aliasDraft === item.alias) {
      setAliasDraft(null);
      return;
    }
    if (problem !== null) return;
    const outcome = await update({ alias: aliasDraft });
    if (outcome.ok) setAliasDraft(null);
  };

  const titleFor = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? null;
  const removed = item.grant === "all" ? [] : item.grant.filter((id) => titleFor(id) === null);

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <KindIcon kind={item.kind} />
          <span className="truncate">{item.name}</span>
        </span>
      }
      description={[KIND_LABELS[item.kind], item.username ? `user ${item.username}` : null]
        .filter(Boolean)
        .join(" · ")}
      status={
        problem || error ? <span className="text-destructive">{problem ?? error}</span> : null
      }
      control={
        <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-auto">
          <div className="w-44 min-w-0 flex-1 @min-[32rem]/settings-row:flex-none">
            <Input
              size="sm"
              aria-label={`Alias for ${item.name}`}
              aria-invalid={problem !== null}
              autoComplete="off"
              spellCheck={false}
              value={alias}
              disabled={pending}
              onChange={(event) => setAliasDraft(event.target.value.toUpperCase())}
              onBlur={() => void commitAlias()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitAlias();
                if (event.key === "Escape") setAliasDraft(null);
              }}
            />
          </div>
          <AccessMenu
            item={item}
            projects={projects}
            pending={pending}
            summary={grantSummary(item.grant, titleFor)}
            removedCount={removed.length}
            onChange={(grant) => void update({ grant })}
          />
        </div>
      }
    />
  );
}

function AccessMenu({
  item,
  projects,
  pending,
  summary,
  removedCount,
  onChange,
}: {
  readonly item: ForkSecretItem;
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly pending: boolean;
  readonly summary: string;
  readonly removedCount: number;
  readonly onChange: (grant: ForkSecretItem["grant"]) => void;
}) {
  const allProjectIds = projects.map((project) => project.id);
  const granted = item.grant === "all" || item.grant.length > 0;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant={granted ? "outline" : "ghost-muted"} disabled={pending} />
        }
        aria-label={`Projects that can use ${item.name}`}
      >
        {pending ? <Spinner /> : <UsersIcon />}
        {summary}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuCheckboxItem
            variant="switch"
            checked={item.grant === "all"}
            closeOnClick={false}
            onCheckedChange={(all) => onChange(all ? "all" : [])}
          >
            All projects
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          {projects.length === 0 ? (
            <MenuItem disabled>No projects on this environment</MenuItem>
          ) : (
            projects.map((project) => (
              <MenuCheckboxItem
                key={project.id}
                checked={item.grant === "all" || item.grant.includes(project.id)}
                closeOnClick={false}
                onCheckedChange={() =>
                  onChange(toggleProjectGrant(item.grant, project.id, allProjectIds))
                }
              >
                {project.title}
              </MenuCheckboxItem>
            ))
          )}
        </MenuGroup>
        {removedCount > 0 && item.grant !== "all" ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                onChange(
                  item.grant === "all"
                    ? "all"
                    : item.grant.filter((id) => allProjectIds.includes(id)),
                )
              }
            >
              Remove {removedCount} deleted {removedCount === 1 ? "project" : "projects"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

const SAVE_OFF = "off";

function AgentsSection({
  state,
  busy,
  onConfigure,
  onInstallSandbox,
}: {
  readonly state: ForkSecretsState;
  readonly busy: string | null;
  readonly onConfigure: BitwardenSectionProps["onConfigure"];
  readonly onInstallSandbox: () => Promise<Outcome>;
}) {
  const [error, setError] = useState<string | null>(null);
  const destination = state.selectedCollections.find(
    (collection) => collection.id === state.saveCollectionId,
  );
  return (
    <SettingsSection title="How agents use secrets">
      <SettingsRow
        title="secure_bash and list_secrets"
        description="Agents in a granted project see each secret's alias, never its value. They run commands that need one with secure_bash, which puts the value in an environment variable named after the alias and filters it out of the output. Secret-backed commands need the thread in full-access mode, not plan or approval mode."
      >
        <div className="grid gap-2 pb-3">
          <CopyableCommand
            command={'PGPASSWORD="$PROD_DB" psql -h db.internal -U app -c "select 1"'}
          />
          <p className="text-xs text-muted-foreground">
            Locking Bitwarden or removing a grant stops commands that are using it. Every call shows
            up in the thread, with values replaced by [redacted:ALIAS].
          </p>
        </div>
      </SettingsRow>
      <SandboxRow
        state={state}
        busy={busy}
        onConfigure={onConfigure}
        onInstallSandbox={onInstallSandbox}
      />
      <SettingsRow
        {...searchableSetting("fork-secrets-save")}
        description={
          state.selectedCollections.length === 0
            ? "Sync a collection to let agents save secrets with save_secret."
            : "save_secret stores a new credential, one you type for the agent or one a command creates, as a Bitwarden item in this collection and grants it to the agent's project. The agent never sees the value."
        }
        status={error ? <span className="text-destructive">{error}</span> : null}
        control={
          <Select
            value={destination?.id ?? SAVE_OFF}
            disabled={busy !== null || state.selectedCollections.length === 0}
            onValueChange={(value) =>
              void onConfigure({ saveCollectionId: value === SAVE_OFF ? null : value }).then(
                (outcome) => setError(outcome.ok ? null : outcome.message),
              )
            }
          >
            <SelectTrigger size="sm" aria-label="Where agents save new secrets">
              <SelectValue>{destination ? collectionLabel(destination) : "Don't save"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={SAVE_OFF}>Don't save</SelectItem>
              {state.selectedCollections.map((collection) => (
                <SelectItem key={collection.id} value={collection.id}>
                  {collectionLabel(collection)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

function SandboxRow({
  state,
  busy,
  onConfigure,
  onInstallSandbox,
}: {
  readonly state: ForkSecretsState;
  readonly busy: string | null;
  readonly onConfigure: BitwardenSectionProps["onConfigure"];
  readonly onInstallSandbox: () => Promise<Outcome>;
}) {
  const [error, setError] = useState<string | null>(null);
  const { sandbox } = state;
  const outdated =
    sandbox.managed &&
    sandbox.installVersion !== null &&
    sandbox.version !== sandbox.installVersion;
  const installing = busy === "install-sandbox";
  const toggle = async (enabled: boolean) => {
    // Turning it on installs T3's copy first when this host has no working nono.
    if (enabled && sandbox.path === null) {
      const installed = await onInstallSandbox();
      if (!installed.ok) {
        setError(installed.message);
        return;
      }
    }
    const outcome = await onConfigure({ sandbox: enabled });
    setError(outcome.ok ? null : outcome.message);
  };
  const install = () =>
    void onInstallSandbox().then((outcome) => setError(outcome.ok ? null : outcome.message));
  const location =
    sandbox.path === null
      ? sandbox.installVersion === null
        ? "nono has no build for this host, and none is installed."
        : `T3 installs nono ${sandbox.installVersion} when you turn this on.`
      : `nono ${sandbox.version ?? ""} at ${sandbox.path}${sandbox.managed ? " (installed by T3)" : ""}`;
  return (
    <SettingsRow
      {...searchableSetting("fork-secrets-sandbox")}
      description={
        <>
          Secret-backed commands run inside nono with a clean environment and an empty home folder.
          They can write only to the project and temporary folders, and can't use this host's own
          logins or SSH keys; ~/.ssh/known_hosts and ~/.ssh/config stay readable. While this is on,
          nothing runs without nono.
          <span className="mt-1 block">{installing ? "Installing nono…" : location}</span>
        </>
      }
      status={error ? <span className="text-destructive">{error}</span> : null}
      control={
        <div className="flex items-center gap-1.5">
          {installing ? <Spinner /> : null}
          {outdated && !installing ? (
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={install}>
              <DownloadIcon /> Update to {sandbox.installVersion}
            </Button>
          ) : null}
          <Switch
            checked={sandbox.enabled}
            disabled={busy !== null || (sandbox.path === null && sandbox.installVersion === null)}
            aria-label="Run secret commands in a sandbox"
            onCheckedChange={(enabled) => void toggle(enabled)}
          />
        </div>
      }
    />
  );
}
