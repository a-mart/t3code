import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { readFakeNonoRun, writeFakeNono } from "./fakeNono.testkit.ts";
import * as SecureExec from "./SecureExec.ts";

const layer = SecureExec.layer.pipe(Layer.provideMerge(NodeServices.layer));
const text = (output: SecureExec.SecureExecOutput["stdout"]) =>
  new TextDecoder().decode(output.bytes);

const run = (
  command: string,
  options: {
    cwd?: string;
    deliveries?: Record<string, string>;
    sshKeys?: ReadonlyArray<string>;
    timeout?: Duration.Duration;
    nono?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const exec = yield* SecureExec.SecureExec;
    return yield* exec.run({
      command,
      cwd: options.cwd ?? process.cwd(),
      deliveries: options.deliveries ?? {},
      sshKeys: options.sshKeys ?? [],
      timeout: options.timeout ?? Duration.seconds(30),
      nono: options.nono ?? null,
    });
  });

/** A scratch folder with the fake nono in it, and a home folder T3 is told is the user's. */
const sandboxFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secure-exec-nono-" });
  const nono = yield* writeFakeNono(path.join(directory, "bin", "nono"));
  const home = path.join(directory, "home");
  yield* fileSystem.makeDirectory(home);
  return { directory, nono, home, realHome: yield* fileSystem.realPath(home) };
});

