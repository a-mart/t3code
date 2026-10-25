import * as Layer from "effect/Layer";

import * as BitwardenCli from "./secrets/BitwardenCli.ts";
import * as DockerRunner from "./secrets/DockerRunner.ts";
import * as Nono from "./secrets/Nono.ts";
import * as SecretsService from "./secrets/SecretsService.ts";
import * as SecureExec from "./secrets/SecureExec.ts";

/**
 * Fork services. `server.ts` provides this once with the runtime services, not
 * on the routes: each WebSocket connection builds its handlers from the request
 * context, which only sees runtime services. One instance means an unlock in
 * Settings and an agent's `secure_bash` share one session.
 */
export const layer = SecretsService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(BitwardenCli.layer, DockerRunner.layer, Nono.layer, SecureExec.layer),
  ),
);
