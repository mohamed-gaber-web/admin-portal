import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable, map } from "rxjs";
import { z } from "@growpath/contracts";
import { environment } from "@env";

/** Query values a caller may pass; `undefined` entries are dropped. */
export type QueryParams = Record<
  string,
  string | number | boolean | undefined | null
>;

/**
 * Fills the `:param` placeholders in a route template.
 *
 * The values are percent-encoded, which matters more than it looks: an id is
 * usually a uuid, but the same helper serves any route, and a value containing
 * `/` or `?` would otherwise silently change which endpoint is called.
 */
export function pathFor(template: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (path, [key, value]) => path.replace(`:${key}`, encodeURIComponent(value)),
    template
  );
}

/**
 * The single place the portal talks to the API.
 *
 * Two jobs beyond wrapping HttpClient. It owns the base URL, so no component
 * hard-codes a host. And it can parse a response through the Zod schema the API
 * declares in `@growpath/contracts` — the same object both sides validate
 * against — which turns a contract drift into a loud failure here rather than
 * an `undefined` surfacing three components away.
 */
@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);

  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.http.get<T>(this.url(path), { params: toParams(params) });
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.http.post<T>(this.url(path), body);
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body);
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(this.url(path), body);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path));
  }

  /** `get`, with the response held to a contract schema. */
  getValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: QueryParams
  ): Observable<T> {
    return this.get<unknown>(path, params).pipe(map((body) => parse(schema, body, path)));
  }

  /** `post`, with the response held to a contract schema. */
  postValidated<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
  ): Observable<T> {
    return this.post<unknown>(path, body).pipe(
      map((response) => parse(schema, response, path))
    );
  }

  /** `patch`, with the response held to a contract schema. */
  patchValidated<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
  ): Observable<T> {
    return this.patch<unknown>(path, body).pipe(
      map((response) => parse(schema, response, path))
    );
  }

  /** `put`, with the response held to a contract schema. */
  putValidated<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>
  ): Observable<T> {
    return this.put<unknown>(path, body).pipe(
      map((response) => parse(schema, response, path))
    );
  }

  private url(path: string): string {
    return `${environment.apiBaseUrl}${path}`;
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  // Deliberately noisy. A response that does not match the shared schema means
  // the API and the portal disagree about the contract, and the useful moment
  // to find that out is now — not when a template renders "undefined".
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Response from ${path} did not match its contract — ${detail}`);
}

function toParams(params?: QueryParams): HttpParams {
  let httpParams = new HttpParams();
  if (!params) return httpParams;

  for (const [key, value] of Object.entries(params)) {
    // Skipped rather than sent as "undefined", which is what String(undefined)
    // would put on the wire.
    if (value === undefined || value === null || value === "") continue;
    httpParams = httpParams.set(key, String(value));
  }
  return httpParams;
}