/** A throwaway key from the host's ssh-keygen: ed25519 in OpenSSH format, or RSA in PEM. */
const generateKey = Effect.fn("generateKey")(function* (format: "openssh" | "pem" = "openssh") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secure-exec-key-" });
  const keyPath = path.join(directory, "id");
  const type = format === "pem" ? "-t rsa -b 2048 -m PEM" : "-t ed25519";
  const output = yield* run(`ssh-keygen -q ${type} -N '' -C t3-test -f '${keyPath}'`);
  expect(output.exitCode).toBe(0);
  return yield* fileSystem.readFileString(keyPath);
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("SecureExec", () => {
  it.live("delivers values without the startup hooks or Bitwarden variables of its host", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-secure-exec-test-",
      });
      const hook = path.join(directory, "hook.sh");
      yield* fileSystem.writeFileString(hook, "echo HOOK_RAN\n");
      const output = yield* run(
        'echo "value=$TOKEN session=${BW_SESSION:-unset} app=${BITWARDENCLI_APPDATA_DIR:-unset}"',
        { deliveries: { TOKEN: "t0k3n" } },
      ).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          BASH_ENV: hook,
          ENV: hook,
          BW_SESSION: "ambient",
          BITWARDENCLI_APPDATA_DIR: "/elsewhere",
        }),
      );
      expect(text(output.stdout)).toBe("value=t0k3n session=unset app=unset\n");
      expect(output.exitCode).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("gives each command a private temporary directory and removes it afterwards", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const output = yield* run('test -d "$TMPDIR" && test "$TMPDIR" = "$TMP" && echo "$TMPDIR"');
      const directory = text(output.stdout).trim();
      expect(directory).toContain("t3-secure-");
      expect(yield* fileSystem.exists(directory)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.live("keeps stdout and stderr apart", () =>
    Effect.gen(function* () {
      const output = yield* run("printf 'one'; printf 'two' >&2; printf 'three'; exit 3");
      expect(text(output.stdout)).toBe("onethree");
      expect(text(output.stderr)).toBe("two");
      expect(output.exitCode).toBe(3);
    }).pipe(Effect.provide(layer)),
  );

  it.live("stops a command at its timeout", () =>
    Effect.gen(function* () {
      const output = yield* run("echo started; sleep 30", { timeout: Duration.millis(300) });
      expect(output.timedOut).toBe(true);
      expect(output.exitCode).toBeNull();
      expect(text(output.stdout)).toBe("started\n");
    }).pipe(Effect.provide(layer)),
  );

  it.live("kills background children that ignore TERM once the shell exits", () =>
    Effect.gen(function* () {
      const output = yield* run("(trap '' TERM; exec sleep 30) & echo $!");
      const pid = Number(text(output.stdout).trim());
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      expect(isAlive(pid)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.live("flags output past its cap instead of keeping it", () =>
    Effect.gen(function* () {
      const output = yield* run(
        `head -c ${SecureExec.SECURE_EXEC_MAX_STREAM_BYTES + 1024} /dev/zero | tr '\\0' 'a'`,
      );
      expect(output.stdout.overflow).toBe(true);
      expect(output.stdout.bytes.byteLength).toBeLessThanOrEqual(
        SecureExec.SECURE_EXEC_MAX_STREAM_BYTES,
      );
      expect(output.exitCode).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live("offers an askpass helper that prints only the variable it is pointed at", () =>
    Effect.gen(function* () {
      const output = yield* run(
        [
          'T3_ASKPASS_VAR=TOKEN "$T3_ASKPASS" "Password:"',
          'T3_ASKPASS_VAR=\'$(id)\' "$T3_ASKPASS" || echo "refused $?"',
        ].join("\n"),
        { deliveries: { TOKEN: "t0k3n-value" } },
      );
      expect(text(output.stdout)).toBe("t0k3n-value\nrefused 64\n");
    }).pipe(Effect.provide(layer)),
  );

  it.live("loads SSH keys into an agent that ends with the command", () =>
    Effect.gen(function* () {
      const key = yield* generateKey();
      const output = yield* run('ssh-add -l && echo "socket=$SSH_AUTH_SOCK"', {
        sshKeys: [key.replaceAll("\n", "\r\n")],
      });
      expect(output.exitCode).toBe(0);
      const stdout = text(output.stdout);
      expect(stdout).toContain("t3-test (ED25519)");
      const socket = stdout.match(/socket=(.+)/)?.[1];
      const fileSystem = yield* FileSystem.FileSystem;
      expect(socket).toBeDefined();
      expect(yield* fileSystem.exists(socket!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("restores the line breaks a single-line paste took out of a key", () =>
    Effect.gen(function* () {
      for (const format of ["openssh", "pem"] as const) {
        const key = yield* generateKey(format);
        expect(SecureExec.normalizeSshPrivateKey(key.replaceAll("\n", ""))).toBe(key);
        expect(SecureExec.normalizeSshPrivateKey(key.replaceAll("\n", " "))).toBe(key);
        expect(SecureExec.normalizeSshPrivateKey(key)).toBe(key);
      }
      expect(SecureExec.normalizeSshPrivateKey("hunter2\nwith a newline")).toBe(
        "hunter2\nwith a newline",
      );
      const flattened = (yield* generateKey()).replaceAll("\n", "");
      const output = yield* run("ssh-add -l", { sshKeys: [flattened] });
      expect(text(output.stdout)).toContain("t3-test (ED25519)");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("rejects a key ssh-add can't load", () =>
    Effect.gen(function* () {
      const error = yield* run("true", {
        sshKeys: [
          "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----\n",
        ],
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "SecureExecError", stage: "ssh_key" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("SecureExec in the sandbox", () => {
  it.live("gives the command its secrets, an empty HOME, and none of the host's variables", () =>
    Effect.gen(function* () {
      const fixture = yield* sandboxFixture;
      const output = yield* run(
        [
          'echo "token=$TOKEN host=${HOST_TOKEN:-unset} agent=${SSH_AUTH_SOCK:-unset}"',
          'case "$HOME" in "$TMPDIR"/*) test -z "$(ls -A "$HOME")" && touch "$HOME/cache" && echo "private home";; esac',
        ].join("\n"),
        { deliveries: { TOKEN: "t0k3n" }, nono: fixture.nono },
      ).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          HOST_TOKEN: "host-token",
          SSH_AUTH_SOCK: "/tmp/host-agent.sock",
        }),
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      expect(text(output.stdout)).toBe("token=t0k3n host=unset agent=unset\nprivate home\n");
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      // nono applies its credential protections against the real home folder.
      expect(sandbox.env.HOME).toBe(fixture.home);
      expect(sandbox.env.NONO_NO_UPDATE_CHECK).toBe("1");
      expect(sandbox.env.HOST_TOKEN).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lets the command write only to its workspace and private folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      const workspace = path.join(fixture.directory, "workspace");
      yield* fileSystem.makeDirectory(workspace);
      const output = yield* run('echo "$TMPDIR"', { cwd: workspace, nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      // The private folder is gone by now, so its real path is found through its parent.
      const temporary = text(output.stdout).trim();
      expect(sandbox.writable).toEqual([
        yield* fileSystem.realPath(workspace),
        path.join(yield* fileSystem.realPath(path.dirname(temporary)), path.basename(temporary)),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lets git in a linked worktree write to the main repository's git directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      const main = path.join(fixture.directory, "main");
      const worktree = path.join(fixture.directory, "worktree");
      const worktreeGitDirectory = path.join(main, ".git", "worktrees", "worktree");
      yield* fileSystem.makeDirectory(worktreeGitDirectory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(worktreeGitDirectory, "commondir"), "../..\n");
      yield* fileSystem.makeDirectory(worktree);
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${worktreeGitDirectory}\n`,
      );
      yield* run("true", { cwd: worktree, nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(worktree));
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(path.join(main, ".git")));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lets git write to a .git directory symlinked outside the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      const project = path.join(fixture.directory, "project");
      const gitData = path.join(fixture.directory, "git-data", "project.git");
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.makeDirectory(gitData, { recursive: true });
      yield* fileSystem.symlink(gitData, path.join(project, ".git"));
      yield* run("true", { cwd: project, nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(project));
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(gitData));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("grants a symlinked workspace's own repository, not the link's", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      const linking = path.join(fixture.directory, "linking");
      const target = path.join(fixture.directory, "target");
      yield* fileSystem.makeDirectory(path.join(linking, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(target, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(target, "src"));
      yield* fileSystem.symlink(path.join(target, "src"), path.join(linking, "link"));
      yield* run("true", { cwd: path.join(linking, "link"), nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(target));
      expect(sandbox.writable).not.toContain(yield* fileSystem.realPath(linking));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("refuses a workspace whose path holds a comma, which nono splits on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      // `--allow .../demo,old` would grant a sibling `.../demo` instead.
      yield* fileSystem.makeDirectory(path.join(fixture.directory, "demo"));
      const workspace = path.join(fixture.directory, "demo,old");
      yield* fileSystem.makeDirectory(workspace);
      const error = yield* run("true", { cwd: workspace, nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "SecureExecError", stage: "sandbox_path" });
      expect(yield* fileSystem.exists(path.join(path.dirname(fixture.nono), "last-args"))).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("never grants a repository that holds the home folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      // Like a dotfiles repository at ~: granting it would open the whole home folder.
      yield* fileSystem.makeDirectory(path.join(fixture.home, ".git"));
      const project = path.join(fixture.home, "notes");
      yield* fileSystem.makeDirectory(project);
      yield* run("true", { cwd: project, nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      expect(sandbox.writable).toContain(yield* fileSystem.realPath(project));
      expect(sandbox.writable).not.toContain(fixture.realHome);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lets tools installed in the home folder run, without its shared folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* sandboxFixture;
      for (const directory of ["toolchain/bin", ".local/bin", "Library/pnpm", ".local/state"]) {
        yield* fileSystem.makeDirectory(path.join(fixture.home, directory), { recursive: true });
      }
      // A file on PATH, as when a profile adds `~/.cargo/env` by mistake: nono would refuse it.
      yield* fileSystem.makeDirectory(path.join(fixture.home, ".cargo"));
      yield* fileSystem.writeFileString(path.join(fixture.home, ".cargo", "env"), "\n");
      const pathVariable = [
        path.join(fixture.home, "toolchain", "bin"),
        path.join(fixture.home, ".local", "bin"),
        path.join(fixture.home, "Library", "pnpm"),
        path.join(fixture.home, ".local"),
        fixture.home,
        path.join(fixture.home, "missing", "bin"),
        path.join(fixture.home, ".cargo", "env"),
        "/usr/bin",
        "/bin",
      ].join(":");
      yield* run("true", { nono: fixture.nono }).pipe(
        Effect.provideService(HostProcess.Environment, { ...process.env, PATH: pathVariable }),
        Effect.provideService(HostProcess.HomeDirectory, fixture.home),
      );
      const sandbox = yield* readFakeNonoRun(fixture.nono);
      // A version manager's launcher in `bin` loads what sits beside it; `~/.local` and the
      // home folder itself hold far more, and nono keeps its own state under `~/.local`.
      expect(sandbox.readable).toEqual([
        path.join(fixture.realHome, "toolchain"),
        path.join(fixture.realHome, ".local", "bin"),
        path.join(fixture.realHome, "Library", "pnpm"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "lets ssh read known hosts and its config, but no key, and reach the command's agent",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const key = yield* generateKey();
        const fixture = yield* sandboxFixture;
        const ssh = path.join(fixture.home, ".ssh");
        yield* fileSystem.makeDirectory(ssh);
        for (const name of ["config", "known_hosts", "id_ed25519"]) {
          yield* fileSystem.writeFileString(path.join(ssh, name), `${name}\n`);
        }
        const output = yield* run('ssh-add -l >/dev/null && echo "$SSH_AUTH_SOCK"', {
          sshKeys: [key],
          nono: fixture.nono,
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, fixture.home));
        const sandbox = yield* readFakeNonoRun(fixture.nono);
        const realSsh = path.join(fixture.realHome, ".ssh");
        const trusted = [path.join(realSsh, "known_hosts"), path.join(realSsh, "config")];
        expect(sandbox.readableFiles).toEqual(trusted);
        // nono's own policy denies ~/.ssh, so the two files are let through by name.
        expect(sandbox.bypassed).toEqual(trusted);
        expect(sandbox.sockets).toEqual([text(output.stdout).trim()]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
