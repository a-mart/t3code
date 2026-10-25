import {
  FORK_WS_METHODS,
  type ForkSecretsConfigureInput,
  type ForkSecretsError,
  type ForkSecretsSetCollectionsInput,
  type ForkSecretsUnlockInput,
  type ForkSecretsUpdateItemInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SecretsService from "./secrets/SecretsService.ts";

/** Fork WebSocket handlers, spread into the handler object in `ws.ts`. */
export const handlers = Effect.gen(function* () {
  // Optional, so upstream harnesses that build the WebSocket layer need no fork
  // services. `server.ts` always provides it.
  const service = yield* Effect.serviceOption(SecretsService.SecretsService);
  const secrets = <A>(
    run: (secrets: SecretsService.SecretsService["Service"]) => Effect.Effect<A, ForkSecretsError>,
  ) =>
    Option.match(service, {
      onNone: () => Effect.die(new Error("The secrets service isn't running on this server.")),
      onSome: run,
    });
  return {
    [FORK_WS_METHODS.secretsGetState]: () => secrets((s) => s.getState),
    [FORK_WS_METHODS.secretsConfigure]: (input: ForkSecretsConfigureInput) =>
      secrets((s) => s.configure(input)),
    [FORK_WS_METHODS.secretsUnlock]: (input: ForkSecretsUnlockInput) =>
      secrets((s) => s.unlock(input)),
    [FORK_WS_METHODS.secretsLock]: () => secrets((s) => s.lock),
    [FORK_WS_METHODS.secretsLogout]: () => secrets((s) => s.logout),
    [FORK_WS_METHODS.secretsSync]: () => secrets((s) => s.sync),
    [FORK_WS_METHODS.secretsSetCollections]: (input: ForkSecretsSetCollectionsInput) =>
      secrets((s) => s.setCollections(input)),
    [FORK_WS_METHODS.secretsUpdateItem]: (input: ForkSecretsUpdateItemInput) =>
      secrets((s) => s.updateItem(input)),
    [FORK_WS_METHODS.secretsInstallCli]: () => secrets((s) => s.installCli),
    [FORK_WS_METHODS.secretsInstallSandbox]: () => secrets((s) => s.installSandbox),
  };
});
