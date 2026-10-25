/**
 * Programs that run inside a secure runner container through `node -e`, so the
 * image needs only Node. Values arrive in a JSON frame on stdin, never in
 * Docker's arguments or metadata. Paths come from the frame's layout, so tests
 * can run the executor directly on the host.
 */

/**
 * Runs one command: a clean environment, a private TMPDIR, the values, an
 * ssh-agent for its keys, and the host's SSH known_hosts and config in HOME. Like a command on the host, the shell's whole process
 * group is ended when it exits. A failure before the command starts exits 125
 * with a `t3-secure-executor:` line on stderr. Its last stderr line, the
 * frame's `done` code, comes only after cleanup, so a host that doesn't see it
 * can't know the command and its ssh-agent are gone.
 */
export const GUEST_EXECUTOR_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_FRAME_BYTES = 17 * 1024 * 1024;
const EXECUTION_ID = /^[a-f0-9]{24}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code, exitCode) {
  process.stderr.write("t3-secure-executor:" + code + "\n");
  process.exitCode = exitCode;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const absolute = (value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}
async function endGroup(pid) {
  signalGroup(pid, "SIGTERM");
  for (let waited = 0; waited < 3000 && groupAlive(pid); waited += 50) await delay(50);
  signalGroup(pid, "SIGKILL");
}

async function startAgent(root, env, keys) {
  const socket = path.join(root, "agent.sock");
  const agent = spawn("ssh-agent", ["-D", "-a", socket], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = await new Promise((resolve) => {
    let text = "";
    const timer = setTimeout(() => resolve(false), 5000);
    agent.once("error", () => resolve(false));
    agent.once("exit", () => resolve(false));
    agent.stdout.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.includes("SSH_AUTH_SOCK=")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  if (!ready) {
    agent.kill("SIGKILL");
    throw new Error("ssh-agent");
  }
  for (const key of keys) {
    const code = await new Promise((resolve) => {
      const add = spawn("ssh-add", ["-"], {
        env: { ...env, SSH_AUTH_SOCK: socket },
        stdio: ["pipe", "ignore", "ignore"],
      });
      add.once("error", () => resolve(-1));
      add.once("close", (exitCode) => resolve(exitCode));
      add.stdin.on("error", () => {});
      add.stdin.end(key);
    });
    if (code !== 0) {
      agent.kill("SIGKILL");
      throw new Error("ssh-key");
    }
  }
  return { agent, socket };
}

async function main(frame) {
  const layout = frame.layout;
  if (
    !frame ||
    frame.version !== 1 ||
    !EXECUTION_ID.test(frame.executionId) ||
    typeof frame.command !== "string" ||
    !absolute(frame.cwd) ||
    !layout ||
    ![layout.executions, layout.temp, layout.home, layout.askpass].every(absolute) ||
    typeof layout.path !== "string" ||
    !layout.env ||
    !frame.env ||
    !Object.entries(frame.env).every(([name, value]) => NAME.test(name) && typeof value === "string") ||
    !Array.isArray(frame.sshKeys) ||
    !frame.sshKeys.every((key) => typeof key === "string") ||
    !frame.sshFiles ||
    !Object.entries(frame.sshFiles).every(
      ([name, text]) => ["known_hosts", "config"].includes(name) && typeof text === "string",
    ) ||
    typeof frame.done !== "string"
  ) {
    throw new Error("invalid");
  }
  const root = path.join(layout.executions, frame.executionId);
  const temp = path.join(layout.temp, frame.executionId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.home, { recursive: true, mode: 0o700 });
  const ssh = path.join(layout.home, ".ssh");
  if (Object.keys(frame.sshFiles).length > 0) fs.mkdirSync(ssh, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(frame.sshFiles)) {
    fs.writeFileSync(path.join(ssh, name), text, { mode: 0o600 });
  }
  const env = {
    PATH: layout.path,
    HOME: layout.home,
    USER: "t3",
    LOGNAME: "t3",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    T3_ASKPASS: layout.askpass,
    // Mounted host folders belong to another user, which git otherwise refuses to work in.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    ...layout.env,
    ...(frame.git ?? {}),
    ...frame.env,
  };
  let agent;
  try {
    if (frame.sshKeys.length > 0) {
      const started = await startAgent(root, env, frame.sshKeys);
      agent = started.agent;
      env.SSH_AUTH_SOCK = started.socket;
    }
    if (fs.existsSync(path.join(root, "cancel"))) {
      fail("cancelled", 125);
      return;
    }
    const child = spawn("bash", ["--noprofile", "--norc", "-c", frame.command], {
      cwd: frame.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Watched before anything waits, so no exit is missed.
    const outcome = new Promise((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 0)));
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    if (child.pid === undefined) {
      await outcome;
      fail("spawn", 125);
      return;
    }
    fs.writeFileSync(path.join(root, "pid"), String(child.pid), { mode: 0o600 });
    // A stop that came between the check above and the pid file found no process to end.
    if (fs.existsSync(path.join(root, "cancel"))) await endGroup(child.pid);
    const exitCode = await outcome;
    // Background children would hold the pipes open, and could hold a value.
    await endGroup(child.pid);
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(200)]);
    child.stdout.destroy();
    child.stderr.destroy();
    process.exitCode = exitCode;
  } finally {
    if (agent && !exited(agent)) agent.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.byteLength;
  if (size > MAX_FRAME_BYTES) {
    fail("invalid", 125);
    process.exit();
  }
  chunks.push(chunk);
});
process.stdin.once("end", () => {
  let frame;
  try {
    frame = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("invalid", 125);
    return;
  }
  main(frame)
    .catch((error) => {
      const code = error && error.message;
      fail(code === "ssh-agent" || code === "ssh-key" ? code : "invalid", 125);
    })
    .then(() => {
      if (typeof frame.done === "string") process.stderr.write(frame.done);
    });
});
`;

/**
 * Ends one execution: argv is the executions root and its id. The cancel mark
 * comes first, even for an execution that hasn't started, which then never
 * runs its command; exiting 0 means the mark is in place.
 */
export const GUEST_TERMINATOR_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [root, id] = process.argv.slice(1);
if (typeof root !== "string" || !path.isAbsolute(root) || !/^[a-f0-9]{24}$/.test(id ?? "")) {
  process.exit(2);
}
const execution = path.join(root, id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};
(async () => {
  fs.mkdirSync(execution, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(execution, "cancel"), "");
  let pid = null;
  try {
    pid = Number(fs.readFileSync(path.join(execution, "pid"), "utf8"));
  } catch {}
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  signalGroup(pid, "SIGTERM");
  await delay(1000);
  signalGroup(pid, "SIGKILL");
})().catch(() => process.exit(1));
`;

export const GUEST_HEARTBEAT_PATH = "/run/t3-secure-heartbeat";

/**
 * The container's first process. It exits once T3 stops touching the mounted
 * heartbeat file, so a T3 that was killed can't leave a container holding
 * values behind; Docker then ends every process in it.
 */
export const GUEST_KEEPALIVE_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const heartbeat = "/run/t3-secure-heartbeat";
const stale = () => {
  try {
    return Date.now() - fs.statSync(heartbeat).mtimeMs > 15000;
  } catch {
    return true;
  }
};
if (stale()) process.exit(70);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {
  if (stale()) process.exit(71);
}, 1000);
`;
