import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  routeHttpBaseUrl,
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  isValidForkSecretAlias,
  type ForkSecretGrant,
  type ForkSecretItem,
  type ProjectId,
} from "@t3tools/contracts";

export type UnlockTransportProblem = "relay" | "plaintext";

/**
 * Why sending the master password over the connection in use now would expose
 * it: T3 Connect terminates TLS at Cloudflare's edge, and plain HTTP on a LAN
 * or the internet is readable on the network. Overlay networks count as
 * private: an untagged Tailscale address classifies as `vpn`, not `tailnet`.
 * A client safeguard; the server can't tell which route a request took.
 */
export function unlockTransportProblem(
  entry: ConnectionCatalogEntry,
  prepared: PreparedConnection | null,
): UnlockTransportProblem | null {
  if (prepared === null) return null;
  if (prepared.target._tag === "RelayConnectionTarget") return "relay";
  const route = connectionRoutes(entry).find(
    (candidate) => connectionRouteId(candidate.target) === connectionRouteId(prepared.target),
  );
  const kind = route === undefined ? null : connectionRouteKind(route);
  if (kind === "relay") return "relay";
  if (kind === "loopback" || kind === "tailnet" || kind === "vpn" || kind === "ssh") return null;
  const httpBaseUrl =
    (route === undefined ? null : routeHttpBaseUrl(route)) ?? prepared.httpBaseUrl;
  return httpBaseUrl.startsWith("https:") ? null : "plaintext";
}

export const BITWARDEN_SERVERS = [
  { id: "us", label: "Bitwarden.com", url: null },
  { id: "eu", label: "Bitwarden.eu", url: "https://vault.bitwarden.eu" },
  { id: "self-hosted", label: "Self-hosted", url: null },
] as const;
export type BitwardenServerChoice = (typeof BITWARDEN_SERVERS)[number]["id"];

export function bitwardenServerChoice(serverUrl: string | null): BitwardenServerChoice {
  if (serverUrl === null || serverUrl === "https://vault.bitwarden.com") return "us";
  return serverUrl === "https://vault.bitwarden.eu" ? "eu" : "self-hosted";
}

export function serverHost(serverUrl: string | null): string {
  if (serverUrl === null) return "bitwarden.com";
  try {
    return new URL(serverUrl).host.replace(/^vault\./, "");
  } catch {
    return serverUrl;
  }
}

export function grantSummary(
  grant: ForkSecretGrant,
  projectName: (projectId: ProjectId) => string | null,
): string {
  if (grant === "all") return "All projects";
  if (grant.length === 0) return "No projects";
  if (grant.length === 1) return projectName(grant[0]!) ?? "1 removed project";
  return `${grant.length} projects`;
}

/** The grant after toggling one project, keeping removed projects out. */
export function toggleProjectGrant(
  grant: ForkSecretGrant,
  projectId: ProjectId,
  allProjectIds: ReadonlyArray<ProjectId>,
): ForkSecretGrant {
  const current = grant === "all" ? allProjectIds : grant;
  return current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId];
}

export function aliasProblem(
  alias: string,
  items: ReadonlyArray<ForkSecretItem>,
  itemId: string,
): string | null {
  if (alias.length === 0) return "Enter an alias.";
  if (!isValidForkSecretAlias(alias)) {
    return "Use capital letters, digits, and underscores, starting with a letter. Shell names like PATH are reserved.";
  }
  return items.some((item) => item.itemId !== itemId && item.alias === alias)
    ? "Another secret already uses that alias."
    : null;
}

export function matchesSecretQuery(item: ForkSecretItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [item.name, item.alias, item.username ?? ""].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
