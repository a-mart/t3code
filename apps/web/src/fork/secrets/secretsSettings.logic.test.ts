import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, type ForkSecretItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  aliasProblem,
  bitwardenServerChoice,
  grantSummary,
  matchesSecretQuery,
  serverHost,
  toggleProjectGrant,
  unlockTransportProblem,
} from "./secretsSettings.logic";

const environmentId = EnvironmentId.make("environment-secrets");

function direct(id: string, httpBaseUrl: string, network?: "tailscale"): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({ environmentId, label: "dev1", connectionId: id }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId,
        label: "dev1",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        ...(network === undefined ? {} : { network }),
      }),
    ),
  };
}

const RELAY: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId, label: "dev1" }),
  profile: Option.none(),
};

function entryFor(routes: ReadonlyArray<ConnectionRoute>): ConnectionCatalogEntry {
  return { target: routes[0]!.target, profile: routes[0]!.profile, routes } as never;
}

function preparedFor(route: ConnectionRoute, httpBaseUrl: string): PreparedConnection {
  return {
    environmentId,
    label: "dev1",
    httpBaseUrl,
    socketUrl: httpBaseUrl.replace(/^http/, "ws"),
    httpAuthorization: null,
    target: route.target,
  };
}

describe("unlockTransportProblem", () => {
  it("allows this machine, the tailnet, overlay networks, and HTTPS", () => {
    const cases = [
      direct("lo", "http://127.0.0.1:3773/"),
      direct("ts", "https://dev1.tail1234.ts.net/"),
      direct("magic", "http://dev1:3773/", "tailscale"),
      direct("cgnat", "http://100.101.102.103:3773/"),
      direct("public-tls", "https://t3.example.com/"),
    ];
    for (const route of cases) {
      const profile = Option.getOrThrow(route.profile) as BearerConnectionProfile;
      expect(
        unlockTransportProblem(entryFor([route]), preparedFor(route, profile.httpBaseUrl)),
      ).toBeNull();
    }
  });

  it("refuses T3 Connect and plaintext LAN or public routes", () => {
    const lan = direct("lan", "http://192.168.1.10:3773/");
    const publicHttp = direct("public", "http://t3.example.com/");
    expect(
      unlockTransportProblem(entryFor([lan, RELAY]), preparedFor(RELAY, "https://relay.t3.codes/")),
    ).toBe("relay");
    expect(
      unlockTransportProblem(entryFor([lan]), preparedFor(lan, "http://192.168.1.10:3773/")),
    ).toBe("plaintext");
    expect(
      unlockTransportProblem(
        entryFor([publicHttp]),
        preparedFor(publicHttp, "http://t3.example.com/"),
      ),
    ).toBe("plaintext");
  });

  it("has nothing to say before a connection is prepared", () => {
    const lan = direct("lan", "http://192.168.1.10:3773/");
    expect(unlockTransportProblem(entryFor([lan]), null)).toBeNull();
  });
});

describe("secrets settings helpers", () => {
  const projectA = ProjectId.make("project-a");
  const projectB = ProjectId.make("project-b");
  const names = new Map([[projectA, "Web app"]]);
  const titleFor = (id: ProjectId) => names.get(id) ?? null;

  it("summarizes grants in plain words", () => {
    expect(grantSummary([], titleFor)).toBe("No projects");
    expect(grantSummary("all", titleFor)).toBe("All projects");
    expect(grantSummary([projectA], titleFor)).toBe("Web app");
    expect(grantSummary([projectB], titleFor)).toBe("1 removed project");
    expect(grantSummary([projectA, projectB], titleFor)).toBe("2 projects");
  });

  it("toggles one project, expanding an all-projects grant first", () => {
    expect(toggleProjectGrant([], projectA, [projectA, projectB])).toEqual([projectA]);
    expect(toggleProjectGrant([projectA], projectA, [projectA, projectB])).toEqual([]);
    expect(toggleProjectGrant("all", projectA, [projectA, projectB])).toEqual([projectB]);
  });

  it("explains alias problems before they reach the server", () => {
    const item = (itemId: string, alias: string): ForkSecretItem => ({
      itemId,
      alias,
      name: alias,
      kind: "login",
      username: null,
      collectionIds: [],
      grant: [],
    });
    const items = [item("a", "PROD_DB"), item("b", "DEPLOY_TOKEN")];
    expect(aliasProblem("PROD_DB", items, "a")).toBeNull();
    expect(aliasProblem("DEPLOY_TOKEN", items, "a")).toBe(
      "Another secret already uses that alias.",
    );
    expect(aliasProblem("PATH", items, "a")).toContain("reserved");
    expect(aliasProblem("", items, "a")).toBe("Enter an alias.");
    expect(matchesSecretQuery(items[0]!, "prod")).toBe(true);
    expect(matchesSecretQuery(items[0]!, "billing")).toBe(false);
  });

  it("names Bitwarden servers the way people say them", () => {
    expect(bitwardenServerChoice(null)).toBe("us");
    expect(bitwardenServerChoice("https://vault.bitwarden.eu")).toBe("eu");
    expect(bitwardenServerChoice("https://vault.example.com")).toBe("self-hosted");
    expect(serverHost(null)).toBe("bitwarden.com");
    expect(serverHost("https://vault.bitwarden.eu")).toBe("bitwarden.eu");
  });
});
