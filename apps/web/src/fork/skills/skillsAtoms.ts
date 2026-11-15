import { FORK_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

const perEnvironment = {
  mode: "singleFlight" as const,
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
};

export const forkSkills = {
  state: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "fork:skills:state",
    tag: FORK_WS_METHODS.skillsGetState,
    // The host syncs on its own schedule, so a kept result would show an old commit.
    idleTtlMs: 0,
  }),
  read: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "fork:skills:read",
    tag: FORK_WS_METHODS.skillsRead,
    idleTtlMs: 0,
  }),
  configure: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:configure",
    tag: FORK_WS_METHODS.skillsConfigure,
    concurrency: perEnvironment,
  }),
  sync: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:sync",
    tag: FORK_WS_METHODS.skillsSync,
    concurrency: perEnvironment,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:skills:delete",
    tag: FORK_WS_METHODS.skillsDelete,
  }),
};
