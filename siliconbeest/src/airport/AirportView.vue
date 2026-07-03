<script setup lang="ts">
/**
 * /airport — the Fediverse Airport page, implementing the approved
 * Claude Design component (Fediverse Airport.dc.html) against the real
 * GET /api/airport numbers. Light daylight palette by design, in every
 * app theme. Hovering a facility or a sky beacon swaps the info card.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useHead, useRuntimeConfig } from '#imports';
import AirportScene from './components/AirportScene.vue';
import { useAirportStats } from './composables/useAirportStats';
import { formatBytes, type Beacon } from './lib/layout';

const { t } = useI18n();
const config = useRuntimeConfig();
const { stats, fetchFailed, refresh } = await useAirportStats();

const instanceTitle = computed(() => (config.public.instanceTitle as string) || 'SiliconBeest');

// Live clock — SSR renders the API timestamp; the client starts ticking
// after mount, so hydration never sees a mismatched time string.
const clockNow = ref<number | null>(null);
let clockTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	clockNow.value = Date.now();
	clockTimer = setInterval(() => {
		clockNow.value = Date.now();
	}, 1000);
	if (!stats.value) void refresh();
});
onBeforeUnmount(() => {
	if (clockTimer) clearInterval(clockTimer);
});
const clock = computed(() => {
	if (clockNow.value != null) {
		const d = new Date(clockNow.value);
		const p2 = (n: number) => String(n).padStart(2, '0');
		return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
	}
	return stats.value ? `${stats.value.generatedAt.slice(11, 16)} UTC` : '—';
});

const statusLabel = computed(() => {
	if (fetchFailed.value) return t('airport.status.lastKnown');
	return stats.value ? t('airport.status.live') : t('airport.status.connecting');
});

const vm = computed(() => {
	const s = stats.value;
	const departures = s?.flights.departures ?? 0;
	const arrivals = s?.flights.arrivals ?? 0;
	const movements = departures + arrivals;
	const dlq = s?.dlq.parked ?? 0;
	return {
		departures,
		arrivals,
		transfers: s?.flights.transfers ?? 0,
		passports: s?.passport.registrations ?? 0,
		cargoOutBytes: formatBytes(s?.cargo.outBytes ?? 0),
		cargoOutCount: s?.cargo.outCount ?? 0,
		cargoInBytes: formatBytes(s?.cargo.inBytes ?? 0),
		cargoInCount: s?.cargo.inCount ?? 0,
		movements,
		announceN: movements,
		dlq,
	};
});

type Selection = { kind: 'term'; term: string } | { kind: 'star'; beacon: Beacon } | null;
const selection = ref<Selection>(null);

const TERM_KEYS = [
	'cloudflare', 'checkin', 'security', 'passport', 'gate', 'immigration', 'baggage',
	'exit', 'cargo', 'announce', 'tower', 'dlq', 'deprwy', 'arrrwy',
] as const;

const info = computed(() => {
	const v = vm.value;
	const params = {
		name: instanceTitle.value,
		departures: v.departures,
		arrivals: v.arrivals,
		movements: v.movements,
		announceN: v.announceN,
		cargoIn: v.cargoInBytes,
		cargoOut: v.cargoOutBytes,
		dlq: v.dlq,
	};
	const sel = selection.value;
	if (sel?.kind === 'star') {
		return {
			title: sel.beacon.label,
			body: t('airport.info.beaconBody'),
			stat: t('airport.info.beaconStat', { count: sel.beacon.arrivals }),
		};
	}
	if (sel?.kind === 'term' && (TERM_KEYS as readonly string[]).includes(sel.term)) {
		const base = `airport.info.${sel.term}`;
		let stat = t(`${base}.stat`, params);
		if (sel.term === 'dlq') {
			stat = v.dlq > 0 ? t('airport.info.dlq.statWaiting', params) : t('airport.info.dlq.statEmpty');
		}
		return { title: t(`${base}.title`), body: t(`${base}.body`, params), stat };
	}
	return {
		title: t('airport.info.default.title', params),
		body: t('airport.info.default.body'),
		stat: t('airport.info.default.stat'),
	};
});

const storyKeys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] as const;

type OpsTone = 'ok' | 'quiet' | 'warn' | 'alert' | 'good';

interface OpsItem {
	key: string;
	title: string;
	status: string;
	tone: OpsTone;
	desc: string;
	routes?: Array<{ domain: string; failureCount: number }>;
}

// The per-facility operations board: one entry per real pipeline component,
// each with a status chip and a sentence that weaves in the real numbers.
const opsItems = computed<OpsItem[]>(() => {
	const s = stats.value;
	if (!s) return [];
	const v = vm.value;
	const delayed = s.delayedRoutes;
	return [
		{
			key: 'gate',
			title: t('airport.ops.gate.title'),
			status: t('airport.ops.gate.status'),
			tone: 'ok',
			desc: t('airport.ops.gate.desc', { title: instanceTitle.value, departures: v.departures }),
		},
		{
			key: 'federation',
			title: t('airport.ops.federation.title'),
			status: delayed.length
				? t('airport.ops.federation.statusDelayed')
				: t('airport.ops.federation.statusOk'),
			tone: delayed.length ? 'warn' : 'ok',
			desc: t('airport.ops.federation.desc', {
				arrivals: v.arrivals,
				destinations: s.destinations.length,
			}),
			routes: delayed,
		},
		{
			key: 'transfer',
			title: t('airport.ops.transfer.title'),
			status: t('airport.ops.transfer.status'),
			tone: v.transfers > 0 ? 'ok' : 'quiet',
			desc: t('airport.ops.transfer.desc', { transfers: v.transfers }),
		},
		{
			key: 'cargo',
			title: t('airport.ops.cargo.title'),
			status: t('airport.ops.cargo.status'),
			tone: 'ok',
			desc: t('airport.ops.cargo.desc', {
				out: v.cargoOutCount,
				bytes: v.cargoOutBytes,
				in: v.cargoInCount,
			}),
		},
		{
			key: 'passport',
			title: t('airport.ops.passport.title'),
			status: t('airport.ops.passport.status'),
			tone: v.passports > 0 ? 'ok' : 'quiet',
			desc: t('airport.ops.passport.desc', { count: v.passports }),
		},
		{
			key: 'tower',
			title: t('airport.ops.tower.title'),
			status: t('airport.ops.tower.status'),
			tone: 'ok',
			desc: t('airport.ops.tower.desc', { total: v.announceN }),
		},
		{
			key: 'dlq',
			title: t('airport.ops.dlq.title'),
			status:
				v.dlq === 0
					? t('airport.ops.dlq.statusEmpty')
					: t('airport.ops.dlq.statusParked', { count: v.dlq }),
			tone: v.dlq === 0 ? 'good' : 'alert',
			desc:
				v.dlq === 0
					? t('airport.ops.dlq.emptyDesc')
					: t('airport.ops.dlq.parkedDesc', { count: v.dlq }),
		},
	];
});

useHead({
	title: computed(() => t('airport.pageTitle', { name: instanceTitle.value })),
	link: [
		{ rel: 'preconnect', href: 'https://fonts.googleapis.com' },
		{ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
		{
			rel: 'stylesheet',
			href: 'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap',
		},
	],
});
</script>

<template>
	<div class="apx-page">
		<div class="apx-shell">
			<header class="apx-header">
				<h1 class="apx-title">{{ t('airport.title', { name: instanceTitle }) }}</h1>
				<p class="apx-subtitle">{{ t('airport.subtitle') }}</p>
				<div class="apx-clock">
					<span class="apx-clock-dot" />{{ t('airport.asOf', { time: clock }) }} · {{ statusLabel }}
				</div>
			</header>

			<div class="apx-stage">
				<div class="apx-infocard" aria-live="polite">
					<div class="apx-infocard-title">{{ info.title }}</div>
					<div class="apx-infocard-body">{{ info.body }}</div>
					<div class="apx-infocard-stat">{{ info.stat }}</div>
				</div>
				<div class="apx-scene-scroll">
					<AirportScene :stats="stats" @select="selection = $event" />
				</div>
			</div>

			<div class="apx-cards">
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.departures') }}</div>
					<div class="apx-card-value">{{ vm.departures }}</div>
				</div>
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.arrivals') }}</div>
					<div class="apx-card-value">{{ vm.arrivals }}</div>
				</div>
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.transfers') }}</div>
					<div class="apx-card-value">{{ vm.transfers }}</div>
				</div>
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.cargoOut') }}</div>
					<div class="apx-card-value apx-card-cargo">{{ vm.cargoOutBytes }}</div>
					<div class="apx-card-sub">{{ t('airport.cards.items', { count: vm.cargoOutCount }) }}</div>
				</div>
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.cargoIn') }}</div>
					<div class="apx-card-value apx-card-cargo">{{ vm.cargoInBytes }}</div>
					<div class="apx-card-sub">{{ t('airport.cards.items', { count: vm.cargoInCount }) }}</div>
				</div>
				<div class="apx-card">
					<div class="apx-card-label">{{ t('airport.cards.passports') }}</div>
					<div class="apx-card-value">{{ vm.passports }}</div>
				</div>
			</div>

			<!-- operations board: per-facility status + description -->
			<section v-if="opsItems.length" class="apx-ops">
				<div class="apx-ops-head">
					<h2 class="apx-ops-title">{{ t('airport.ops.title') }}</h2>
					<span class="apx-ops-time">{{ t('airport.asOf', { time: clock }) }}</span>
				</div>
				<ul class="apx-ops-list">
					<li v-for="item in opsItems" :key="item.key" class="apx-ops-item">
						<div class="apx-ops-row">
							<h3 class="apx-ops-name">{{ item.title }}</h3>
							<span class="apx-chip" :class="`apx-chip-${item.tone}`">{{ item.status }}</span>
						</div>
						<p class="apx-ops-desc">{{ item.desc }}</p>
						<div v-if="item.routes?.length" class="apx-ops-routes">
							<p class="apx-ops-note">{{ t('airport.ops.federation.delayedNote') }}</p>
							<ul>
								<li v-for="route in item.routes" :key="route.domain" class="apx-ops-route">
									<span class="apx-ops-domain">{{ route.domain }}</span>
									<span class="apx-ops-fail">{{ t('airport.ops.federation.failures', { count: route.failureCount }) }}</span>
								</li>
							</ul>
						</div>
					</li>
				</ul>
			</section>

			<section class="apx-story">
				<h2 class="apx-story-title">{{ t('airport.story.title') }}</h2>
				<div class="apx-story-cols">
					<p v-for="key in storyKeys" :key="key" class="apx-story-p">
						<b>{{ t(`airport.story.${key}.lead`) }}</b>
						{{ t(`airport.story.${key}.body`) }}
					</p>
				</div>
			</section>
		</div>
	</div>
</template>

<style scoped>
.apx-page {
	min-height: 100vh;
	background: #eef1ec;
	color: #2b3648;
	font-family: 'Hanken Grotesk', system-ui, sans-serif;
	-webkit-font-smoothing: antialiased;
}

.apx-shell {
	max-width: 1500px;
	margin: 0 auto;
	padding: 26px 22px 56px;
}

.apx-header {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 16px 22px;
	margin-bottom: 16px;
}

.apx-title {
	font-size: 27px;
	font-weight: 800;
	letter-spacing: -0.02em;
	margin: 0;
	white-space: nowrap;
}

.apx-subtitle {
	margin: 0;
	font-size: 14.5px;
	line-height: 1.4;
	color: #64748b;
	flex: 1;
	min-width: 280px;
}

.apx-clock {
	display: flex;
	align-items: center;
	gap: 9px;
	font-family: 'Spline Sans Mono', ui-monospace, monospace;
	font-size: 12px;
	color: #64748b;
	white-space: nowrap;
}

.apx-clock-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #5b54e8;
	display: inline-block;
}

.apx-stage {
	position: relative;
	border-radius: 18px;
	overflow: hidden;
	box-shadow:
		0 1px 2px rgba(43, 54, 72, 0.08),
		0 12px 34px -18px rgba(43, 54, 72, 0.35);
}

.apx-infocard {
	position: absolute;
	top: 16px;
	left: 16px;
	width: 252px;
	max-width: 46%;
	background: rgba(255, 255, 255, 0.85);
	backdrop-filter: blur(8px);
	border: 1px solid rgba(43, 54, 72, 0.12);
	border-radius: 13px;
	padding: 12px 14px;
	z-index: 3;
	pointer-events: none;
	box-shadow: 0 6px 20px -12px rgba(43, 54, 72, 0.5);
}

.apx-infocard-title {
	font-size: 14px;
	font-weight: 700;
	letter-spacing: -0.01em;
	margin-bottom: 4px;
}

.apx-infocard-body {
	font-size: 12.5px;
	line-height: 1.45;
	color: #64748b;
}

.apx-infocard-stat {
	margin-top: 8px;
	display: inline-block;
	font-family: 'Spline Sans Mono', ui-monospace, monospace;
	font-size: 11px;
	color: #5b54e8;
	background: rgba(91, 84, 232, 0.1);
	border-radius: 20px;
	padding: 3px 10px;
}

.apx-scene-scroll {
	overflow-x: auto;
}

.apx-scene-scroll > :deep(svg) {
	min-width: 900px;
}

.apx-cards {
	display: grid;
	grid-template-columns: repeat(6, 1fr);
	gap: 14px;
	margin-top: 18px;
}

@media (max-width: 1080px) {
	.apx-cards {
		grid-template-columns: repeat(3, 1fr);
	}
}

@media (max-width: 560px) {
	.apx-cards {
		grid-template-columns: repeat(2, 1fr);
	}
}

.apx-card {
	background: #fcfdfe;
	border: 1px solid #d9dfe7;
	border-radius: 13px;
	padding: 14px 16px;
}

.apx-card-label {
	font-family: 'Spline Sans Mono', ui-monospace, monospace;
	font-size: 11px;
	letter-spacing: 0.12em;
	color: #64748b;
	margin-bottom: 6px;
	text-transform: uppercase;
}

.apx-card-value {
	font-size: 30px;
	font-weight: 800;
	letter-spacing: -0.02em;
}

.apx-card-cargo {
	color: #7c3aed;
}

.apx-card-sub {
	margin-top: 2px;
	font-size: 12px;
	color: #94a3b8;
}

.apx-ops {
	margin-top: 18px;
	background: #fcfdfe;
	border: 1px solid #d9dfe7;
	border-radius: 13px;
	padding: 16px 18px;
}

.apx-ops-head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 8px;
}

.apx-ops-title {
	font-size: 16px;
	font-weight: 800;
	letter-spacing: -0.01em;
	margin: 0;
}

.apx-ops-time {
	font-family: 'Spline Sans Mono', ui-monospace, monospace;
	font-size: 11px;
	color: #94a3b8;
}

.apx-ops-list {
	list-style: none;
	margin: 6px 0 0;
	padding: 0;
}

.apx-ops-item {
	padding: 11px 0;
	border-top: 1px solid #edf0f4;
}

.apx-ops-item:first-child {
	border-top: none;
}

.apx-ops-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.apx-ops-name {
	font-size: 14px;
	font-weight: 700;
	margin: 0;
}

.apx-chip {
	border: 1px solid;
	border-radius: 20px;
	padding: 1.5px 9px;
	font-size: 11px;
	font-weight: 600;
}

.apx-chip-ok,
.apx-chip-good {
	border-color: #a7dcc3;
	color: #047857;
	background: rgba(31, 169, 113, 0.06);
}

.apx-chip-quiet {
	border-color: #cbd5e1;
	color: #64748b;
	background: rgba(100, 116, 139, 0.05);
}

.apx-chip-warn {
	border-color: #f2d38c;
	color: #b45309;
	background: rgba(232, 185, 58, 0.08);
}

.apx-chip-alert {
	border-color: #f0b2ac;
	color: #b23a31;
	background: rgba(224, 69, 58, 0.06);
}

.apx-ops-desc {
	margin: 5px 0 0;
	font-size: 13.5px;
	line-height: 1.55;
	color: #64748b;
}

.apx-ops-routes {
	margin-top: 7px;
}

.apx-ops-note {
	margin: 0;
	font-size: 12px;
	color: #94a3b8;
}

.apx-ops-routes ul {
	list-style: none;
	margin: 4px 0 0;
	padding: 0;
}

.apx-ops-route {
	display: flex;
	align-items: baseline;
	gap: 8px;
	font-size: 13px;
}

.apx-ops-domain {
	font-weight: 600;
	color: #b23a31;
}

.apx-ops-fail {
	font-size: 12px;
	color: #94a3b8;
}

.apx-story {
	margin-top: 34px;
	border-top: 1.5px solid #cbd4df;
	padding-top: 16px;
}

.apx-story-title {
	font-size: 19px;
	font-weight: 800;
	letter-spacing: -0.01em;
	margin: 0 0 14px;
}

.apx-story-cols {
	columns: 3;
	column-gap: 40px;
	font-size: 14px;
	line-height: 1.6;
	color: #3d4657;
}

@media (max-width: 1080px) {
	.apx-story-cols {
		columns: 2;
	}
}

@media (max-width: 700px) {
	.apx-story-cols {
		columns: 1;
	}
}

.apx-story-p {
	margin: 0 0 13px;
	break-inside: avoid;
}
</style>
