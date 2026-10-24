import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  FORK_WS_METHODS,
  WsRpcGroup,
  type ForkSecretsState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const state: ForkSecretsState = {
  status: "locked",
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
  sandbox: { enabled: false, path: null, version: null, managed: false, installVersion: "0.80.0" },
};

describe("fork RPC authorization", () => {
  it("requires settings permission for every secrets method", () => {
    for (const method of Object.values(FORK_WS_METHODS)) {
      expect(RpcAuthorization.RPC_REQUIRED_SCOPES[method]).toBe(AuthSettingsWriteScope);
    }
  });

  it.effect("refuses an unlock without settings permission before it reaches the service", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
            typeof FORK_WS_METHODS.secretsUnlock
          > => tag !== FORK_WS_METHODS.secretsUnlock,
        ),
      );
      const unlocks: Array<string> = [];
      const handler = group.toLayerHandler(FORK_WS_METHODS.secretsUnlock, ({ password }) =>
        Effect.sync(() => {
          unlocks.push(password);
          return state;
        }),
      );
      const operator = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(handler, RpcAuthorization.layer([AuthOrchestrationOperateScope])),
        ),
      );
      expect(
        yield* operator[FORK_WS_METHODS.secretsUnlock]({ password: "master" }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(unlocks).toEqual([]);

      const admin = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handler, RpcAuthorization.layer([AuthSettingsWriteScope]))),
      );
      yield* admin[FORK_WS_METHODS.secretsUnlock]({ password: "master" });
      expect(unlocks).toEqual(["master"]);
    }).pipe(Effect.scoped),
  );
});
