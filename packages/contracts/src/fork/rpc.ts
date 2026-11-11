import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  ForkHubError,
  ForkHubFinishLoginInput,
  ForkHubLogin,
  ForkHubStartLoginInput,
  ForkHubStatus,
  ForkHubStatusInput,
} from "./hub.ts";
import {
  ForkSecretsConfigureInput,
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
  secretsUnlock: "forkSecrets.unlock",
  secretsLock: "forkSecrets.lock",
  secretsLogout: "forkSecrets.logout",
  secretsSync: "forkSecrets.sync",
  secretsSetCollections: "forkSecrets.setCollections",
  secretsUpdateItem: "forkSecrets.updateItem",
  secretsInstallCli: "forkSecrets.installCli",
  secretsInstallSandbox: "forkSecrets.installSandbox",
  hubGetStatus: "forkHub.getStatus",
  hubStartLogin: "forkHub.startLogin",
  hubFinishLogin: "forkHub.finishLogin",
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
const HubRpcError = Schema.Union([ForkHubError, EnvironmentAuthorizationError]);

export const ForkWsRpcGroup = RpcGroup.make(
  secretsRpc(FORK_WS_METHODS.secretsGetState, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsConfigure, ForkSecretsConfigureInput),
  secretsRpc(FORK_WS_METHODS.secretsUnlock, ForkSecretsUnlockInput),
  secretsRpc(FORK_WS_METHODS.secretsLock, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsLogout, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsSync, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsSetCollections, ForkSecretsSetCollectionsInput),
  secretsRpc(FORK_WS_METHODS.secretsUpdateItem, ForkSecretsUpdateItemInput),
  secretsRpc(FORK_WS_METHODS.secretsInstallCli, EmptyInput),
  secretsRpc(FORK_WS_METHODS.secretsInstallSandbox, EmptyInput),
  Rpc.make(FORK_WS_METHODS.hubGetStatus, {
    payload: ForkHubStatusInput,
    success: ForkHubStatus,
    error: HubRpcError,
  }),
  Rpc.make(FORK_WS_METHODS.hubStartLogin, {
    payload: ForkHubStartLoginInput,
    success: ForkHubLogin,
    error: HubRpcError,
  }),
  Rpc.make(FORK_WS_METHODS.hubFinishLogin, {
    payload: ForkHubFinishLoginInput,
    success: Schema.Struct({}),
    error: HubRpcError,
  }),
);

/** Mutations, so clients can gate controls on the same scope the server enforces. */
export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [FORK_WS_METHODS.secretsConfigure]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsUnlock]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsLock]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsLogout]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsSync]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsSetCollections]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsUpdateItem]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsInstallCli]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.secretsInstallSandbox]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.hubStartLogin]: AuthProvidersManageScope,
  [FORK_WS_METHODS.hubFinishLogin]: AuthProvidersManageScope,
} as const;

/** Reads, kept out of the client-guarded map because query atoms refuse guarded tags. */
export const FORK_RPC_REQUIRED_SCOPES = {
  [FORK_WS_METHODS.secretsGetState]: AuthSettingsWriteScope,
  [FORK_WS_METHODS.hubGetStatus]: AuthProvidersManageScope,
} as const;
