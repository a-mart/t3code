import { EnvironmentId, ForkSecretsError, type ForkSecretsState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

// Switches take their size from the app's theme variables.
import "~/index.css";
import { render } from "../../../test/render";

type Command = (input: unknown) => Promise<AsyncResult.AsyncResult<unknown, unknown>>;

const state = vi.hoisted(() => ({
  server: null as unknown as ForkSecretsState,
  // What the state query last fetched; like the real query, it changes only on refresh.
  queried: null as unknown as ForkSecretsState,
  queriedAt: 0,
  // Handlers by command label; unlisted commands succeed with the server state.
  commands: new Map<string, Command>(),
}));

vi.mock(import("~/state/session"), async (original) => {
  const Option = await import("effect/Option");
  return {
    ...(await original()),
    useEnvironmentScope: (() => true) as never,
    usePreparedConnection: (() => Option.none()) as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("~/state/query"), async (original) => {
  const { useReducer } = await import("react");
  return {
    ...(await original()),
    useEnvironmentQuery: (() => {
      const [, rerender] = useReducer((count: number) => count + 1, 0);
      return {
        data: state.queried,
        error: null,
        dataUpdatedAt: state.queriedAt,
        refresh: () => {
          state.queried = state.server;
          // A refetch lands after any command result the panel already holds.
          state.queriedAt = Date.now() + 1;
          rerender();
        },
      };
    }) as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await original()),
    useAtomCommand: ((_command: unknown, options: { readonly label: string }) =>
      async (request: { readonly input: unknown }) => {
        const command = state.commands.get(options.label);
        return command ? command(request.input) : AsyncResult.success(state.server);
      }) as never,
  };
});
vi.mock(import("~/components/settings/SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ environment: { label: "dev1", entry: {} } })) as never,
}));

import { SecretsSettingsPanel } from "./SecretsSettingsPanel";

function setup() {
  state.commands.clear();
  state.server = {
    status: "unauthenticated",
    cli: {
      path: "/usr/local/bin/bw",
      version: "2026.10.0",
      configuredPath: null,
      managed: false,
      installVersion: "2026.10.0",
    },
    account: null,
    serverUrl: null,
    loginCommand: null,
    availableCollections: [],
    selectedCollections: [],
    items: [],
    lastSyncedAt: null,
    keepUnlocked: false,
    saveCollectionId: null,
    secureCommandsSupported: true,
    sandbox: {
      enabled: false,
      path: null,
      version: null,
      managed: false,
      installVersion: "0.80.0",
    },
  };
  state.queried = state.server;
  state.queriedAt = 0;
}

async function enterCredentials(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.type(screen.getByLabelText("API key client ID"), "user.client");
  await userEvent.type(screen.getByLabelText("API key client secret"), "client-secret");
  await userEvent.type(screen.getByLabelText("Master password"), "master password");
}

describe("SecretsSettingsPanel", () => {
  it("moves a sign-in that left Bitwarden locked to the unlock form, keeping its error", async () => {
    setup();
    state.commands.set("connect Bitwarden", async () => {
      // The API key worked, so the server is signed in now, but the master password didn't.
      state.server = { ...state.server, status: "locked" };
      return AsyncResult.failure(Cause.fail(new ForkSecretsError({ reason: "unlock_failed" })));
    });
    await using screen = await render(
      <SecretsSettingsPanel environmentId={EnvironmentId.make("environment")} />,
    );

    await enterCredentials(screen);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await expect.element(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    await expect
      .element(screen.getByText("Bitwarden didn't unlock. Check the master password."))
      .toBeInTheDocument();
    expect(screen.getByLabelText("API key client ID").query()).toBeNull();
  });

  it("sends the API key only to the server the form shows", async () => {
    setup();
    let signedInAt: string | null | undefined;
    // Saving the server choice never reaches the host, so its state still says Bitwarden.com.
    state.commands.set("secrets settings", async () =>
      AsyncResult.failure(Cause.fail(new ForkSecretsError({ reason: "timeout" }))),
    );
    state.commands.set("connect Bitwarden", async (input) => {
      signedInAt = (input as { readonly serverUrl?: string | null }).serverUrl;
      state.server = { ...state.server, status: "ready" };
      return AsyncResult.success(state.server);
    });
    await using screen = await render(
      <SecretsSettingsPanel environmentId={EnvironmentId.make("environment")} />,
    );

    await userEvent.click(screen.getByLabelText("Server"));
    await userEvent.click(screen.getByRole("option", { name: "Bitwarden.eu" }));
    await enterCredentials(screen);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await expect.element(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(signedInAt).toBe("https://vault.bitwarden.eu");
  });

  it("installs nono before turning on the sandbox on a host without one", async () => {
    setup();
    const calls: Array<string> = [];
    state.commands.set("install nono", async () => {
      calls.push("install");
      state.server = {
        ...state.server,
        sandbox: {
          ...state.server.sandbox,
          path: "/state/fork/bin/nono",
          version: "0.80.0",
          managed: true,
        },
      };
      return AsyncResult.success(state.server);
    });
    state.commands.set("secrets settings", async (input) => {
      calls.push(`configure ${JSON.stringify(input)}`);
      state.server = { ...state.server, sandbox: { ...state.server.sandbox, enabled: true } };
      return AsyncResult.success(state.server);
    });
    await using screen = await render(
      <SecretsSettingsPanel environmentId={EnvironmentId.make("environment")} />,
    );

    const toggle = screen.getByRole("switch", { name: "Run secret commands in a sandbox" });
    await userEvent.click(toggle);

    await expect.element(toggle).toBeChecked();
    expect(calls).toEqual(["install", 'configure {"sandbox":true}']);
    await expect
      .element(screen.getByText("nono 0.80.0 at /state/fork/bin/nono (installed by T3)"))
      .toBeInTheDocument();
  });
});
