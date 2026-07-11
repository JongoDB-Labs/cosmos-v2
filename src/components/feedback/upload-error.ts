/**
 * Turn a failed feedback-attachment upload into a specific, actionable message.
 *
 * The upload route (`…/feedback/attachments`) answers a non-2xx with a small
 * JSON body — `{ error, maxBytes?, contentType?, retryAfter? }` — where `error`
 * is a stable code (`too_large`, `unsupported_mime`, `missing_file`,
 * `rate_limited`, …). This maps status + code to a sentence the user can act on
 * instead of a blanket "Couldn't upload", and always folds the HTTP status into
 * the fallback so an otherwise-opaque failure (a 500, or an HTML error page from
 * nginx/Cloudflare) stays diagnosable from a screenshot of the toast.
 */

const SUPPORTED_TYPES = "PNG, JPG, GIF, WebP, or PDF";

export interface UploadErrorInfo {
  filename: string;
  /** HTTP status of the failed response. */
  status: number;
  /** The server's `error` code, when the body parsed as JSON; else null. */
  code?: string | null;
  /** Byte cap echoed by a 413 `too_large` response, when present. */
  maxBytes?: number | null;
}

/** "8 MB" for a round cap, "7.5 MB" otherwise. */
function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function describeUploadError({
  filename,
  status,
  code,
  maxBytes,
}: UploadErrorInfo): string {
  switch (code) {
    case "too_large":
      return maxBytes
        ? `${filename} is too large — screenshots must be under ${formatMb(maxBytes)}.`
        : `${filename} is too large to upload.`;
    case "unsupported_mime":
      return `${filename} isn't a supported file type. Use ${SUPPORTED_TYPES}.`;
    case "missing_file":
      return `Couldn't read ${filename}. Please choose the file again.`;
    case "rate_limited":
      return "You're uploading too quickly. Wait a moment, then try again.";
    default:
      break;
  }

  // No known code in the body — drive the message off the HTTP status alone.
  if (status === 401 || status === 403)
    return "Your session expired. Refresh the page and try again.";
  if (status === 413) return `${filename} is too large to upload.`;
  if (status === 415)
    return `${filename} isn't a supported file type. Use ${SUPPORTED_TYPES}.`;
  if (status === 429)
    return "You're uploading too quickly. Wait a moment, then try again.";

  // Anything else (500, or an opaque proxy error): stay honest and keep the
  // status code so the failure can be diagnosed later.
  return `Couldn't upload ${filename} (error ${status}).`;
}

/** Message for a request that never reached the server (offline, dropped, CORS). */
export function networkUploadError(filename: string): string {
  return `Couldn't upload ${filename} — check your connection and try again.`;
}
