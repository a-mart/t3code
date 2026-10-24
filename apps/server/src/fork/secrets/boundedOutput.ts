import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface BoundedOutput {
  readonly bytes: Uint8Array;
  /** The stream produced more than the limit; `bytes` holds only what fit. */
  readonly overflow: boolean;
}

/**
 * Keeps reading past the limit so the writer never blocks on a full pipe,
 * but retains only the first `maxBytes`.
 */
export const collectBounded = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
): Effect.Effect<BoundedOutput, E, R> =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, size: 0, overflow: false }),
      (state, chunk) => {
        if (state.overflow) return state;
        if (state.size + chunk.byteLength > maxBytes) {
          state.overflow = true;
          return state;
        }
        state.chunks.push(chunk);
        state.size += chunk.byteLength;
        return state;
      },
    ),
    Effect.map((state) => ({
      bytes: Buffer.concat(state.chunks, state.size),
      overflow: state.overflow,
    })),
  );
