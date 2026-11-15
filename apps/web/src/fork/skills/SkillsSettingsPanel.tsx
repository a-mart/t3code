import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ForkSkillConflict,
  type ForkSkillsConfigureInput,
  type ForkSkillsLibrarySkill,
  type ForkSkillsState,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  GitBranchIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  BlocksIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Spinner } from "../../components/ui/spinner";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { readEnvironment, useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { forkSkills } from "./skillsAtoms";
import { groupOtherSkills, parseTags, type OtherSkillGroup } from "./skillsSettings.logic";

type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string | null };

interface ViewTarget {
  readonly title: string;
  readonly path: string;
  readonly links: ReadonlyArray<string>;
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message
    ? failure.message
    : "Something went wrong. Try again.";
}

async function confirmDestructive(message: string) {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message)
  );
}

export function SkillsSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environment } = useSettingsScope();
  const canRead = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canConfigure = useAtomValue(forkSkills.configure.permissionAtom(environmentId));
  const canSync = useAtomValue(forkSkills.sync.permissionAtom(environmentId));
  const canDelete = useAtomValue(forkSkills.delete.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canRead ? forkSkills.state({ environmentId, input: {} }) : null,
  );
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  // Mutations return the new state; show it until a newer query result arrives.
  const [snapshot, setSnapshot] = useState<{
    readonly state: ForkSkillsState;
    readonly at: number;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ readonly target: ViewTarget; readonly open: boolean }>();
  const commands = {
    configure: useAtomCommand(forkSkills.configure, {
      label: "skills settings",
      reportFailure: false,
    }),
    sync: useAtomCommand(forkSkills.sync, { label: "sync skills", reportFailure: false }),
    delete: useAtomCommand(forkSkills.delete, { label: "delete skill", reportFailure: false }),
  };

  const state =
    snapshot !== null && (query.data === null || snapshot.at >= query.dataUpdatedAt)
      ? snapshot.state
      : query.data;
  const environmentLabel = environment?.label ?? "this environment";
  const env = { environmentId };

  const run = async (
    label: string,
    execute: () => Promise<AtomCommandResult<ForkSkillsState, unknown>>,
  ): Promise<Outcome> => {
    setBusy(label);
    const result = await execute();
    setBusy(null);
    if (result._tag === "Success") {
      setSnapshot({ state: result.value, at: Date.now() });
      return { ok: true };
    }
    if (!isAtomCommandInterrupted(result)) query.refresh();
    return { ok: false, message: failureMessage(result) };
  };

  const syncAll = async (): Promise<Outcome> => {
    setBusy("sync-all");
    const results = await Promise.all(
      connectedEnvironmentIds.map(async (id) => ({
        id,
        result: await commands.sync({ environmentId: id, input: {} }),
      })),
    );
    setBusy(null);
    const failures: Array<string> = [];
    let synced = 0;
    for (const { id, result } of results) {
      if (result._tag === "Success") {
        if (id === environmentId) setSnapshot({ state: result.value, at: Date.now() });
        if (result.value.repository !== null) synced += 1;
        continue;
      }
      const message = failureMessage(result);
      if (message) failures.push(`${readEnvironment(id)?.label ?? id}: ${message}`);
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Synced ${synced} of ${results.length} hosts. ${failures.join(" ")}`,
    };
  };

  if (!canRead) {
    return (
      <SettingsPageContainer>
        <Notice title="Settings permission needed">
          This connection can't manage skills on {environmentLabel}. Pair with settings access to
          set up global skills.
        </Notice>
      </SettingsPageContainer>
    );
  }
  if (state === null) {
    return (
      <SettingsPageContainer>
        {query.error ? (
          <Notice
            title="Skills aren't available here"
            action={
              <Button size="xs" variant="outline" onClick={query.refresh}>
                <RefreshCwIcon /> Check again
              </Button>
            }
          >
            {environmentLabel} didn't answer the skills request. It may run a T3 build without
            global skills. ({query.error})
          </Notice>
        ) : (
          <div className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
            <Spinner /> Checking skills on {environmentLabel}…
          </div>
        )}
      </SettingsPageContainer>
    );
  }

  const view = (target: ViewTarget) => setViewer({ target, open: true });
  return (
    <SettingsPageContainer>
      <RepositorySection
        state={state}
        busy={busy}
        canConfigure={canConfigure}
        canSync={canSync}
        hostCount={connectedEnvironmentIds.length}
        onSave={(input) => run("configure", () => commands.configure({ ...env, input }))}
        onSync={() => run("sync", () => commands.sync({ ...env, input: {} }))}
        onSyncAll={syncAll}
        onDisconnect={async () => {
          const confirmed = await confirmDestructive(
            `Disconnect the skills repository on ${environmentLabel}?\nT3 removes the skill links and instruction files it wrote on this host.`,
          );
          if (!confirmed) return { ok: false, message: null };
          return run("disconnect", () =>
            commands.configure({ ...env, input: { repository: null } }),
          );
        }}
      />
      <GlobalSkillsSection
        state={state}
        canDelete={canDelete}
        onView={view}
        onDelete={async (name) => {
          const confirmed = await confirmDestructive(
            `Delete ${name} from the skills repository?\nT3 commits and pushes the removal, so every host drops it on its next sync.`,
          );
          if (!confirmed) return { ok: false, message: null };
          return run(`delete:${name}`, () => commands.delete({ ...env, input: { name } }));
        }}
      />
      {state.repository !== null ? <InstructionsSection state={state} /> : null}
      <OtherSkillsSection groups={groupOtherSkills(providers, state.skills)} onView={view} />
      <SkillViewer
        environmentId={environmentId}
        target={viewer?.target ?? null}
        open={viewer?.open ?? false}
        onClose={() => setViewer((current) => current && { ...current, open: false })}
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

function FormError({ message }: { readonly message: string | null }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function Preformatted({ children }: { readonly children: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
      {children}
    </pre>
  );
}

interface RepositorySectionProps {
  readonly state: ForkSkillsState;
  readonly busy: string | null;
  readonly canConfigure: boolean;
  readonly canSync: boolean;
  readonly hostCount: number;
  readonly onSave: (input: ForkSkillsConfigureInput) => Promise<Outcome>;
  readonly onSync: () => Promise<Outcome>;
  readonly onSyncAll: () => Promise<Outcome>;
  readonly onDisconnect: () => Promise<Outcome>;
}

function RepositorySection(props: RepositorySectionProps) {
  const { state } = props;
  const nowMinute = useNowMinute();
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (action: () => Promise<Outcome>) => {
    const outcome = await action();
    setActionError(outcome.ok ? null : outcome.message);
  };
  const description = [
    state.commit
      ? `At ${state.commit}${state.commitSubject ? ` ${state.commitSubject}` : ""}`
      : null,
    state.lastSyncedAt
      ? `· synced ${formatRelativeTimeLabel(state.lastSyncedAt, Date.parse(`${nowMinute}:00.000Z`))}`
      : "· not synced yet",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <SettingsSection
      {...searchableSetting("fork-skills-repository")}
      title="Repository"
      icon={<GitBranchIcon className="size-3.5" />}
    >
      {state.repository !== null ? (
        <SettingsRow
          title={state.branch ? `${state.repository} (${state.branch})` : state.repository}
          description={description}
          status={
            state.syncError || state.dirty ? (
              <Badge variant="warning">Sync stopped</Badge>
            ) : (
              <Badge variant="success">Synced</Badge>
            )
          }
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={!props.canSync || props.busy !== null}
                onClick={() => void act(props.onSync)}
              >
                {props.busy === "sync" ? <Spinner /> : <RefreshCwIcon />} Sync now
              </Button>
              {props.hostCount > 1 ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!props.canSync || props.busy !== null}
                  onClick={() => void act(props.onSyncAll)}
                >
                  {props.busy === "sync-all" ? <Spinner /> : <RefreshCwIcon />} Sync all hosts
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={!props.canConfigure || props.busy !== null}
                onClick={() => void act(props.onDisconnect)}
              >
                {props.busy === "disconnect" ? <Spinner /> : <UnlinkIcon />} Disconnect
              </Button>
            </div>
          }
        >
          <div className="grid gap-3 pt-1 pb-3">
            {state.dirty ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>The clone on this host has local changes</AlertTitle>
                <AlertDescription>
                  Pulls stop until its uncommitted or unpushed changes are committed, pushed, or
                  discarded.
                </AlertDescription>
              </Alert>
            ) : null}
            {state.syncError ? (
              <Alert variant="error">
                <TriangleAlertIcon />
                <AlertTitle>The last sync failed</AlertTitle>
                <AlertDescription>{state.syncError}</AlertDescription>
              </Alert>
            ) : null}
            <FormError message={actionError} />
          </div>
        </SettingsRow>
      ) : null}
      <RepositoryForm
        // Reset the fields to what the host saved.
        key={[state.repository, state.branch, state.hostName, ...state.tags].join("\n")}
        {...props}
      />
    </SettingsSection>
  );
}

function RepositoryForm(props: RepositorySectionProps) {
  const { state } = props;
  const [repository, setRepository] = useState(state.repository ?? "");
  const [branch, setBranch] = useState(state.branch ?? "");
  const [hostName, setHostName] = useState(
    state.hostName === state.defaultHostName ? "" : state.hostName,
  );
  const [tags, setTags] = useState(state.tags.join(", "));
  const [error, setError] = useState<string | null>(null);
  const connected = state.repository !== null;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const outcome = await props.onSave({
      repository: repository.trim(),
      branch: branch.trim() || null,
      hostName: hostName.trim() || null,
      tags: parseTags(tags),
    });
    setError(outcome.ok ? null : outcome.message);
  };
  const disabled = !props.canConfigure || props.busy !== null;

  return (
    <SettingsRow
      title={connected ? "Settings" : "Connect a repository"}
      description={
        connected
          ? "Skills can target this host by its name or tags."
          : "T3 clones the repository, links each folder in its skills/ into your agents' skill folders, and writes its instructions/ as global agent instructions."
      }
    >
      <form className="grid gap-3 pt-1 pb-3" onSubmit={(event) => void save(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="fork-skills-repo" label="Repository">
            <Input
              id="fork-skills-repo"
              size="sm"
              placeholder="owner/name or git URL"
              value={repository}
              disabled={disabled}
              onChange={(event) => setRepository(event.target.value)}
            />
          </Field>
          <Field id="fork-skills-branch" label="Branch">
            <Input
              id="fork-skills-branch"
              size="sm"
              placeholder="Default branch"
              value={branch}
              disabled={disabled}
              onChange={(event) => setBranch(event.target.value)}
            />
          </Field>
          <Field id="fork-skills-host" label="Host name">
            <Input
              id="fork-skills-host"
              size="sm"
              placeholder={state.defaultHostName}
              value={hostName}
              disabled={disabled}
              onChange={(event) => setHostName(event.target.value)}
            />
          </Field>
          <Field id="fork-skills-tags" label="Tags">
            <Input
              id="fork-skills-tags"
              size="sm"
              placeholder="linux, gpu"
              value={tags}
              disabled={disabled}
              onChange={(event) => setTags(event.target.value)}
            />
          </Field>
        </div>
        <FormError message={error} />
        <div>
          <Button type="submit" size="sm" disabled={disabled || repository.trim() === ""}>
            {props.busy === "configure" ? <Spinner /> : null} {connected ? "Save" : "Connect"}
          </Button>
        </div>
      </form>
    </SettingsRow>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function conflictText(conflicts: ReadonlyArray<ForkSkillConflict>) {
  return conflicts
    .map(
      (conflict) =>
        `${conflict.path} (${conflict.reason === "exists" ? "a file T3 didn't create" : "edited on this host"})`,
    )
    .join(", ");
}

function SkillStatus({ skill }: { readonly skill: ForkSkillsLibrarySkill }) {
  const badge =
    skill.status === "linked" ? (
      <Badge variant="success">Linked</Badge>
    ) : skill.status === "skipped" ? (
      <Badge variant="secondary">Skipped</Badge>
    ) : skill.status === "conflict" ? (
      <Badge variant="warning">Conflict</Badge>
    ) : (
      <Badge variant="error">Invalid</Badge>
    );
  const notes = [
    skill.reason,
    skill.conflicts.length > 0 ? `Blocked by ${conflictText(skill.conflicts)}` : null,
    skill.hosts ? `Limited to ${skill.hosts.join(", ")}` : null,
    skill.providers ? `Providers: ${skill.providers.join(", ")}` : null,
    skill.requires.length > 0 ? `Requires ${skill.requires.join(", ")}` : null,
    skill.userInvocationOnly ? "User-only" : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {badge}
      {skill.source === "builtin" ? <Badge variant="outline">Built in</Badge> : null}
      {notes.length > 0 ? <span>{notes.join(" · ")}</span> : null}
    </div>
  );
}

function GlobalSkillsSection({
  state,
  canDelete,
  onView,
  onDelete,
}: {
  readonly state: ForkSkillsState;
  readonly canDelete: boolean;
  readonly onView: (target: ViewTarget) => void;
  readonly onDelete: (name: string) => Promise<Outcome>;
}) {
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const remove = async (name: string) => {
    const outcome = await onDelete(name);
    setErrors((current) => {
      const next = new Map(current);
      if (outcome.ok || outcome.message === null) next.delete(name);
      else next.set(name, outcome.message);
      return next;
    });
  };
  return (
    <SettingsSection
      {...searchableSetting("fork-skills-global")}
      title="Global skills"
      icon={<BlocksIcon className="size-3.5" />}
    >
      {state.skills.length === 0 ? (
        <SettingsRow
          title="No skills yet"
          description="Each folder with a SKILL.md under the repository's skills/ becomes a skill on every host it targets."
        />
      ) : (
        state.skills.map((skill) => (
          <SettingsRow
            key={skill.name}
            title={skill.name}
            description={skill.description}
            status={<SkillStatus skill={skill} />}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onView({ title: skill.name, path: skill.path, links: skill.links })
                  }
                >
                  View
                </Button>
                {skill.source === "library" ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Delete ${skill.name}`}
                    disabled={!canDelete}
                    onClick={() => void remove(skill.name)}
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
            }
          >
            {errors.has(skill.name) ? (
              <div className="pb-3">
                <FormError message={errors.get(skill.name) ?? null} />
              </div>
            ) : null}
          </SettingsRow>
        ))
      )}
    </SettingsSection>
  );
}

