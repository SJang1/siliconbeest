/**
 * Shared Cursor-Based Pagination Utility
 *
 * Provides a reusable pattern for cursor-based pagination used by
 * all collection dispatchers. Queries N+1 items and determines
 * if there's a next page.
 */

import { env } from 'cloudflare:workers';

export interface PaginatedResult<T> {
	items: T[];
	nextCursor: string | null;
}

/**
 * Execute a cursor-based paginated query.
 *
 * Fetches pageSize+1 rows from the database. If more rows are returned
 * than pageSize, there's a next page and the cursor is the ID of the
 * last item on the current page.
 *
 * @param db - D1 database instance
 * @param sql - SQL query with placeholder for cursor condition and LIMIT
 * @param binds - Query parameters (cursor and limit will be appended)
 * @param pageSize - Number of items per page
 * @param cursor - Current cursor value (empty string = first page)
 * @param cursorColumn - Column name for cursor-based filtering (default: 'id')
 * @param idExtractor - Function to extract the cursor ID from a row
 */
export async function paginateQuery<T>(
	options: {
		baseConditions: string[];
		baseBinds: (string | number)[];
		selectClause: string;
		fromClause: string;
		orderBy: string;
		pageSize: number;
		cursor: string | null;
		cursorColumn: string;
		idExtractor: (row: T) => string;
	},
): Promise<PaginatedResult<T>> {
	const conditions = [...options.baseConditions];
	const binds = [...options.baseBinds];

	if (options.cursor) {
		conditions.push(`${options.cursorColumn} < ?${binds.length + 1}`);
		binds.push(options.cursor);
	}

	const sql = `
		SELECT ${options.selectClause}
		FROM ${options.fromClause}
		WHERE ${conditions.join(' AND ')}
		ORDER BY ${options.orderBy}
		LIMIT ?${binds.length + 1}
	`;
	binds.push(options.pageSize + 1);

	const { results } = await env.DB
		.prepare(sql)
		.bind(...binds)
		.all<T>();

	const rows = results ?? [];
	const hasNext = rows.length > options.pageSize;
	const items = hasNext ? rows.slice(0, options.pageSize) : rows;

	const nextCursor = hasNext
		? options.idExtractor(items[items.length - 1])
		: null;

	return { items, nextCursor };
}
