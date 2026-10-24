import { FORK_WS_METHODS } from "@t3tools/contracts";

type ForkWsMethod = (typeof FORK_WS_METHODS)[keyof typeof FORK_WS_METHODS];

/** Trace aggregate labels for fork methods, spread into `RpcInstrumentation`'s exhaustive map. */
export const FORK_RPC_AGGREGATES = Object.fromEntries(
  Object.values(FORK_WS_METHODS).map((method) => [method, "forkSecrets"]),
) as Readonly<Record<ForkWsMethod, "forkSecrets">>;
