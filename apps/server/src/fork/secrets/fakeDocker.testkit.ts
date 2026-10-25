import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A stand-in for the Docker CLI. It keeps its engine state in the folder
 * `DOCKER_CONFIG` names (a variable T3 passes to Docker), logs every
 * invocation there, and runs `exec`'d programs on the host, mapping the
 * container's mount targets back to their sources so commands find the
 * workspace.
 */
const FAKE_DOCKER_SCRIPT = String.raw`#!/usr/bin/env node
"use strict";
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const { spawnSync, spawn } = process.getBuiltinModule("node:child_process");
const dir = process.env.DOCKER_CONFIG;
if (!dir) process.exit(9);
const statePath = path.join(dir, "fake-docker.json");
const read = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { endpoint: "unix:///fake/docker.sock", engine: true, built: false, containers: {} }; }
};
const write = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
let args = process.argv.slice(2);
const state = read();
fs.appendFileSync(path.join(dir, "invocations.jsonl"), JSON.stringify(args) + "\n");
const out = (text) => { process.stdout.write(text); process.exit(0); };
if (args[0] === "context") out(JSON.stringify(state.endpoint) + "\n");
if (args[0] !== "--host" || args[1] !== state.endpoint) process.exit(3);
args = args.slice(2);
if (!state.engine) process.exit(1);
const containerName = (list) => list.find((arg, index) => index > 0 && !arg.startsWith("-") && list[index - 1] !== "--user");
// Containers answer to their name or to the id create printed.
const lookup = (key) => state.containers[key] ? key : Object.keys(state.containers).find((name) => state.containers[name].id === key);
switch (args[0]) {
  case "version":
    out(JSON.stringify({ Os: "linux", Version: "29.0.0" }) + "\n");
  case "image":
    if (!state.built) process.exit(1);
    out("1\n");
  case "build": {
    const dockerfile = fs.readFileSync(0, "utf8");
    fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfile);
    write({ ...state, built: true });
    out("sha256:fake\n");
  }
  case "container": {
    const container = state.containers[args[2]];
    if (!container) process.exit(1);
    out(JSON.stringify([{ Id: container.id, Config: { Image: container.image, Labels: container.labels }, State: { Running: container.running } }]));
  }
  case "create": {
    const name = args[args.indexOf("--name") + 1];
    const labels = {};
    const mounts = [];
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === "--label") {
        const [key, ...rest] = args[index + 1].split("=");
        labels[key] = rest.join("=");
      }
      if (args[index] === "--mount") mounts.push(Object.fromEntries(args[index + 1].split(",").map((part) => part.split("="))));
    }
    const image = args[args.indexOf("node") - 1];
    const id = "id-" + Math.random().toString(16).slice(2);
    state.containers[name] = { id, image, labels, mounts, running: false, args };
    write(state);
    out(id + "\n");
  }
  case "start": {
    const name = lookup(args[1]);
    if (!name) process.exit(1);
    state.containers[name].running = true;
    write(state);
    out(args[1] + "\n");
  }
  case "rm": {
    if (state.failRm) process.exit(1);
    delete state.containers[args[args.length - 1]];
    write(state);
    out("");
  }
  case "ps": {
    const filters = args.filter((_, index) => args[index - 1] === "--filter").map((filter) => filter.replace(/^label=/, "").split("="));
    const names = Object.entries(state.containers)
      .filter(([, container]) => filters.every(([key, value]) => container.labels[key] === value))
      .map(([name]) => name);
    out(names.map((name) => name + "\n").join(""));
  }
  case "exec": {
    const interactive = args.includes("-i");
    const container = state.containers[lookup(containerName(args))];
    if (!container || !container.running) process.exit(1);
    // The client losing its connection to the engine.
    if (interactive && state.dropExec) process.exit(125);
    const source = args[args.indexOf("-e") + 1];
    const extra = args.slice(args.indexOf("-e") + 2);
    const toHost = (value) => {
      for (const mount of container.mounts) {
        if (value === mount.target || value.startsWith(mount.target + "/")) return mount.source + value.slice(mount.target.length);
      }
      return value;
    };
    if (!interactive) {
      const result = spawnSync(process.execPath, ["-e", source, ...extra], { stdio: "inherit" });
      process.exit(result.status ?? 1);
    }
    const frame = JSON.parse(fs.readFileSync(0, "utf8"));
    fs.appendFileSync(path.join(dir, "frames.jsonl"), JSON.stringify({ cwd: frame.cwd, git: frame.git, envNames: Object.keys(frame.env), sshFiles: Object.keys(frame.sshFiles) }) + "\n");
    frame.cwd = toHost(frame.cwd);
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(JSON.stringify(frame));
    child.on("exit", (code) => process.exit(code ?? 1));
    break;
  }
  default:
    process.exit(2);
}
`;

