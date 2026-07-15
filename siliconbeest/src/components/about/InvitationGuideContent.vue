<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { withCurrentDesign } from '@/utils/safeRedirect'

interface GuideSection {
  title: string
  description: string
  items: string[]
}

const props = withDefaults(defineProps<{ legacy?: boolean }>(), {
  legacy: false,
})

const { t } = useI18n()
const route = useRoute()

const aboutPath = computed(() => withCurrentDesign('/about', route.path))
const sections = computed<GuideSection[]>(() => [
  {
    title: t('invitation_guide.credits_title'),
    description: t('invitation_guide.credits_description'),
    items: [
      t('invitation_guide.credits_cap'),
      t('invitation_guide.credits_admin'),
      t('invitation_guide.credits_pause'),
    ],
  },
  {
    title: t('invitation_guide.contribution_title'),
    description: t('invitation_guide.contribution_description'),
    items: [
      t('invitation_guide.contribution_settings'),
      t('invitation_guide.contribution_negative'),
      t('invitation_guide.contribution_immediate'),
    ],
  },
  {
    title: t('invitation_guide.links_title'),
    description: t('invitation_guide.links_description'),
    items: [
      t('invitation_guide.links_reserve'),
      t('invitation_guide.links_expire'),
      t('invitation_guide.links_stop'),
    ],
  },
  {
    title: t('invitation_guide.refunds_title'),
    description: t('invitation_guide.refunds_description'),
    items: [
      t('invitation_guide.refunds_unused'),
      t('invitation_guide.refunds_cancelled'),
    ],
  },
  {
    title: t('invitation_guide.signup_title'),
    description: t('invitation_guide.signup_description'),
    items: [
      t('invitation_guide.signup_invitation'),
      t('invitation_guide.signup_cooldown'),
      t('invitation_guide.signup_limits'),
    ],
  },
  {
    title: t('invitation_guide.audit_title'),
    description: t('invitation_guide.audit_description'),
    items: [
      t('invitation_guide.audit_scope'),
      t('invitation_guide.audit_admin'),
      t('invitation_guide.audit_safety'),
    ],
  },
])
</script>

<template>
  <div :class="props.legacy ? 'p-6 space-y-6' : 'mx-auto w-full max-w-4xl space-y-6 px-4 py-8 animate-fade-in'">
    <header :class="props.legacy ? 'space-y-3' : 'space-y-3 text-center'">
      <router-link
        :to="aboutPath"
        :class="props.legacy
          ? 'inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400'
          : 'inline-flex items-center gap-2 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400'"
      >
        <span aria-hidden="true">←</span>
        {{ t('invitation_guide.back_to_about') }}
      </router-link>
      <h1 :class="props.legacy ? 'text-3xl font-bold' : 'sb-heading text-3xl sm:text-4xl'">
        {{ t('invitation_guide.title') }}
      </h1>
      <p :class="props.legacy ? 'max-w-3xl text-gray-600 dark:text-gray-400' : 'mx-auto max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400'">
        {{ t('invitation_guide.intro') }}
      </p>
    </header>

    <div class="grid gap-5 md:grid-cols-2">
      <section
        v-for="(section, index) in sections"
        :key="section.title"
        :class="props.legacy
          ? 'rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800'
          : 'sb-card p-6'"
      >
        <div class="flex items-start gap-3">
          <span
            :class="props.legacy
              ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
              : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300'"
            aria-hidden="true"
          >
            {{ index + 1 }}
          </span>
          <div>
            <h2 :class="props.legacy ? 'text-lg font-semibold' : 'sb-heading text-lg'">
              {{ section.title }}
            </h2>
            <p :class="props.legacy ? 'mt-2 text-sm leading-6 text-gray-600 dark:text-gray-400' : 'mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400'">
              {{ section.description }}
            </p>
          </div>
        </div>
        <ul :class="props.legacy ? 'mt-4 space-y-3 text-sm text-gray-700 dark:text-gray-300' : 'mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300'">
          <li v-for="item in section.items" :key="item" class="flex gap-3 leading-6">
            <span :class="props.legacy ? 'text-indigo-500' : 'text-brand-500'" aria-hidden="true">•</span>
            <span>{{ item }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
