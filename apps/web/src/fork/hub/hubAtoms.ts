import { FORK_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const forkHub = {
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "fork:hub:status",
    tag: FORK_WS_METHODS.hubGetStatus,
    // Routing and login health change minute to minute; a kept result would show the old order.
    idleTtlMs: 0,
  }),
  startLogin: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:hub:start-login",
    tag: FORK_WS_METHODS.hubStartLogin,
  }),
  finishLogin: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fork:hub:finish-login",
    tag: FORK_WS_METHODS.hubFinishLogin,
  }),
};
