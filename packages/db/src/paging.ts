/**
 * Paging shared by the administration list queries.
 *
 * Every list endpoint needs the same three things — a slice, the total before
 * slicing, and a sort the caller chose — and the third is the one that turns
 * into an injection if each query improvises it.
 */

export interface PageRequest {
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  direction?: "asc" | "desc";
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * A row carrying the pre-slice total, computed by `count(*) OVER ()`.
 *
 * One query rather than a SELECT plus a COUNT: two queries can disagree if a
 * row is inserted between them, which shows up as a page of results claiming a
 * total that cannot produce it.
 */
export interface RowWithTotal {
  total_count: string | number;
}

/**
 * Resolves a caller-supplied sort into a SQL fragment.
 *
 * The map is the whitelist, and the only reason this function exists: `sort`
 * arrives on a query string and reaches an ORDER BY clause, so it can never be
 * interpolated. An unknown key falls back to `fallback` rather than erroring —
 * a stale bookmark naming a column that has since been renamed should show the
 * list, not a 400.
 *
 * `direction` is mapped through a literal pair rather than interpolated for the
 * same reason, even though it is already constrained upstream. Two independent
 * guards on the one string that reaches SQL is the right number.
 */
export function orderByClause(
  request: PageRequest,
  columns: Record<string, string>,
  fallback: string
): string {
  const column = (request.sort && columns[request.sort]) || columns[fallback];
  const direction = request.direction === "desc" ? "DESC" : "ASC";
  // NULLS LAST in both directions: a null last-seen date means "never signed
  // in", which belongs at the end of the list whichever way it is sorted, not
  // at whichever end Postgres defaults to.
  return `ORDER BY ${column} ${direction} NULLS LAST`;
}

/** `LIMIT`/`OFFSET` values for a page request. */
export function limitOffset(request: PageRequest): { limit: number; offset: number } {
  return {
    limit: request.pageSize,
    offset: (request.page - 1) * request.pageSize
  };
}

/**
 * The `%term%` argument for a case-insensitive LIKE, or null for no filter.
 *
 * The wildcards are added here rather than in the SQL so that `%` and `_` typed
 * by a user are escaped first — without that, searching for "50%" matches
 * everything, which reads as a broken search box.
 */
export function likeArgument(search: string | undefined): string | null {
  const term = search?.trim();
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Wraps rows and their window-function total into the page envelope. */
export function toPage<Row extends RowWithTotal, T>(
  rows: Row[],
  request: PageRequest,
  map: (row: Row) => T
): PagedResult<T> {
  return {
    items: rows.map(map),
    // Zero rows means zero matches — there is no total to read off a row that
    // is not there.
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    page: request.page,
    pageSize: request.pageSize
  };
}
