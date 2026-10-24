// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or gunzip.
/**
 * Installs pinned official releases of the host tools fork features drive,
 * such as `bw` and `nono`, under `<stateDir>/fork/bin`. Each release is pinned
 * by size and SHA-256, so a new binary reaches hosts only through a reviewed
 * change, and an install that fails leaves the previous copy in place.
 */
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { openZipArchive } from "../zipArchive.ts";

const INSTALL_TIMEOUT = Duration.minutes(10);
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const TAR_BLOCK = 512;

export interface PinnedRelease {
  readonly version: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Carries no detail: download, archive, and filesystem errors can quote paths and URLs. */
export class ManagedInstallError extends Schema.TaggedError<ManagedInstallError>()(
  "ManagedInstallError",
  {},
) {}

/** Writes the executable at `destination` from the downloaded archive. */
export type ExtractExecutable = (
  archivePath: string,
  destination: string,
) => Effect.Effect<void, ManagedInstallError, FileSystem.FileSystem>;

/** A zip holding exactly one regular file named `name`; anything else is refused. */
export const singleFileZip =
  (name: string): ExtractExecutable =>
  (archivePath, destination) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const archive = yield* openZipArchive(archivePath, () => new ManagedInstallError());
        const entry = archive.entryCount === 1 ? yield* archive.next : null;
        const unixType = entry === null ? 0 : (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          entry === null ||
          entry.fileName !== name ||
          (unixType !== 0 && unixType !== 0o100000) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          return yield* new ManagedInstallError();
        }
        const readable = yield* archive.streamEntry(entry);
        yield* EffectNodeStream.fromReadable<Uint8Array, ManagedInstallError>({
          evaluate: () => readable,
          onError: () => new ManagedInstallError(),
        }).pipe(Stream.run(fileSystem.sink(destination, { flag: "wx", mode: 0o700 })));
      }),
    ).pipe(Effect.mapError(() => new ManagedInstallError()));

const decodeField = (header: Uint8Array, start: number, length: number) => {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
};

/** The data of an uncompressed tar holding exactly one regular file named `name`, else null. */
const singleTarEntry = (tar: Uint8Array, name: string): Uint8Array | null => {
  if (tar.byteLength < 2 * TAR_BLOCK) return null;
  const header = tar.subarray(0, TAR_BLOCK);
  const size = decodeField(header, 124, 12).trim();
  const type = header[156];
  if (
    decodeField(header, 257, 5) !== "ustar" ||
    decodeField(header, 0, 100) !== name ||
    decodeField(header, 345, 155) !== "" ||
    (type !== 0x30 && type !== 0) ||
    !/^[0-7]{1,11}$/.test(size)
  ) {
    return null;
  }
  const end = TAR_BLOCK + Number.parseInt(size, 8);
  if (end > tar.byteLength) return null;
  // One entry: everything after its data is padding and the end-of-archive blocks.
  for (let index = end; index < tar.byteLength; index += 1) {
    if (tar[index] !== 0) return null;
  }
  return tar.subarray(TAR_BLOCK, end);
};

/** A gzipped tar holding exactly one regular file named `name`; anything else is refused. */
export const singleFileTarGz =
  (name: string): ExtractExecutable =>
  (archivePath, destination) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const compressed = yield* fileSystem.readFile(archivePath);
      const tar = yield* Effect.callback<Uint8Array, ManagedInstallError>((resume) => {
        NodeZlib.gunzip(compressed, { maxOutputLength: MAX_UNPACKED_BYTES }, (error, result) =>
          resume(error ? Effect.fail(new ManagedInstallError()) : Effect.succeed(result)),
        );
      });
      const entry = singleTarEntry(tar, name);
      if (entry === null) return yield* new ManagedInstallError();
      yield* fileSystem.writeFile(destination, entry, { flag: "wx", mode: 0o700 });
    }).pipe(Effect.mapError(() => new ManagedInstallError()));

/** Streams the pinned archive to disk, checking its size and digest as it arrives. */
const download = Effect.fn("ManagedBinary.download")(function* (
  release: PinnedRelease,
  archivePath: string,
) {
  const http = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const response = yield* http
    .execute(HttpClientRequest.get(release.url))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const hash = NodeCrypto.createHash("sha256");
  let received = 0;
  yield* response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.gen(function* () {
        received += chunk.byteLength;
        if (received > release.bytes) return yield* new ManagedInstallError();
        hash.update(chunk);
      }),
    ),
    Stream.run(fileSystem.sink(archivePath, { flag: "wx", mode: 0o600 })),
  );
  if (received !== release.bytes || hash.digest("hex") !== release.sha256) {
    return yield* new ManagedInstallError();
  }
});

/**
 * Installs `release` at `target`: downloads and verifies it, extracts the
 * executable beside `target`, and swaps it in only once it reports the pinned
 * version.
 */
export const installPinnedRelease = Effect.fn("ManagedBinary.install")(function* (options: {
  readonly release: PinnedRelease;
  readonly target: string;
  readonly extract: ExtractExecutable;
  /** The version `executable` reports, or null when it doesn't run. */
  readonly probeVersion: (executable: string) => Effect.Effect<string | null>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(options.target);
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectoryScoped({ directory, prefix: ".install-" });
      const archivePath = path.join(staging, "archive");
      const extracted = path.join(staging, path.basename(options.target));
      yield* download(options.release, archivePath);
      yield* options.extract(archivePath, extracted);
      yield* fileSystem.chmod(extracted, 0o755);
      // A binary that runs and reports the pinned version, not just the right bytes.
      if ((yield* options.probeVersion(extracted)) !== options.release.version) {
        return yield* new ManagedInstallError();
      }
      // Same directory, so the swap is atomic and a running copy keeps its inode.
      yield* fileSystem.rename(extracted, options.target);
    }),
  ).pipe(
    Effect.timeout(INSTALL_TIMEOUT),
    Effect.catchDefect(() => Effect.fail(new ManagedInstallError())),
    Effect.mapError(() => new ManagedInstallError()),
  );
});
