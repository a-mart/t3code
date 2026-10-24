// @effect-diagnostics nodeBuiltinImport:off - zlib's gzip for test archives.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeZlib from "node:zlib";

/**
 * A stand-in for nono. It reports a version, records the arguments and
 * environment of its latest run beside itself, and runs the command after
 * `--` without a sandbox, so tests can see what the sandbox would allow.
 */
export const FAKE_NONO_SCRIPT = String.raw`#!/bin/bash
if [ "$1" = "--version" ]; then echo "nono 0.80.0"; exit 0; fi
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "$@" > "$dir/last-args"
env > "$dir/last-env"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

export const writeFakeNono = Effect.fn("writeFakeNono")(function* (executable: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fileSystem.writeFileString(executable, FAKE_NONO_SCRIPT, { mode: 0o755 });
  return executable;
});

export interface FakeNonoRun {
  /** Directories granted read and write, read only, and single files granted read. */
  readonly writable: ReadonlyArray<string>;
  readonly readable: ReadonlyArray<string>;
  readonly readableFiles: ReadonlyArray<string>;
  /** Protections lifted for the paths named. */
  readonly bypassed: ReadonlyArray<string>;
  readonly sockets: ReadonlyArray<string>;
  /** What nono was asked to run. */
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** The latest `wrap` run of the fake nono at `executable`. */
export const readFakeNonoRun = Effect.fn("readFakeNonoRun")(function* (executable: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(executable);
  const args = (yield* fileSystem.readFileString(path.join(directory, "last-args")))
    .replace(/\n$/, "")
    .split("\n");
  const separator = args.indexOf("--");
  const flags = args.slice(0, separator);
  const valuesOf = (flag: string) =>
    flags.flatMap((value, index) => (flags[index - 1] === flag ? [value] : []));
  const env = Object.fromEntries(
    (yield* fileSystem.readFileString(path.join(directory, "last-env")))
      .split("\n")
      .flatMap((line) => {
        const equals = line.indexOf("=");
        return equals > 0 ? [[line.slice(0, equals), line.slice(equals + 1)] as const] : [];
      }),
  );
  return {
    writable: valuesOf("--allow"),
    readable: valuesOf("--read"),
    readableFiles: valuesOf("--read-file"),
    bypassed: valuesOf("--bypass-protection"),
    sockets: valuesOf("--allow-unix-socket"),
    command: args.slice(separator + 1),
    env,
  } satisfies FakeNonoRun;
});

/** A gzipped ustar archive of regular files, laid out like nono's release archives. */
export const makeTarGz = (
  entries: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>,
): Uint8Array => {
  const blocks: Array<Uint8Array> = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, "utf8");
    header.write("0000755\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${entry.data.byteLength.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header[156] = 0x30;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, entry.data, Buffer.alloc((512 - (entry.data.byteLength % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return NodeZlib.gzipSync(Buffer.concat(blocks));
};
