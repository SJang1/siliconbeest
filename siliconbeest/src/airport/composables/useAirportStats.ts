import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useAsyncData, useRequestFetch } from '#imports';

/** Mirror of the response shape of GET /api/airport. */
export interface AirportStats {
	window: '24h';
	generatedAt: string;
	flights: {
		departures: number;
		arrivals: number;
		transfers: number;
	};
	cargo: {
		outCount: number;
		outBytes: number;
		inCount: number;
	};
	passport: {
		registrations: number;
	};
	dlq: {
		parked: number;
	};
	destinations: Array<{
		domain: string;
		arrivals: number;
		delayed: boolean;
	}>;
	delayedRoutes: Array<{
		domain: string;
		failureCount: number;
		lastFailedAt: string | null;
	}>;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * SSR-friendly stats source for the /airport page.
 * Fetches once on the server, then polls every 60s on the client
 * (skipping while the tab is hidden). On a failed refresh the last good
 * data is kept so the scene never disappears — only a notice is shown.
 */
export async function useAirportStats() {
	const requestFetch = useRequestFetch();
	const fetchFailed = ref(false);
	const lastGood = ref<AirportStats | null>(null);

	const asyncData = await useAsyncData<AirportStats | null>(
		'airport-stats',
		async () => {
			try {
				const stats = await requestFetch<AirportStats>('/api/airport');
				lastGood.value = stats;
				fetchFailed.value = false;
				return stats;
			} catch {
				fetchFailed.value = true;
				return lastGood.value;
			}
		},
		{ default: () => null },
	);

	let timer: ReturnType<typeof setInterval> | undefined;
	onMounted(() => {
		timer = setInterval(() => {
			if (!document.hidden) void asyncData.refresh();
		}, POLL_INTERVAL_MS);
	});
	onBeforeUnmount(() => {
		if (timer) clearInterval(timer);
	});

	return { stats: asyncData.data, fetchFailed, refresh: asyncData.refresh };
}
