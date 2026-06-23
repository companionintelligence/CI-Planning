/**
 * A plain Error carrying an HTTP status. The app's top-level error middleware
 * (app.ts) already maps `err.status`/`err.message` onto the response, so throwing
 * one of these from anywhere in a handler yields the intended status + body.
 */
export interface HttpError extends Error {
  status: number;
  expose: boolean;
}

export function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  e.expose = true; // safe to surface — these are deliberate, non-sensitive messages
  return e;
}
