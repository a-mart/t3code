import * as Layer from "effect/Layer";

import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as SecretsHandlers from "./secrets/toolkit/handlers.ts";
import { SecretsToolkit } from "./secrets/toolkit/tools.ts";
import * as SkillsHandlers from "./skills/toolkit/handlers.ts";
import { SkillsToolkit } from "./skills/toolkit/tools.ts";

/**
 * Fork MCP toolkits. They join T3's own MCP server, so every provider session
 * that has T3's tools gets them too. `McpHttpServer` passes in its
 * registration function, which keeps this module from importing it back.
 */
export const layer = (register: typeof toolkitRegistration) =>
  Layer.mergeAll(
    register(SecretsToolkit, SecretsHandlers.layer),
    register(SkillsToolkit, SkillsHandlers.layer),
  );
