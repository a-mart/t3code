import {
  FORK_SECRET_ALIAS_MAX_LENGTH,
  ForkSecretKind,
  OrchestratorMcpFailure,
  SecretRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as SecretsService from "../SecretsService.ts";

export const SECURE_BASH_DEFAULT_TIMEOUT_SECONDS = 120;
const SECURE_BASH_MAX_TIMEOUT_SECONDS = 3_000;
const MAX_SECRET_REFS = 4;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  SecretRequests.SecretRequests,
  SecretsService.SecretsService,
];

const ListSecretsTool = Tool.make("list_secrets", {
  description:
    "List the secrets from the user's Bitwarden vault that agents in this project may use with secure_bash: each one's alias (also its environment variable name in secure_bash), kind (login, note, or ssh_key), item name, and non-secret username. Values are never returned. When bitwarden is locked or not_connected, ask the user to unlock or connect it in Settings → Secrets. Secrets not listed here aren't granted to this project; ask the user to grant one in Settings → Secrets. sandboxed tells whether secure_bash runs commands in a sandbox (see secure_bash).",
  success: Schema.Struct({
    bitwarden: Schema.Literals(["ready", "locked", "not_connected", "unsupported_host"]),
    sandboxed: Schema.Boolean,
    secrets: Schema.Array(
      Schema.Struct({
        alias: Schema.String,
        kind: ForkSecretKind,
        name: Schema.String,
        username: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List secrets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SecureBashTool = Tool.make("secure_bash", {
  description: [
    "Run a bash command on this host with secrets from the user's Bitwarden vault, without seeing their values. Use it only for commands that need a password, token, or key; use your normal shell for everything else.",
    '- Pass the aliases the command needs in secrets (see list_secrets). Each one is an environment variable of the same name for this command only: `curl -H "Authorization: Bearer $DEPLOY_TOKEN" https://…` or `PGPASSWORD="$PROD_DB" psql -h db -U app`. A login\'s username is in list_secrets; type it in the command.',
    "- Never print, echo, encode, hash, or count a value, and never write one into the workspace. Output passes a filter that replaces values with [redacted:ALIAS], but it can't recognize a transformed value.",
    "- For stdin, pipe the variable: `printf '%s' \"$TOKEN\" | tool --password-stdin`. When a tool needs a file, write it under $TMPDIR, which is private and deleted when the command ends.",
    "- An ssh_key secret is also loaded into an ssh-agent for the command (SSH_AUTH_SOCK), so ssh, scp, and git over SSH use it directly. The host must already be in ~/.ssh/known_hosts.",
    '- For a password prompt, point the program at $T3_ASKPASS with T3_ASKPASS_VAR set to the alias: `SSH_ASKPASS="$T3_ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=t3 T3_ASKPASS_VAR=SERVER_PW ssh admin@host uptime`. For sudo, pipe it: `printf \'%s\\n\' "$SERVER_PW" | sudo -S …`.',
    "- For a value that isn't in Bitwarden, call request_secret, then pass { ref: secretRef, name: VAR } in secretRefs to get it as VAR for this command only. A secretRef works once.",
    "- Runs non-interactively with /bin/bash in the thread's workspace: no TTY or prompts. Background processes stop when the command exits. Default timeout 120 seconds, maximum 3000.",
    "- When list_secrets reports sandboxed, the command runs in a sandbox: it can write only in the workspace (with its git directories) and temporary folders such as $TMPDIR, HOME is an empty folder deleted afterwards, and the host's own logins and private keys aren't available. Pass every credential the command needs as a secret.",
    "- Result: exitCode, timedOut, stdout, stderr, and redacted (true when a value was filtered out).",
  ].join("\n"),
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128_000)),
    secrets: Schema.Array(Schema.String).check(
      Schema.isMaxLength(SecretsService.MAX_SECRETS_PER_COMMAND),
    ),
    secretRefs: Schema.optionalKey(
      Schema.Array(Schema.Struct({ ref: SecretRef, name: Schema.String })).check(
        Schema.isMaxLength(MAX_SECRET_REFS),
      ),
    ),
    timeoutSeconds: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SECURE_BASH_MAX_TIMEOUT_SECONDS })),
    ),
  }),
  success: Schema.Struct({
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    stdout: Schema.String,
    stderr: Schema.String,
    redacted: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a command with secrets")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const SaveSecretTool = Tool.make("save_secret", {
  description: [
    "Save a new secret into the user's Bitwarden vault without seeing its value. It's granted to this project at once, so secure_bash can use it by its alias right away.",
    "- The value comes from exactly one of: secretRef, the answer the user typed for request_secret; or command, a bash command whose stdout is the value (one trailing newline dropped), for a credential a command creates: `openssl rand -base64 32`, or a CLI that prints a new API key. A command may use existing secrets, passed in secrets as for secure_bash.",
    "- Only stdout becomes the secret, and stderr comes back filtered, so don't also print the value elsewhere.",
    "- alias is the environment variable secure_bash will use: capital letters, digits, and underscores. name is the Bitwarden item's name, which the user sees; say what it's for.",
    "- type login (the default) holds a one-line value as its password, with an optional non-secret username. type note holds any text, such as a private key or an env file.",
    "- It saves to the collection the user chose under Settings → Secrets. If none is chosen, it fails; ask the user to choose one.",
    "- Result: saved, alias (it can differ if another save took yours at the same moment), and collection. For a command, also exitCode, timedOut, and stderr; a command that fails or times out saves nothing.",
  ].join("\n"),
  parameters: Schema.Struct({
    alias: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(FORK_SECRET_ALIAS_MAX_LENGTH),
    ),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    type: Schema.optionalKey(Schema.Literals(["login", "note"])),
    username: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    secretRef: Schema.optionalKey(SecretRef),
    command: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128_000)),
    ),
    secrets: Schema.optionalKey(
      Schema.Array(Schema.String).check(Schema.isMaxLength(SecretsService.MAX_SECRETS_PER_COMMAND)),
    ),
    timeoutSeconds: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SECURE_BASH_MAX_TIMEOUT_SECONDS })),
    ),
  }),
  success: Schema.Struct({
    saved: Schema.Boolean,
    alias: Schema.NullOr(Schema.String),
    collection: Schema.NullOr(Schema.String),
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    stderr: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a secret")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SecretsToolkit = Toolkit.make(ListSecretsTool, SecureBashTool, SaveSecretTool);
