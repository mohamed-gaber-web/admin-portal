/** A slice of a larger collection, plus what the caller needs to ask for more. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query parameters every list screen supports. */
export interface PageQuery {
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  direction?: SortDirection;
}

export type SortDirection = "asc" | "desc";

export const DEFAULT_PAGE_SIZE = 10;

export function emptyPage<T>(pageSize = DEFAULT_PAGE_SIZE): Page<T> {
  return { items: [], total: 0, page: 1, pageSize };
}

/**
 * The three states any remote read can be in, plus the data.
 *
 * Modelled as one object rather than three loose signals because `loading` and
 * `error` and `data` are not independent — the combinations "loading with an
 * error" and "loaded with neither data nor error" are not reachable states, and
 * separate signals would let a template render them.
 */
export interface Async<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
}

export const asyncIdle = <T>(): Async<T> => ({
  status: "idle",
  data: null,
  error: null
});

export const asyncLoading = <T>(previous?: T | null): Async<T> => ({
  status: "loading",
  // Keep the previous page visible while the next one loads, so paginating
  // does not blank the table on every click.
  data: previous ?? null,
  error: null
});

export const asyncSuccess = <T>(data: T): Async<T> => ({
  status: "success",
  data,
  error: null
});

export const asyncError = <T>(error: string): Async<T> => ({
  status: "error",
  data: null,
  error
});
