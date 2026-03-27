/**
 * Performance Logging Utilities
 *
 * Provides helpers for tracking CPU time with performance.now() and logging
 * structured performance data to Cloudflare's observability dashboard.
 */

export interface PerfLog {
	event: 'perf';
	operation: string;
	durationMs: number;
	metadata?: Record<string, any>;
}

/**
 * Log a performance measurement in structured JSON format.
 * Cloudflare automatically captures console.log in the observability dashboard.
 */
export function logPerformance(
	operation: string,
	durationMs: number,
	metadata?: Record<string, any>,
): void {
	const log: PerfLog = {
		event: 'perf',
		operation,
		durationMs: Math.round(durationMs * 100) / 100, // Round to 2 decimals
		...(metadata && { metadata }),
	};
	console.log(JSON.stringify(log));
}

/**
 * Measure the CPU time of a synchronous or asynchronous operation.
 * Returns the result of the operation and logs the performance.
 */
export async function measureAsync<T>(
	operation: string,
	fn: () => Promise<T>,
	metadata?: Record<string, any>,
): Promise<T> {
	const start = performance.now();
	try {
		const result = await fn();
		const duration = performance.now() - start;
		logPerformance(operation, duration, metadata);
		return result;
	} catch (error) {
		const duration = performance.now() - start;
		logPerformance(operation, duration, {
			...metadata,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/**
 * Measure the CPU time of a synchronous operation.
 * Returns the result of the operation and logs the performance.
 */
export function measureSync<T>(
	operation: string,
	fn: () => T,
	metadata?: Record<string, any>,
): T {
	const start = performance.now();
	try {
		const result = fn();
		const duration = performance.now() - start;
		logPerformance(operation, duration, metadata);
		return result;
	} catch (error) {
		const duration = performance.now() - start;
		logPerformance(operation, duration, {
			...metadata,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/**
 * Create a performance timer that can be manually started and stopped.
 * Useful for measuring subsections of a function.
 */
export class PerfTimer {
	private startTime: number = 0;
	private operation: string;
	private metadata?: Record<string, any>;

	constructor(operation: string, metadata?: Record<string, any>) {
		this.operation = operation;
		this.metadata = metadata;
	}

	start(): void {
		this.startTime = performance.now();
	}

	stop(): number {
		const duration = performance.now() - this.startTime;
		logPerformance(this.operation, duration, this.metadata);
		return duration;
	}

	stopWithMetadata(additionalMetadata: Record<string, any>): number {
		const duration = performance.now() - this.startTime;
		logPerformance(this.operation, duration, {
			...this.metadata,
			...additionalMetadata,
		});
		return duration;
	}
}
