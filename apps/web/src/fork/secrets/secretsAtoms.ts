import { FORK_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

// One request per environment at a time: a second click can't start a second unlock.
const perEnvironment = {
  mode: "singleFlight" as const,
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
};

export const forkSecrets = {
  state: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "fork:secrets:state",
    tag: FORK_WS_METHODS.secretsGetState,
    // Fetched fresh each time the page opens: a kept result would show the vault as it was then,
    // locked after it was unlocked here, or unlocked after another client locked it.
    idleTtlMs: 0,
  }),
  configure: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:configure",
    tag: FORK_WS_METHODS.secretsConfigure,
    concurrency: perEnvironment,
  }),
  unlock: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:unlock",
    tag: FORK_WS_METHODS.secretsUnlock,
    concurrency: perEnvironment,
  }),
  lock: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:lock",
    tag: FORK_WS_METHODS.secretsLock,
    concurrency: perEnvironment,
  }),
  logout: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:logout",
    tag: FORK_WS_METHODS.secretsLogout,
    concurrency: perEnvironment,
  }),
  sync: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:sync",
    tag: FORK_WS_METHODS.secretsSync,
    concurrency: perEnvironment,
  }),
  setCollections: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:set-collections",
    tag: FORK_WS_METHODS.secretsSetCollections,
    concurrency: perEnvironment,
  }),
  updateItem: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:update-item",
    tag: FORK_WS_METHODS.secretsUpdateItem,
  }),
  installCli: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:install-cli",
    tag: FORK_WS_METHODS.secretsInstallCli,
    concurrency: perEnvironment,
  }),
  installSandbox: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:secrets:install-sandbox",
    tag: FORK_WS_METHODS.secretsInstallSandbox,
    concurrency: perEnvironment,
  }),
};