export interface FakeDockerState {
  readonly endpoint: string;
  readonly engine: boolean;
  readonly built: boolean;
  /** Commands' `docker exec` clients exit at once, as when the engine connection drops. */
  readonly dropExec?: boolean;
  /** \`docker rm\` fails, as when the engine can't remove a container. */
  readonly failRm?: boolean;
  readonly containers: Readonly<
    Record<
      string,
      {
        readonly id?: string;
        readonly image: string;
        readonly labels: Readonly<Record<string, string>>;
        readonly mounts: ReadonlyArray<Readonly<Record<string, string>>>;
        readonly running: boolean;
        readonly args: ReadonlyArray<string>;
      }
    >
  >;
}

/** Writes the fake as `docker` (or `docker.exe`) in `binDirectory`, with its state in `stateDirectory`. */
export const installFakeDocker = Effect.fn("installFakeDocker")(function* (input: {
  readonly binDirectory: string;
  readonly stateDirectory: string;
  readonly name?: string;
  readonly state?: Partial<FakeDockerState>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(input.binDirectory, { recursive: true });
  yield* fileSystem.makeDirectory(input.stateDirectory, { recursive: true });
  // Named outright: the PATH Docker gets in tests may not lead to node.
  yield* fileSystem.writeFileString(
    path.join(input.binDirectory, input.name ?? "docker"),
    FAKE_DOCKER_SCRIPT.replace("#!/usr/bin/env node", `#!${process.execPath}`),
    { mode: 0o755 },
  );
  if (input.state !== undefined) yield* writeFakeDocker(input.stateDirectory, input.state);
});

export const readFakeDocker = Effect.fn("readFakeDocker")(function* (stateDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(stateDirectory, "fake-docker.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const defaults: FakeDockerState = {
    endpoint: "unix:///fake/docker.sock",
    engine: true,
    built: false,
    containers: {},
  };
  return text === "" ? defaults : (decodeJson(text) as FakeDockerState);
});

export const writeFakeDocker = Effect.fn("writeFakeDocker")(function* (
  stateDirectory: string,
  patch: Partial<FakeDockerState>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* readFakeDocker(stateDirectory);
  yield* fileSystem.writeFileString(
    path.join(stateDirectory, "fake-docker.json"),
    encodeJson({ ...current, ...patch }),
  );
});

const readLines = Effect.fn("readLines")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeJson(line));
});

/** Every Docker CLI call's arguments. */
export const readDockerInvocations = (stateDirectory: string) =>
  Path.Path.pipe(
    Effect.flatMap((path) => readLines(path.join(stateDirectory, "invocations.jsonl"))),
    Effect.map((lines) => lines as ReadonlyArray<ReadonlyArray<string>>),
  );

/** What each command's frame held, without its values. */
export const readDockerFrames = (stateDirectory: string) =>
  Path.Path.pipe(
    Effect.flatMap((path) => readLines(path.join(stateDirectory, "frames.jsonl"))),
    Effect.map(
      (lines) =>
        lines as ReadonlyArray<{
          readonly cwd: string;
          readonly git: Readonly<Record<string, string>> | null;
          readonly envNames: ReadonlyArray<string>;
          readonly sshFiles: ReadonlyArray<string>;
        }>,
    ),
  );
