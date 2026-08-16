import { z } from "zod";

/**
 * The envelope every list endpoint answers with.
 *
 * `total` is the count *before* paging, not the length of `items` — without it
 * a client cannot render "page 3 of 9" or decide whether a next page exists,
 * and would have to discover the end by requesting past it.
 *
 * A function rather than a generic interface because Zod schemas compose at
 * runtime: `pageSchema(userSummarySchema)` builds a validator for that exact
 * page, so a list endpoint returning the wrong element type fails at the
 * boundary rather than three components away.
 */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      pageSize: z.number().int().positive()
    })
    .strict();
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export const sortDirectionSchema = z.enum(SORT_DIRECTIONS);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Largest page a caller may ask for.
 *
 * Not a formality: `pageSize` reaches a LIMIT clause, so without a ceiling any
 * caller can ask one query to materialise every row in the table.
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 10;

/**
 * Query parameters shared by every list endpoint.
 *
 * Coerced, because these arrive as strings on a query string — `?page=2` is
 * the text "2", and a schema demanding a number would reject every real
 * request. `catch` supplies the default when a value is absent *or*
 * unparseable: a hand-typed `?page=abc` should show the first page, not a 400.
 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).catch(DEFAULT_PAGE_SIZE),
  search: z.string().trim().max(200).optional(),
  sort: z.string().max(50).optional(),
  direction: sortDirectionSchema.catch("asc")
});

export type PageQuery = z.infer<typeof pageQuerySchema>;
