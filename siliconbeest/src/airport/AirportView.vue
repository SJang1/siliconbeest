<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useHead, useRuntimeConfig } from '#imports';
import AirportScene from './components/AirportScene.vue';
import { useAirportStats } from './composables/useAirportStats';
import { formatBytes } from './lib/layout';

const { t } = useI18n();
const config = useRuntimeConfig();
const { stats, fetchFailed } = await useAirportStats();

const instanceTitle = computed(() => (config.public.instanceTitle as string) || 'SiliconBeest');

const showError = computed(() => fetchFailed.value || !stats.value);

// Deterministic HH:MM UTC — avoids the SSR/client timezone hydration trap
// that toLocaleTimeString would cause.
const updatedAt = computed(() =>
	stats.value ? `${stats.value.generatedAt.slice(11, 16)} UTC` : '',
);

const boardItems = computed(() => {
	const s = stats.value;
	return [
		{ key: 'departures', label: t('airport.board.departures'), value: s?.flights.departures },
		{ key: 'arrivals', label: t('airport.board.arrivals'), value: s?.flights.arrivals },
		{ key: 'transfers', label: t('airport.board.transfers'), value: s?.flights.transfers },
		{
			key: 'cargoOut',
			label: t('airport.board.cargoOut'),
			value: s?.cargo.outCount,
			extra: s ? formatBytes(s.cargo.outBytes) : undefined,
		},
		{ key: 'cargoIn', label: t('airport.board.cargoIn'), value: s?.cargo.inCount },
		{ key: 'registrations', label: t('airport.board.registrations'), value: s?.passport.registrations },
	];
});

type OpsTone = 'ok' | 'quiet' | 'warn' | 'alert' | 'good';

interface OpsItem {
	key: string;
	title: string;
	status: string;
	tone: OpsTone;
	desc: string;
	routes?: Array<{ domain: string; failureCount: number }>;
}

// The sukhi-style operations board: one entry per real facility, each with a
// status chip and a sentence that weaves in the real numbers.
const opsItems = computed<OpsItem[]>(() => {
	const s = stats.value;
	if (!s) return [];
	const delayed = s.delayedRoutes;
	return [
		{
			key: 'gate',
			title: t('airport.ops.gate.title'),
			status: t('airport.ops.gate.status'),
			tone: 'ok',
			desc: t('airport.ops.gate.desc', {
				title: instanceTitle.value,
				departures: s.flights.departures,
			}),
		},
		{
			key: 'federation',
			title: t('airport.ops.federation.title'),
			status: delayed.length
				? t('airport.ops.federation.statusDelayed')
				: t('airport.ops.federation.statusOk'),
			tone: delayed.length ? 'warn' : 'ok',
			desc: t('airport.ops.federation.desc', {
				arrivals: s.flights.arrivals,
				destinations: s.destinations.length,
			}),
			routes: delayed,
		},
		{
			key: 'transfer',
			title: t('airport.ops.transfer.title'),
			status: t('airport.ops.transfer.status'),
			tone: s.flights.transfers > 0 ? 'ok' : 'quiet',
			desc: t('airport.ops.transfer.desc', { transfers: s.flights.transfers }),
		},
		{
			key: 'cargo',
			title: t('airport.ops.cargo.title'),
			status: t('airport.ops.cargo.status'),
			tone: 'ok',
			desc: t('airport.ops.cargo.desc', {
				out: s.cargo.outCount,
				bytes: formatBytes(s.cargo.outBytes),
				in: s.cargo.inCount,
			}),
		},
		{
			key: 'passport',
			title: t('airport.ops.passport.title'),
			status: t('airport.ops.passport.status'),
			tone: s.passport.registrations > 0 ? 'ok' : 'quiet',
			desc: t('airport.ops.passport.desc', { count: s.passport.registrations }),
		},
		{
			key: 'tower',
			title: t('airport.ops.tower.title'),
			status: t('airport.ops.tower.status'),
			tone: 'ok',
			desc: t('airport.ops.tower.desc', {
				total: s.flights.departures + s.flights.arrivals,
			}),
		},
		{
			key: 'dlq',
			title: t('airport.ops.dlq.title'),
			status:
				s.dlq.parked === 0
					? t('airport.ops.dlq.statusEmpty')
					: t('airport.ops.dlq.statusParked', { count: s.dlq.parked }),
			tone: s.dlq.parked === 0 ? 'good' : 'alert',
			desc:
				s.dlq.parked === 0
					? t('airport.ops.dlq.emptyDesc')
					: t('airport.ops.dlq.parkedDesc', { count: s.dlq.parked }),
		},
	];
});

