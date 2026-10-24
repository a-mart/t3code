import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "../auth.ts";
import {
  ForkSecretsConfigureInput,
  ForkSecretsConnectInput,
  ForkSecretsError,
  ForkSecretsSetCollectionsInput,
  ForkSecretsState,
  ForkSecretsUnlockInput,
  ForkSecretsUpdateItemInput,
} from "./secrets.ts";

/** Fork-only WebSocket methods. Upstream clients never call them. */
export const FORK_WS_METHODS = {
  secretsGetState: "forkSecrets.getState",
  secretsConfigure: "forkSecrets.configure",
  secretsConnect: "forkSecrets.connect",
  secretsUnlock: "forkSecrets.unlock",
  secretsLock: "forkSecrets.lock",
  secretsLogout: "forkSecrets.logout",
  secretsSync: "forkSecrets.sync",
  secretsSetCollections: "forkSecrets.setCollections",
  secretsUpdateItem: "forkSecrets.updateItem",
  secretsInstallCli: "forkSecrets.installCli",
  secretsInstallSandbox: "forkSecrets.installSandbox",
} as const;

const secretsRpc = <const Tag extends string, Payload extends Schema.Top>(
  tag: Tag,
  payload: Payload,
) =>
  Rpc.make(tag, {
    payload,
    success: ForkSecretsState,
    error: Schema.Union([ForkSecretsError, EnvironmentAuthorizationError]),
  });

const EmptyInput = Schema.Struct({});

export const ForkWsRpcGroup = RpcGroup.make(
  secretsRpc(FORK_WS_METHODS.secretsGetState, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsConfigure, ForkSecretsConfigureInput),
  secretsRpc(FORK_WS_METHODS.secretsConnect, ForkSecretsConnectInput),
  secretsRpc(FORK_WS_METHODS.secretsUnlock, ForkSecretsUnlockInput),
  secretsRpc(FORK_WS_METHODS.secretsLock, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsLogout, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsSync, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsSetCollections, ForkSecretsSetCollectionsInput),
  secretsRpc(FORK_WS_METHODS.secretsUpdateItem, ForkSecretsUpdateItemInput),
  secretsRpc(FORK_WS_METHODS.secretsInstallCli, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsInstallSandbox, EmptyInput),
);

/** Mutations, so clients can gate controls on the same scope the server enforces. */
export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [FORK_WS_METHODS.secretsConfigure]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsConnect]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsUnlock]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsLock]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsLogout]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsSync]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsSetCollections]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsUpdateItem]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsInstallCli]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsInstallSandbox]: AuthSettingsWriteScope,
} as const;

/** Reads, kept out of the client-guarded map because query atoms refuse guarded tags. */
export const FORK_RPC_REQUIRED_SCOPES = {
  [FORK_WS_METHODS.secretsGetState]: AuthSettingsWriteScope,
} as const;
