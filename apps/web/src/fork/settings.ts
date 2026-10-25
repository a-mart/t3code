import { KeyRoundIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { SettingsSearchItem } from "../components/settings/settingsSearch";

/**
 * Fork settings pages. The upstream settings maps spread these in, so a new
 * fork page is a file here plus a route, not another upstream edit.
 */
export type ForkSettingsPath = "/settings/secrets";

export const FORK_SETTINGS_SECTION_LABELS: Readonly<Record<ForkSettingsPath, string>> = {
  "/settings/secrets": "Secrets",
};

export const FORK_SETTINGS_SECTION_ICONS: Readonly<
  Record<ForkSettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/secrets": KeyRoundIcon,
};

export const FORK_SETTINGS_CATEGORY_SCOPES: Readonly<Record<ForkSettingsPath, null>> = {
  "/settings/secrets": null,
};

/** Pages that act on one environment at a time, like Providers. */
export const isForkSingleEnvironmentSettingsPath = (pathname: string) =>
  pathname === "/settings/secrets";

export const FORK_SETTINGS_SEARCH_ITEMS = [
  {
    id: "fork-secrets-bitwarden",
    title: "Bitwarden",
    to: "/settings/secrets",
    searchTerms: [
      "bitwarden vault password manager sign in log in unlock lock master password terminal cli bw",
    ],
  },
  {
    id: "fork-secrets-collections",
    title: "Bitwarden collections",
    to: "/settings/secrets",
    searchTerms: ["collections sync organization vault items"],
  },
  {
    id: "fork-secrets-access",
    title: "Secret access by project",
    to: "/settings/secrets",
    searchTerms: [
      "secrets grant projects agents secure bash alias environment variable token password key credentials",
    ],
  },
  {
    id: "fork-secrets-save",
    title: "Where agents save new secrets",
    to: "/settings/secrets",
    searchTerms: ["save_secret store new secret credential password token agents collection"],
  },
  {
    id: "fork-secrets-sandbox",
    title: "Run secret commands in a sandbox",
    to: "/settings/secrets",
    searchTerms: ["nono sandbox isolate secure_bash home folder write access credentials"],
  },
  {
    id: "fork-secrets-docker",
    title: "Run secret commands in Docker",
    to: "/settings/secrets",
    searchTerms: ["docker desktop container secure runner windows sandbox secure_bash"],
  },
  {
    id: "fork-secrets-keep-unlocked",
    title: "Stay unlocked across restarts",
    to: "/settings/secrets",
    searchTerms: ["bitwarden session restart scheduled tasks lock automatically"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
