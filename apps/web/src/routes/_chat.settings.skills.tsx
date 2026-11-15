import { createFileRoute } from "@tanstack/react-router";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SkillsSettingsPanel } from "../fork/skills/SkillsSettingsPanel";

function SettingsSkillsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its skills.`
          : "Connect an environment to manage its skills."}
      </p>
    );
  }
  return (
    <SkillsSettingsPanel
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/skills")({
  component: SettingsSkillsRoute,
});