const TONE_CLASSES: Record<OpsTone, string> = {
	ok: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400',
	good: 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400',
	quiet: 'border-slate-300 text-slate-500 dark:border-slate-600 dark:text-slate-400',
	warn: 'border-amber-300 text-amber-700 dark:border-amber-600 dark:text-amber-400',
	alert: 'border-red-300 text-red-700 dark:border-red-700 dark:text-red-400',
};

useHead({ title: computed(() => t('airport.pageTitle')) });
</script>

<template>
	<div class="min-h-dvh bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-200">
		<header class="mx-auto flex w-full max-w-6xl flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pb-2 pt-6">
			<h1 class="text-2xl font-bold">{{ t('airport.title') }}</h1>
			<p class="text-sm text-slate-500 dark:text-slate-400">{{ t('airport.subtitle') }}</p>
			<span v-if="updatedAt" class="ml-auto text-xs text-slate-400 dark:text-slate-500">
				{{ t('airport.updatedAt', { time: updatedAt }) }}
			</span>
			<NuxtLink to="/" class="text-xs text-indigo-500 hover:underline dark:text-indigo-400">
				{{ t('airport.backHome') }}
			</NuxtLink>
		</header>

		<!-- honest failure state: the notice appears, the landscape stays -->
		<div
			v-if="showError"
			class="mx-auto mb-2 w-full max-w-6xl px-4"
		>
			<p class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
				{{ t('airport.fetchError') }}
			</p>
		</div>

		<main class="mx-auto w-full max-w-6xl px-4 pb-10">
			<div class="overflow-x-auto rounded-2xl border border-slate-200 shadow-sm dark:border-slate-800">
				<div class="min-w-[900px]">
					<AirportScene :stats="stats" />
				</div>
			</div>

			<!-- info board -->
			<section class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				<div
					v-for="item in boardItems"
					:key="item.key"
					class="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
				>
					<dt class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
						{{ item.label }}
					</dt>
					<dd class="mt-1 text-xl font-semibold tabular-nums">
						{{ item.value ?? '–' }}
						<span v-if="item.extra" class="ml-1 text-xs font-normal text-slate-400">{{ item.extra }}</span>
					</dd>
				</div>
			</section>

			<!-- operations board: per-facility status + description -->
			<section
				v-if="opsItems.length"
				class="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 class="text-sm font-semibold">{{ t('airport.ops.title') }}</h2>
					<span v-if="updatedAt" class="text-xs text-slate-400 dark:text-slate-500">
						{{ t('airport.updatedAt', { time: updatedAt }) }}
					</span>
				</div>
				<ul class="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
					<li v-for="item in opsItems" :key="item.key" class="py-3">
						<div class="flex flex-wrap items-center gap-2">
							<h3 class="text-sm font-medium">{{ item.title }}</h3>
							<span
								class="rounded-full border px-2 py-0.5 text-[11px] font-medium"
								:class="TONE_CLASSES[item.tone]"
							>
								{{ item.status }}
							</span>
						</div>
						<p class="mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
							{{ item.desc }}
						</p>
						<div v-if="item.routes?.length" class="mt-2">
							<p class="text-xs text-slate-500 dark:text-slate-400">
								{{ t('airport.ops.federation.delayedNote') }}
							</p>
							<ul class="mt-1 space-y-0.5">
								<li
									v-for="route in item.routes"
									:key="route.domain"
									class="flex items-baseline gap-2 text-sm"
								>
									<span class="font-medium text-red-600 dark:text-red-400">{{ route.domain }}</span>
									<span class="text-xs text-slate-500 dark:text-slate-400">
										{{ t('airport.delays.failures', { count: route.failureCount }) }}
									</span>
								</li>
							</ul>
						</div>
					</li>
				</ul>
			</section>

			<p class="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
				{{ t('airport.honesty') }} · {{ t('airport.window24h') }}
			</p>
		</main>
	</div>
</template>