function InstructionsSection({ state }: { readonly state: ForkSkillsState }) {
  const { instructions } = state;
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection
      {...searchableSetting("fork-skills-instructions")}
      title="Instructions"
      icon={<ScrollTextIcon className="size-3.5" />}
    >
      {instructions.content === null ? (
        <SettingsRow
          title="No instructions for this host"
          description={`Add instructions/AGENTS.md, or instructions/hosts/${state.hostName}.md, to the repository.`}
        />
      ) : (
        <>
          <SettingsRow
            title="Combined instructions"
            description={`From ${instructions.sources.join(" + ")}`}
          >
            <div className="pb-3">
              <Collapsible open={open} onOpenChange={setOpen}>
                <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
                  <ChevronRightIcon className={open ? "rotate-90" : undefined} />
                  {open ? "Hide text" : "Show text"}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="pt-2">
                    <Preformatted>{instructions.content}</Preformatted>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </div>
          </SettingsRow>
          {instructions.files.map((file) => (
            <SettingsRow
              key={file.path}
              title={file.path}
              description={
                file.conflict
                  ? file.conflict.reason === "exists"
                    ? "A file T3 didn't create is here, so T3 leaves it alone. Move it aside to use the repository's instructions."
                    : "Edited on this host since T3 wrote it, so T3 stopped updating it. Copy your changes into the repository, then delete the file."
                  : undefined
              }
              status={
                file.status === "written" ? (
                  <Badge variant="success">Written</Badge>
                ) : (
                  <Badge variant="warning">Conflict</Badge>
                )
              }
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

function OtherSkillsSection({
  groups,
  onView,
}: {
  readonly groups: ReadonlyArray<OtherSkillGroup>;
  readonly onView: (target: ViewTarget) => void;
}) {
  const [showBundled, setShowBundled] = useState(false);
  const bundledCount = groups.filter((group) => group.bundled).length;
  const shown = showBundled ? groups : groups.filter((group) => !group.bundled);
  return (
    <SettingsSection
      {...searchableSetting("fork-skills-other")}
      headerAction={
        bundledCount > 0 ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setShowBundled(!showBundled)}>
            {showBundled ? "Hide" : "Show"} {bundledCount} plugin and system skills
          </Button>
        ) : null
      }
    >
      {shown.length === 0 ? (
        <SettingsRow
          title="None"
          description="Every skill your agents load here comes from the repository."
        />
      ) : (
        shown.map((group) => (
          <SettingsRow
            key={group.name}
            title={group.name}
            description={group.description ?? undefined}
            status={
              <div className="grid gap-1">
                {group.locations.map((location) => (
                  <div key={location.path} className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="link"
                      onClick={() => onView({ title: group.name, path: location.path, links: [] })}
                    >
                      {location.path}
                    </Button>
                    {location.providers.map((provider) => (
                      <Badge key={provider} variant="outline">
                        {provider}
                      </Badge>
                    ))}
                  </div>
                ))}
              </div>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function SkillViewer({
  environmentId,
  target,
  open,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ViewTarget | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    target && open ? forkSkills.read({ environmentId, input: { path: target.path } }) : null,
  );
  const [skillFile, ...otherFiles] = query.data?.files ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription>{query.data?.path ?? target?.path}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error ? (
            <FormError message={query.error} />
          ) : query.data === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          ) : (
            <div className="grid gap-4 text-sm">
              {skillFile ? (
                <Preformatted>{skillFile.content ?? "SKILL.md isn't text."}</Preformatted>
              ) : null}
              {otherFiles.length > 0 ? (
                <ViewerList title="Other files">
                  {otherFiles.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>{" "}
                      <span className="text-muted-foreground">{formatBytes(file.bytes)}</span>
                    </li>
                  ))}
                </ViewerList>
              ) : null}
              {target && target.links.length > 0 ? (
                <ViewerList title="Linked from">
                  {target.links.map((link) => (
                    <li key={link}>
                      <code>{link}</code>
                    </li>
                  ))}
                </ViewerList>
              ) : null}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ViewerList({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="grid gap-1 font-mono text-xs break-all">{children}</ul>
    </div>
  );
}
