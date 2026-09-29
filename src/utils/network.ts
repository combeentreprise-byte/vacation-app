// Whether a failed request is worth retrying later (no connection, server
// hiccup, expired token) as opposed to the server actually rejecting it
// (RLS, a `raise exception` in an RPC, a failed check constraint) — the
// difference between keeping a queued offline change for the next attempt
// and giving up on it.
//
// postgrest-js reports a request that never got a response (fetch threw) as
// status 0 rather than throwing.
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

// storage-js wraps a fetch that never got a response in StorageUnknownError,
// and anything the server actually answered in StorageApiError (with status).
export function isRetryableStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && error.name === "StorageUnknownError") return true;
  if ("status" in error && typeof error.status === "number") {
    return isRetryableStatus(error.status);
  }
  return false;
}

export const OFFLINE_MESSAGE = "You're offline. This needs an internet connection.";

// Replaces the raw "TypeError: Network request failed" a no-response failure
// comes back as with something readable.
export function requestErrorMessage(message: string, status: number): string {
  return status === 0 ? OFFLINE_MESSAGE : message;
}
