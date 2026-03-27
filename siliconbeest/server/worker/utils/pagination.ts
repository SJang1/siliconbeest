/**
 * Mastodon-compatible cursor-based pagination utilities.
 */

export interface PaginationParams {
	maxId?: string;
	sinceId?: string;
	minId?: string;
	limit: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

/**
 * Parse raw pagination query parameters into a typed PaginationParams object.
 */
export function parsePaginationParams(params: {
	max_id?: string;
	since_id?: string;
	min_id?: string;
	limit?: string;
}): PaginationParams {
	let limit = DEFAULT_LIMIT;

	if (params.limit) {
		const parsed = parseInt(params.limit, 10);
		if (!isNaN(parsed) && parsed > 0) {
			limit = Math.min(parsed, MAX_LIMIT);
		}
	}

	return {
		maxId: params.max_id || undefined,
		sinceId: params.since_id || undefined,
		minId: params.min_id || undefined,
		limit,
	};
}

/**
 * Build SQL WHERE/ORDER/LIMIT clauses for cursor-based pagination.
 *
 * @param params - Parsed pagination parameters.
 * @param idColumn - The column name used for pagination (default: "id").
 * @returns Object containing whereClause, orderClause, limitValue, and bound params.
 */
export function buildPaginationQuery(
	params: PaginationParams,
	idColumn: string = 'id'
): {
	whereClause: string;
	orderClause: string;
	limitValue: number;
	params: string[];
} {
	const conditions: string[] = [];
	const boundParams: string[] = [];

	if (params.maxId) {
		conditions.push(`${idColumn} < ?`);
		boundParams.push(params.maxId);
	}

	if (params.sinceId) {
		conditions.push(`${idColumn} > ?`);
		boundParams.push(params.sinceId);
	}

	if (params.minId) {
		conditions.push(`${idColumn} > ?`);
		boundParams.push(params.minId);
	}

	const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '';

	// When using min_id, order ascending to get items just above the cursor,
	// then the caller should reverse the results for display.
	const orderClause = params.minId ? `${idColumn} ASC` : `${idColumn} DESC`;

	return {
		whereClause,
		orderClause,
		limitValue: params.limit,
		params: boundParams,
	};
}

/**
 * Build an RFC 8288 Link header for pagination.
 *
 * @param baseUrl - The base URL of the endpoint (e.g., "https://example.com/api/v1/timelines/home").
 * @param items - The array of items returned, each with an `id` property.
 * @param limit - The page size limit.
 * @returns A Link header string with rel=next and rel=prev, or empty string if no items.
 */
export function buildLinkHeader(baseUrl: string, items: { id: string }[], limit: number): string {
	if (items.length === 0) {
		return '';
	}

	const links: string[] = [];
	const lastItem = items[items.length - 1];
	const firstItem = items[0];

	if (lastItem) {
		links.push(`<${baseUrl}?max_id=${lastItem.id}&limit=${limit}>; rel="next"`);
	}

	if (firstItem) {
		links.push(`<${baseUrl}?min_id=${firstItem.id}&limit=${limit}>; rel="prev"`);
	}

	return links.join(', ');
}
