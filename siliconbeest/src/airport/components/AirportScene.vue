<script setup lang="ts">
/**
 * The airport landscape. Every path drawn here corresponds 1:1 to real
 * server wiring (see the mapping table in the /airport plan):
 *
 *   entrance road          Cloudflare custom-domain front door
 *   check-in counters      POST /api/v1/statuses (Hono API)
 *   passport desk          account registration
 *   security checkpoint    auth middleware + rate limit + Turnstile
 *   departure runway       QUEUE_FEDERATION → queue-consumer → remote inboxes
 *   arrival runway         /inbox (fedify) — remote statuses coming in
 *   immigration booth      HTTP signature verification on /inbox
 *   baggage carousel       remote media (media proxy cache)
 *   transfer corridor      local reblogs re-federated as Announce
 *   cargo belt + warehouse media uploads → R2 MEDIA_BUCKET
 *   control tower          STREAMING_DO WebSocket broadcast
 *
 * SMIL notes (learned the hard way in the reference article):
 *  - begin MUST be negative, or the vehicle sits at the SVG origin
 *    until its start time.
 *  - rotate="auto" heading follows the path's drawn direction; to go the
 *    other way, draw the path reversed — never keyPoints="1;0".
 *  - prefers-reduced-motion parks vehicles mid-path (keyPoints="x;x")
 *    instead of hiding them.
 *  - Chromium sometimes freezes SMIL inside late-inserted DOM; nudging
 *    svg.setCurrentTime(svg.getCurrentTime()) after mount wakes it up.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AirportStats } from '../composables/useAirportStats';
import { makeFleet, placeDestinations, vehicles } from '../lib/layout';

const props = defineProps<{ stats: AirportStats | null }>();

const { t } = useI18n();

const svgRef = ref<SVGSVGElement | null>(null);

// prefers-reduced-motion — read on the client only, so SSR and the first
// client render agree (same hydration-safe pattern as the isMobile fix).
const reduced = ref(false);
let motionQuery: MediaQueryList | undefined;
const onMotionChange = (e: MediaQueryListEvent) => {
	reduced.value = e.matches;
};
onMounted(() => {
	motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	reduced.value = motionQuery.matches;
	motionQuery.addEventListener('change', onMotionChange);
});
onBeforeUnmount(() => {
	motionQuery?.removeEventListener('change', onMotionChange);
});

function nudgeSmil() {
	const svg = svgRef.value;
	if (svg && typeof svg.setCurrentTime === 'function') {
		svg.setCurrentTime(svg.getCurrentTime());
	}
}
onMounted(() => void nextTick(nudgeSmil));
watch(
	() => props.stats,
	() => void nextTick(nudgeSmil),
);

// -- fleets: vehicle counts scale with the digit count of the real numbers --
const depPlanes = computed(() => makeFleet(vehicles(props.stats?.flights.departures ?? 0, 3), 28));
const arrPlanes = computed(() => makeFleet(vehicles(props.stats?.flights.arrivals ?? 0, 3), 26));
const depWalkers = computed(() => makeFleet(vehicles(props.stats?.flights.departures ?? 0, 5), 32));
const arrWalkers = computed(() => makeFleet(vehicles(props.stats?.flights.arrivals ?? 0, 5), 30));
const transferWalkers = computed(() => makeFleet(vehicles(props.stats?.flights.transfers ?? 0, 3), 18));
const cargoCarts = computed(() => makeFleet(vehicles(props.stats?.cargo.outCount ?? 0, 4), 24));
const cargoInBags = computed(() => makeFleet(vehicles(props.stats?.cargo.inCount ?? 0, 3), 20));

const destinationSpots = computed(() =>
	placeDestinations(props.stats?.destinations ?? [], { x: 660, y: 48, w: 460, h: 180 }),
);

const registrations = computed(() => props.stats?.passport.registrations ?? 0);
const dlqParked = computed(() => props.stats?.dlq.parked ?? 0);
// Parked cargo is a standing backlog — drawn as still crates, never animated.
const dlqCrates = computed(() => vehicles(dlqParked.value, 3));
</script>

<template>
	<svg
		ref="svgRef"
		class="airport-scene"
		viewBox="0 0 1200 800"
		role="img"
		:aria-label="t('airport.sceneLabel')"
	>
		<defs>
			<linearGradient id="apx-sky" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="var(--apx-sky-from)" />
				<stop offset="1" stop-color="var(--apx-sky-to)" />
			</linearGradient>
		</defs>

		<!-- ======================= backdrop ======================= -->
		<rect x="0" y="0" width="1200" height="340" fill="url(#apx-sky)" />
		<rect x="0" y="340" width="1200" height="460" fill="var(--apx-ground)" />

		<!-- ================== motion paths (also the visible wiring) ================== -->
		<!-- departure: stand → taxi → runway roll → climb-out to the federated sky -->
		<path
			id="apx-p-dep"
			d="M632,528 C560,516 500,486 480,440 C472,424 478,412 500,409 L880,409 C990,409 1060,380 1120,338 C1160,310 1205,276 1255,240"
			class="apx-taxiline"
			fill="none"
		/>
		<!-- arrival: drawn right→left so rotate=auto faces the landing direction -->
		<path
			id="apx-p-arr"
			d="M1255,120 C1150,150 1050,190 970,250 C900,304 845,380 790,436 C760,460 720,463 690,463 L545,463"
			class="apx-taxiline"
			fill="none"
		/>
		<!-- landside walkway: entrance → check-in → security → gate -->
		<path
			id="apx-p-walk"
			d="M140,738 C190,726 220,716 252,712 C300,706 350,702 390,700 C450,697 500,660 522,632 C536,614 542,602 546,592"
			class="apx-walkway"
			fill="none"
		/>
		<!-- arrival walkway: deplane → immigration → baggage claim → exit -->
		<path
			id="apx-p-arrwalk"
			d="M560,488 C620,530 690,562 748,586 C790,602 824,622 848,644 C868,664 882,700 888,752"
			class="apx-walkway"
			fill="none"
		/>
		<!-- transfer corridor: arrivals rejoining departures (reblog → Announce) -->
		<path
			id="apx-p-transfer"
			d="M756,588 C660,546 600,556 550,588"
			class="apx-walkway apx-transferline"
			fill="none"
		/>
		<!-- outbound cargo belt: bag drop → R2 warehouse -->
		<path
			id="apx-p-cargo"
			d="M268,724 C400,744 700,752 900,748 L1000,744"
			class="apx-belt"
			fill="none"
		/>
		<!-- inbound cargo belt: arrival stand → baggage carousel -->
		<path
			id="apx-p-cargoin"
			d="M604,502 C680,520 760,560 826,620 C840,634 848,644 854,650"
			class="apx-belt"
			fill="none"
		/>
		<!-- entrance road through the Cloudflare gate -->
		<path id="apx-p-road" d="M0,772 C60,764 100,752 140,740" class="apx-road" fill="none" />

		<!-- ======================= runways ======================= -->
		<g>
			<rect x="460" y="398" width="690" height="22" rx="3" fill="var(--apx-runway)" />
			<line x1="480" y1="409" x2="1130" y2="409" stroke="var(--apx-marking)" stroke-width="2" stroke-dasharray="18 14" />
			<text x="462" y="392" class="apx-label">{{ t('airport.scene.runwayDep') }}</text>

			<rect x="460" y="452" width="690" height="22" rx="3" fill="var(--apx-runway)" />
			<line x1="480" y1="463" x2="1130" y2="463" stroke="var(--apx-marking)" stroke-width="2" stroke-dasharray="18 14" />
			<text x="462" y="492" class="apx-label">{{ t('airport.scene.runwayArr') }}</text>
		</g>

		<!-- ======================= terminal & landside ======================= -->
		<g>
			<!-- terminal building -->
			<rect x="120" y="600" width="480" height="150" rx="14" class="apx-building" />
			<line x1="120" y1="628" x2="600" y2="628" stroke="var(--apx-building-line)" stroke-width="1" opacity="0.5" />

			<!-- Cloudflare toll gate on the entrance road -->
			<g>
				<rect x="74" y="732" width="8" height="26" rx="2" fill="var(--apx-accent)" />
				<rect x="106" y="732" width="8" height="26" rx="2" fill="var(--apx-accent)" />
				<rect x="70" y="724" width="48" height="10" rx="4" fill="var(--apx-accent)" opacity="0.85" />
				<text x="94" y="716" text-anchor="middle" class="apx-label">{{ t('airport.scene.cloudflare') }}</text>
			</g>

			<!-- passport desk (registrations) -->
			<g>
				<rect x="158" y="670" width="34" height="20" rx="3" class="apx-desk" />
				<text x="175" y="664" text-anchor="middle" class="apx-label">{{ t('airport.scene.passport') }}</text>
				<g v-if="registrations > 0">
					<circle cx="197" cy="668" r="9" fill="var(--apx-passenger)" />
					<text x="197" y="671.5" text-anchor="middle" class="apx-badge">{{ registrations }}</text>
				</g>
			</g>

			<!-- check-in counters -->
			<g>
				<rect x="228" y="690" width="16" height="18" rx="2" class="apx-desk" />
				<rect x="250" y="690" width="16" height="18" rx="2" class="apx-desk" />
				<rect x="272" y="690" width="16" height="18" rx="2" class="apx-desk" />
				<text x="258" y="682" text-anchor="middle" class="apx-label">{{ t('airport.scene.checkin') }}</text>
			</g>

			<!-- security checkpoint: the barrier crosses the departure walkway only -->
			<g>
				<rect x="386" y="678" width="10" height="24" rx="2" fill="var(--apx-delayed)" opacity="0.85" />
				<line x1="391" y1="682" x2="424" y2="702" stroke="var(--apx-delayed)" stroke-width="4" stroke-linecap="round" />
				<text x="404" y="670" text-anchor="middle" class="apx-label">{{ t('airport.scene.security') }}</text>
			</g>

			<!-- departure gate + jet bridge -->
			<g>
				<rect x="536" y="584" width="22" height="14" rx="3" class="apx-desk" />
				<line x1="558" y1="590" x2="612" y2="548" stroke="var(--apx-building-line)" stroke-width="5" opacity="0.6" />
				<text x="540" y="576" text-anchor="middle" class="apx-label">{{ t('airport.scene.gate') }}</text>
			</g>
		</g>

		<!-- ======================= arrivals side ======================= -->
		<g>
			<!-- immigration booth on the arrival walkway -->
			<rect x="738" y="566" width="36" height="24" rx="3" class="apx-desk" />
			<line x1="744" y1="594" x2="774" y2="602" stroke="var(--apx-arrival)" stroke-width="3" stroke-linecap="round" />
			<text x="756" y="558" text-anchor="middle" class="apx-label">{{ t('airport.scene.immigration') }}</text>

			<!-- baggage carousel (remote media) -->
			<g>
				<circle cx="860" cy="655" r="28" class="apx-carousel" />
				<circle cx="860" cy="655" r="10" fill="var(--apx-building-line)" opacity="0.35" />
				<g>
					<template v-if="!reduced">
						<animateTransform
							attributeName="transform"
							type="rotate"
							from="0 860 655"
							to="360 860 655"
							dur="22s"
							repeatCount="indefinite"
						/>
					</template>
					<rect
						v-for="(bag, i) in cargoInBags"
						:key="'bag-' + i"
						:x="860 - 5 + 21 * Math.cos((i * 2 * Math.PI) / Math.max(cargoInBags.length, 1))"
						:y="655 - 4 + 21 * Math.sin((i * 2 * Math.PI) / Math.max(cargoInBags.length, 1))"
						width="10"
						height="8"
						rx="2"
						fill="var(--apx-cargo)"
					/>
				</g>
				<text x="860" y="700" text-anchor="middle" class="apx-label">{{ t('airport.scene.baggage') }}</text>
			</g>
		</g>

		<!-- ======================= cargo terminal (R2) ======================= -->
		<g>
			<rect x="1000" y="700" width="140" height="66" rx="8" class="apx-building" />
			<rect x="1016" y="716" width="24" height="16" rx="2" fill="var(--apx-cargo)" opacity="0.7" />
			<rect x="1048" y="716" width="24" height="16" rx="2" fill="var(--apx-cargo)" opacity="0.5" />
			<rect x="1080" y="716" width="24" height="16" rx="2" fill="var(--apx-cargo)" opacity="0.3" />
			<text x="1070" y="754" text-anchor="middle" class="apx-label">{{ t('airport.scene.cargoTerminal') }}</text>
		</g>

		<!-- ============ DLQ holding area (federation_dlq_parked) ============ -->
		<g>
			<rect x="1050" y="636" width="90" height="50" rx="6" class="apx-dlq-area" :class="{ 'apx-dlq-area-alert': dlqParked > 0 }" />
			<g v-if="dlqParked > 0">
				<rect
					v-for="i in dlqCrates"
					:key="'dlq-' + i"
					:x="1058 + (i - 1) * 16"
					y="668"
					width="12"
					height="10"
					rx="1.5"
					fill="var(--apx-delayed)"
				/>
				<text x="1095" y="654" text-anchor="middle" class="apx-delayed-mark">{{ dlqParked }}</text>
			</g>
			<text x="1095" y="630" text-anchor="middle" class="apx-label">{{ t('airport.scene.dlq') }}</text>
		</g>

		<!-- ======================= control tower (StreamingDO) ======================= -->
		<g>
			<rect x="598" y="288" width="16" height="56" rx="3" class="apx-building" />
			<polygon points="590,288 622,288 616,272 596,272" fill="var(--apx-accent)" opacity="0.9" />
			<template v-if="!reduced">
				<circle cx="606" cy="264" r="8" fill="none" stroke="var(--apx-accent)" stroke-width="1.5">
					<animate attributeName="r" values="6;26" dur="3s" repeatCount="indefinite" />
					<animate attributeName="opacity" values="0.8;0" dur="3s" repeatCount="indefinite" />
				</circle>
				<circle cx="606" cy="264" r="8" fill="none" stroke="var(--apx-accent)" stroke-width="1.5">
					<animate attributeName="r" values="6;26" dur="3s" begin="-1.5s" repeatCount="indefinite" />
					<animate attributeName="opacity" values="0.8;0" dur="3s" begin="-1.5s" repeatCount="indefinite" />
				</circle>
			</template>
			<circle v-else cx="606" cy="264" r="14" fill="none" stroke="var(--apx-accent)" stroke-width="1.5" opacity="0.5" />
			<text x="606" y="360" text-anchor="middle" class="apx-label">{{ t('airport.scene.tower') }}</text>
		</g>

		<!-- ======================= destination airports ======================= -->
		<g>
			<text x="662" y="36" class="apx-label apx-label-strong">{{ t('airport.scene.destinations') }}</text>
			<g v-for="spot in destinationSpots" :key="spot.domain">
				<!-- federated route: both delivery target and arrival origin -->
				<path
					:d="`M1150,310 Q ${(1150 + spot.x) / 2},${Math.min(310, spot.y) - 24} ${spot.x},${spot.y}`"
					fill="none"
					class="apx-route"
					:class="{ 'apx-route-delayed': spot.delayed }"
				/>
				<circle
					:cx="spot.x"
					:cy="spot.y"
					:r="8 + spot.size * 3"
					class="apx-destination"
					:class="{ 'apx-destination-delayed': spot.delayed }"
				/>
				<rect :x="spot.x - 4" :y="spot.y - 3" width="8" height="6" rx="1" fill="var(--apx-marking)" opacity="0.9" />
				<text v-if="spot.delayed" :x="spot.x + 10 + spot.size * 3" :y="spot.y - 6" class="apx-delayed-mark">!</text>
				<text :x="spot.x" :y="spot.y + 20 + spot.size * 3" text-anchor="middle" class="apx-domain">
					{{ spot.domain }}
				</text>
			</g>
		</g>

		<!-- ======================= vehicles (counts = real digits) ======================= -->
		<!-- departing planes -->
		<g v-for="(f, i) in depPlanes" :key="'dep-' + i">
			<path d="M0,0 L-14,5 L-11,1 L-16,0 L-11,-1 L-14,-5 Z" class="apx-plane">
				<animateMotion
					v-if="!reduced"
					:dur="f.dur"
					:begin="f.begin"
					repeatCount="indefinite"
					rotate="auto"
				>
					<mpath href="#apx-p-dep" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
					rotate="auto"
				>
					<mpath href="#apx-p-dep" />
				</animateMotion>
			</path>
		</g>

		<!-- arriving planes -->
		<g v-for="(f, i) in arrPlanes" :key="'arr-' + i">
			<path d="M0,0 L-14,5 L-11,1 L-16,0 L-11,-1 L-14,-5 Z" class="apx-plane apx-plane-arrival">
				<animateMotion
					v-if="!reduced"
					:dur="f.dur"
					:begin="f.begin"
					repeatCount="indefinite"
					rotate="auto"
				>
					<mpath href="#apx-p-arr" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
					rotate="auto"
				>
					<mpath href="#apx-p-arr" />
				</animateMotion>
			</path>
		</g>

		<!-- departing passengers -->
		<g v-for="(f, i) in depWalkers" :key="'walk-' + i">
			<circle r="3.5" class="apx-person">
				<animateMotion v-if="!reduced" :dur="f.dur" :begin="f.begin" repeatCount="indefinite">
					<mpath href="#apx-p-walk" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
				>
					<mpath href="#apx-p-walk" />
				</animateMotion>
			</circle>
		</g>

		<!-- arriving passengers -->
		<g v-for="(f, i) in arrWalkers" :key="'awalk-' + i">
			<circle r="3.5" class="apx-person apx-person-arrival">
				<animateMotion v-if="!reduced" :dur="f.dur" :begin="f.begin" repeatCount="indefinite">
					<mpath href="#apx-p-arrwalk" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
				>
					<mpath href="#apx-p-arrwalk" />
				</animateMotion>
			</circle>
		</g>

		<!-- transfer passengers -->
		<g v-for="(f, i) in transferWalkers" :key="'transfer-' + i">
			<circle r="3.5" class="apx-person apx-person-transfer">
				<animateMotion v-if="!reduced" :dur="f.dur" :begin="f.begin" repeatCount="indefinite">
					<mpath href="#apx-p-transfer" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
				>
					<mpath href="#apx-p-transfer" />
				</animateMotion>
			</circle>
		</g>

		<!-- outbound cargo carts -->
		<g v-for="(f, i) in cargoCarts" :key="'cart-' + i">
			<g class="apx-cart">
				<rect x="-6" y="-5" width="12" height="7" rx="1.5" fill="var(--apx-cargo)" />
				<circle cx="-3.5" cy="3.5" r="1.8" fill="var(--apx-text)" />
				<circle cx="3.5" cy="3.5" r="1.8" fill="var(--apx-text)" />
				<animateMotion v-if="!reduced" :dur="f.dur" :begin="f.begin" repeatCount="indefinite" rotate="auto">
					<mpath href="#apx-p-cargo" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
					rotate="auto"
				>
					<mpath href="#apx-p-cargo" />
				</animateMotion>
			</g>
		</g>

		<!-- inbound cargo on the way to the carousel -->
		<g v-for="(f, i) in cargoInBags" :key="'inbag-' + i">
			<rect x="-5" y="-4" width="10" height="8" rx="2" fill="var(--apx-cargo)" opacity="0.85">
				<animateMotion v-if="!reduced" :dur="f.dur" :begin="f.begin" repeatCount="indefinite">
					<mpath href="#apx-p-cargoin" />
				</animateMotion>
				<animateMotion
					v-else
					dur="1s"
					fill="freeze"
					calcMode="linear"
					:keyPoints="`${f.freeze};${f.freeze}`"
					keyTimes="0;1"
				>
					<mpath href="#apx-p-cargoin" />
				</animateMotion>
			</rect>
		</g>
	</svg>
</template>

<style scoped>
.airport-scene {
	--apx-sky-from: #dbeafe;
	--apx-sky-to: #f0f9ff;
	--apx-ground: #e8efe4;
	--apx-runway: #64748b;
	--apx-marking: #f8fafc;
	--apx-building-fill: #ffffff;
	--apx-building-line: #94a3b8;
	--apx-text: #334155;
	--apx-muted: #64748b;
	--apx-passenger: #2563eb;
	--apx-arrival: #0d9488;
	--apx-transfer: #d97706;
	--apx-cargo: #7c3aed;
	--apx-delayed: #dc2626;
	--apx-route: #93c5fd;
	--apx-accent: #6366f1;

	display: block;
	width: 100%;
	height: auto;
}

:global(.dark) .airport-scene {
	--apx-sky-from: #0f172a;
	--apx-sky-to: #1e293b;
	--apx-ground: #16211c;
	--apx-runway: #334155;
	--apx-marking: #cbd5e1;
	--apx-building-fill: #1e293b;
	--apx-building-line: #475569;
	--apx-text: #cbd5e1;
	--apx-muted: #94a3b8;
	--apx-passenger: #60a5fa;
	--apx-arrival: #2dd4bf;
	--apx-transfer: #fbbf24;
	--apx-cargo: #a78bfa;
	--apx-delayed: #f87171;
	--apx-route: #3b5f8a;
	--apx-accent: #818cf8;
}

.apx-building {
	fill: var(--apx-building-fill);
	stroke: var(--apx-building-line);
	stroke-width: 1.5;
}

.apx-desk {
	fill: var(--apx-building-fill);
	stroke: var(--apx-building-line);
	stroke-width: 1.5;
}

.apx-taxiline {
	stroke: var(--apx-building-line);
	stroke-width: 1.5;
	stroke-dasharray: 4 6;
	opacity: 0.55;
}

.apx-walkway {
	stroke: var(--apx-passenger);
	stroke-width: 1.5;
	stroke-dasharray: 2 5;
	opacity: 0.45;
}

.apx-transferline {
	stroke: var(--apx-transfer);
}

.apx-belt {
	stroke: var(--apx-cargo);
	stroke-width: 3;
	stroke-dasharray: 6 4;
	opacity: 0.35;
}

.apx-road {
	stroke: var(--apx-muted);
	stroke-width: 6;
	opacity: 0.4;
}

.apx-route {
	stroke: var(--apx-route);
	stroke-width: 1.2;
	stroke-dasharray: 5 6;
	opacity: 0.8;
}

.apx-route-delayed {
	stroke: var(--apx-delayed);
}

.apx-destination {
	fill: var(--apx-building-fill);
	stroke: var(--apx-route);
	stroke-width: 2;
}

.apx-destination-delayed {
	stroke: var(--apx-delayed);
}

.apx-carousel {
	fill: none;
	stroke: var(--apx-building-line);
	stroke-width: 5;
	opacity: 0.6;
}

.apx-dlq-area {
	fill: none;
	stroke: var(--apx-building-line);
	stroke-width: 1.5;
	stroke-dasharray: 5 4;
	opacity: 0.7;
}

.apx-dlq-area-alert {
	stroke: var(--apx-delayed);
	opacity: 1;
}

.apx-plane {
	fill: var(--apx-passenger);
}

.apx-plane-arrival {
	fill: var(--apx-arrival);
}

.apx-person {
	fill: var(--apx-passenger);
}

.apx-person-arrival {
	fill: var(--apx-arrival);
}

.apx-person-transfer {
	fill: var(--apx-transfer);
}

.apx-label {
	font-size: 11px;
	fill: var(--apx-muted);
	font-family: inherit;
}

.apx-label-strong {
	font-weight: 600;
	fill: var(--apx-text);
}

.apx-domain {
	font-size: 10.5px;
	fill: var(--apx-text);
}

.apx-badge {
	font-size: 9px;
	font-weight: 700;
	fill: #ffffff;
}

.apx-delayed-mark {
	font-size: 13px;
	font-weight: 800;
	fill: var(--apx-delayed);
}
</style>
