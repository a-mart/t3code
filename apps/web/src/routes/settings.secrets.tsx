import { createFileRoute } from "@tanstack/react-router";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SecretsSettingsPanel } from "../fork/secrets/SecretsSettingsPanel";

function SettingsSecretsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its secrets.`
          : "Connect an environment to manage its secrets."}
      </p>
    );
  }
  return (
    <SecretsSettingsPanel
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

export const Route = createFileRoute("/settings/secrets")({
  component: SettingsSecretsRoute,
});
