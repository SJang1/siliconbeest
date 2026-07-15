<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  CONTRIBUTION_EVENTS,
  type ContributionEvent,
  type InvitationAdminSettings,
} from '@/types/registration'

const props = defineProps<{ settings: InvitationAdminSettings }>()
const { t } = useI18n()

function setToggle(
  key: 'invite_link_issuance_enabled' | 'invite_contribution_enabled',
  event: Event,
) {
  props.settings[key] = (event.target as HTMLInputElement).checked ? '1' : '0'
}

function pointKey(event: ContributionEvent): keyof InvitationAdminSettings {
  return `invite_contribution_points_${event}`
}

function setPoint(event: ContributionEvent, value: string) {
  props.settings[pointKey(event)] = value
}
</script>

<template>
  <section class="sb-card p-6">
    <h2 class="sb-heading mb-2 text-lg text-slate-900 dark:text-white">
      {{ t('admin_invitation_settings.title') }}
    </h2>
    <p class="mb-5 text-sm text-slate-500 dark:text-slate-400">
      {{ t('admin_invitation_settings.description') }}
    </p>

    <div class="space-y-5">
      <div>
        <label class="sb-label" for="invite-credit-max">
          {{ t('admin_invitation_settings.max_credits') }}
        </label>
        <input
          id="invite-credit-max"
          v-model="settings.invite_credit_max_per_account"
          class="sb-input !w-48"
          type="number"
          min="0"
          step="1"
        />
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('admin_invitation_settings.max_credits_help') }}
        </p>
      </div>

      <label class="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          :checked="settings.invite_link_issuance_enabled === '1'"
          class="mt-0.5 h-4 w-4 rounded accent-indigo-600"
          @change="setToggle('invite_link_issuance_enabled', $event)"
        />
        <span>
          <span class="block text-sm font-medium text-slate-900 dark:text-white">
            {{ t('admin_invitation_settings.issuance_enabled') }}
          </span>
          <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            {{ t('admin_invitation_settings.issuance_enabled_help') }}
          </span>
        </span>
      </label>

      <div class="border-t border-slate-200 pt-5 dark:border-slate-700">
        <label class="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            :checked="settings.invite_contribution_enabled === '1'"
            class="mt-0.5 h-4 w-4 rounded accent-indigo-600"
            @change="setToggle('invite_contribution_enabled', $event)"
          />
          <span>
            <span class="block text-sm font-medium text-slate-900 dark:text-white">
              {{ t('admin_invitation_settings.contribution_enabled') }}
            </span>
            <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              {{ t('admin_invitation_settings.contribution_enabled_help') }}
            </span>
          </span>
        </label>
      </div>

      <div>
        <label class="sb-label" for="invite-contribution-threshold">
          {{ t('admin_invitation_settings.threshold') }}
        </label>
        <input
          id="invite-contribution-threshold"
          v-model="settings.invite_contribution_threshold"
          class="sb-input !w-48"
          type="number"
          min="1"
          step="1"
          :disabled="settings.invite_contribution_enabled !== '1'"
        />
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('admin_invitation_settings.threshold_help') }}
        </p>
      </div>

      <fieldset :disabled="settings.invite_contribution_enabled !== '1'">
        <legend class="mb-1 text-sm font-semibold text-slate-900 dark:text-white">
          {{ t('admin_invitation_settings.event_points') }}
        </legend>
        <p class="mb-4 text-xs text-slate-500 dark:text-slate-400">
          {{ t('admin_invitation_settings.event_points_help') }}
        </p>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label
            v-for="event in CONTRIBUTION_EVENTS"
            :key="event"
            class="block text-sm text-slate-700 dark:text-slate-300"
          >
            <span class="mb-1 block">{{ t(`admin_invitation_settings.events.${event}`) }}</span>
            <input
              :value="settings[pointKey(event)]"
              class="sb-input"
              type="number"
              step="1"
              @input="setPoint(event, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </fieldset>
    </div>
  </section>
</template>
