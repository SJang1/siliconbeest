<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
  TransitionChild,
  TransitionRoot,
} from '@headlessui/vue'
import { useComposeStore } from '@/stores/compose'
import { useDraftsStore, hasDraftContent, type ComposeDraft, type ComposeDraftInput } from '@/stores/drafts'
import { useEmojis } from '@/composables/useEmojis'
import { search as apiSearch } from '@/api/mastodon/search'
import { useAuthStore } from '@/stores/auth'
import EmojiPicker from '@/components/common/EmojiPicker.vue'
import { articleMediaMarkdown } from '@/utils/markdownMedia'
import { updateMedia } from '@/api/mastodon/media'
import type { MediaAttachment } from '@/types/mastodon'

const { t } = useI18n()
const compose = useComposeStore()
const drafts = useDraftsStore()
const auth = useAuthStore()
const { fetchCustomEmojis, searchEmojis } = useEmojis()

// Remote drafts are session data: fetch them when a composer is entered,
// rather than as a side effect of booting the full application.
watch(
  [() => auth.currentUser?.id ?? null, () => auth.token],
  ([accountId, token]) => {
    if (accountId && token) void drafts.refresh()
  },
  { immediate: true },
)

const props = defineProps<{
  replyTo?: { id: string; account: { acct: string }; mentions?: Array<{ acct: string }>; visibility?: string }
  maxChars?: number
}>()

const emit = defineEmits<{
  submit: [payload: {
    content: string
    object_type: 'Note' | 'Article'
    title?: string
    summary?: string
    spoiler_text: string
    visibility: string
    language: string
    in_reply_to_id?: string
    quote_id?: string
    quote_policy?: import('@/types/mastodon').QuotePolicy
    media_ids?: string[]
    draft_id?: string
  }]
}>()

defineExpose({ finishDraftSession })

const isEditing = computed(() => compose.editingId !== null)
const content = ref(isEditing.value ? compose.text : '')
const objectType = ref<'Note' | 'Article'>(isEditing.value ? compose.objectType : 'Note')
const articleTitle = ref(isEditing.value ? compose.title : '')
const articleSummary = ref(isEditing.value ? compose.articleSummary : '')
const spoilerText = ref(isEditing.value ? compose.contentWarning : '')
const showCw = ref(isEditing.value ? compose.showContentWarning : false)
const fileInput = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const charLimit = computed(() => objectType.value === 'Article' ? 100_000 : (props.maxChars ?? 500))
const charsRemaining = computed(() => charLimit.value - content.value.length)
const mountedPublishedTick = compose.publishedTick

// ── Emoji picker state ──────────────────────────────────────────────
const showEmojiPicker = ref(false)
const emojiPickerRef = ref<HTMLElement | null>(null)
const emojiButtonRef = ref<HTMLElement | null>(null)
const showDraftMenu = ref(false)

/** Position the emoji picker above the button, teleported to body */
const emojiPickerPosition = computed(() => {
  if (!emojiButtonRef.value) return { top: '0px', left: '0px' }
  const rect = emojiButtonRef.value.getBoundingClientRect()
  const pickerHeight = 340 // max-h-80 = 320 + some margin
  const pickerWidth = 288 // w-72

  // Try above the button first
  let top = rect.top - pickerHeight
  if (top < 8) top = rect.bottom + 4 // Fall back to below if no space above

  let left = rect.right - pickerWidth
  if (left < 8) left = 8

  return { top: `${top}px`, left: `${left}px` }
})

onMounted(() => {
  fetchCustomEmojis()
  document.addEventListener('click', handleClickOutside)

  // Auto-populate mentions when replying
  if (props.replyTo) {
    populateReplyMentions(props.replyTo)
  }
})

/** Extract @user@domain mentions from HTML content by parsing mention links */
function extractMentionsFromContent(htmlContent?: string): string[] {
  if (!htmlContent) return []
  const results: string[] = []
  const currentDomain = window.location.hostname
  // Match: <a href="https://domain/@username" class="...mention...">
  const regex = /href="https?:\/\/([^/]+)\/@([^"]+)"[^>]*class="[^"]*mention/gi
  let match
  while ((match = regex.exec(htmlContent)) !== null) {
    const domain = match[1]
    const username = match[2]
    if (!username) continue
    if (domain === currentDomain) {
      results.push(username) // local user
    } else {
      results.push(`${username}@${domain}`)
    }
  }
  return results
}

/** Populate reply mentions from status data */
function populateReplyMentions(replyTo: typeof props.replyTo) {
  if (!replyTo) return
  const myAcct = auth.currentUser?.acct
  const seen = new Set<string>()
  const mentions: string[] = []

  function addMention(acct: string) {
    const normalized = acct.replace(/^@/, '')
    if (normalized === myAcct || seen.has(normalized)) return
    seen.add(normalized)
    mentions.push(`@${normalized}`)
  }

  // 1. Author of the post
  addMention(replyTo.account.acct)

  // 2. Mentions from API response
  if (replyTo.mentions) {
    for (const m of replyTo.mentions) addMention(m.acct)
  }

  // 3. Mentions extracted from HTML content (catches ones missing from mentions array)
  const contentMentions = extractMentionsFromContent((replyTo as any).content)
  for (const acct of contentMentions) addMention(acct)

  if (mentions.length > 0) {
    content.value = mentions.join(' ') + ' '
    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.focus()
        textareaRef.value.selectionStart = content.value.length
        textareaRef.value.selectionEnd = content.value.length
      }
    })
  }
}

// When reply target changes
watch(() => props.replyTo?.id, (newId, oldId) => {
  if (!newId || newId === oldId || isHydratingDraft.value) return
  populateReplyMentions(props.replyTo)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  finishDraftSession()
})

function handleClickOutside(e: MouseEvent) {
  if (showEmojiPicker.value && emojiPickerRef.value && !emojiPickerRef.value.contains(e.target as Node)) {
    showEmojiPicker.value = false
  }
  if (autocompleteVisible.value && autocompleteRef.value && !autocompleteRef.value.contains(e.target as Node)) {
    closeAutocomplete()
  }
}

function toggleEmojiPicker() {
  showEmojiPicker.value = !showEmojiPicker.value
}

function onEmojiSelect(emoji: string) {
  insertAtCursor(emoji)
  showEmojiPicker.value = false
}

function insertAtCursor(text: string) {
  const ta = textareaRef.value
  if (!ta) {
    content.value += text
    return
  }
  const start = ta.selectionStart ?? content.value.length
  const end = ta.selectionEnd ?? content.value.length
  const before = content.value.substring(0, start)
  const after = content.value.substring(end)
  content.value = before + text + after
  nextTick(() => {
    const pos = start + text.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
}

function insertArticleMedia(media: MediaAttachment, fileName?: string): string {
  const ta = textareaRef.value
  const start = ta?.selectionStart ?? content.value.length
  const end = ta?.selectionEnd ?? content.value.length
  const before = content.value.substring(0, start)
  const after = content.value.substring(end)
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n\n' : ''
  const suffix = after.length > 0 && !after.startsWith('\n') ? '\n\n' : ''
  const mediaMarkdown = articleMediaMarkdown(media, fileName)
  const markdown = `${prefix}${mediaMarkdown}${suffix}`
  content.value = before + markdown + after
  nextTick(() => {
    if (!ta) return
    const pos = start + markdown.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
  compose.removeMedia(media.id, false)
  return mediaMarkdown
}

const generatedArticleMediaMarkdown = new Map<string, string>()

function trackGeneratedArticleDescription(
  result: Promise<MediaAttachment | null>,
  insertedMarkdown: string,
  fileName?: string,
) {
  void result.then((resolvedMedia) => {
    if (!resolvedMedia?.description) return
    const generatedMarkdown = articleMediaMarkdown(resolvedMedia, fileName)
    if (generatedMarkdown === insertedMarkdown) {
      generatedArticleMediaMarkdown.set(resolvedMedia.id, generatedMarkdown)
      return
    }

    // Replace only the exact Markdown originally inserted by the composer.
    // If the author edited its label or URL while AI was running, the
    // original no longer matches and their manual Markdown always wins.
    const insertionIndex = content.value.indexOf(insertedMarkdown)
    if (insertionIndex < 0) {
      compose.markMediaDescriptionReviewed(resolvedMedia.id)
      return
    }
    content.value = content.value.slice(0, insertionIndex)
      + generatedMarkdown
      + content.value.slice(insertionIndex + insertedMarkdown.length)
    generatedArticleMediaMarkdown.set(resolvedMedia.id, generatedMarkdown)
  })
}

function reviewEditedGeneratedArticleAlt() {
  for (const [mediaId, generatedMarkdown] of generatedArticleMediaMarkdown) {
    if (!content.value.includes(generatedMarkdown)) {
      compose.markMediaDescriptionReviewed(mediaId)
      generatedArticleMediaMarkdown.delete(mediaId)
    }
  }
}

async function addComposerMedia(file: File) {
  const media = await compose.addMedia(file)
  if (media && objectType.value === 'Article') {
    const descriptionResult = media.description_generation_status === 'pending'
      ? compose.waitForMediaDescription(media.id)
      : null
    const insertedMarkdown = insertArticleMedia(media, file.name)

    if (descriptionResult) {
      trackGeneratedArticleDescription(descriptionResult, insertedMarkdown, file.name)
    } else if (
      media.description_generation_status === 'complete'
      && media.description
    ) {
      generatedArticleMediaMarkdown.set(media.id, insertedMarkdown)
    }
  }
}

// ── Autocomplete state ──────────────────────────────────────────────
const autocompleteRef = ref<HTMLElement | null>(null)
const autocompleteVisible = ref(false)
const autocompleteType = ref<'emoji' | 'mention' | 'hashtag'>('emoji')
const autocompleteQuery = ref('')
const autocompleteIndex = ref(0)
const autocompleteItems = ref<Array<{
  key: string
  label: string
  sublabel?: string
  image?: string
  value: string
}>>([])

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function closeAutocomplete() {
  autocompleteVisible.value = false
  autocompleteItems.value = []
  autocompleteIndex.value = 0
  autocompleteQuery.value = ''
}

function onTextareaInput() {
  reviewEditedGeneratedArticleAlt()
  detectAutocomplete()
}

function detectAutocomplete() {
  const ta = textareaRef.value
  if (!ta) return
  const cursor = ta.selectionStart ?? 0
  const textBefore = content.value.substring(0, cursor)

  // Match :shortcode (2+ chars after :)
  const emojiMatch = textBefore.match(/:([a-zA-Z0-9_]{2,})$/)
  if (emojiMatch) {
    autocompleteType.value = 'emoji'
    autocompleteQuery.value = emojiMatch[1]!
    autocompleteIndex.value = 0
    runEmojiSearch(emojiMatch[1]!)
    return
  }

  // Match @mention (2+ chars after @)
  const mentionMatch = textBefore.match(/@([a-zA-Z0-9_]{2,})$/)
  if (mentionMatch) {
    autocompleteType.value = 'mention'
    autocompleteQuery.value = mentionMatch[1]!
    autocompleteIndex.value = 0
    debouncedApiSearch(mentionMatch[1]!, 'accounts')
    return
  }

  // Match #hashtag (2+ chars after #)
  const hashtagMatch = textBefore.match(/#([a-zA-Z0-9_\u{AC00}-\u{D7AF}]{2,})$/u)
  if (hashtagMatch) {
    autocompleteType.value = 'hashtag'
    autocompleteQuery.value = hashtagMatch[1]!
    autocompleteIndex.value = 0
    debouncedApiSearch(hashtagMatch[1]!, 'hashtags')
    return
  }

  closeAutocomplete()
}

function runEmojiSearch(query: string) {
  const results = searchEmojis(query)
  const items: typeof autocompleteItems.value = []

  for (const e of results.custom.slice(0, 8)) {
    items.push({
      key: `custom:${e.shortcode}`,
      label: e.shortcode,
      image: e.static_url,
      value: `:${e.shortcode}: `,
    })
  }
  for (const e of results.unicode.slice(0, 4)) {
    items.push({
      key: `unicode:${e.name}`,
      label: `${e.emoji} ${e.name}`,
      value: `${e.emoji} `,
    })
  }

  autocompleteItems.value = items
  autocompleteVisible.value = items.length > 0
}

function debouncedApiSearch(query: string, type: 'accounts' | 'hashtags') {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    performApiSearch(query, type)
  }, 200)
}

async function performApiSearch(query: string, type: 'accounts' | 'hashtags') {
  if (!auth.token) return
  try {
    const { data } = await apiSearch(query, { type, limit: 8, token: auth.token })
    const items: typeof autocompleteItems.value = []

    if (type === 'accounts') {
      for (const account of data.accounts) {
        items.push({
          key: `account:${account.id}`,
          label: account.display_name || account.username,
          sublabel: `@${account.acct}`,
          image: account.avatar,
          value: `@${account.acct} `,
        })
      }
    } else {
      for (const tag of data.hashtags) {
        items.push({
          key: `tag:${tag.name}`,
          label: `#${tag.name}`,
          value: `#${tag.name} `,
        })
      }
    }

    autocompleteItems.value = items
    autocompleteVisible.value = items.length > 0
  } catch {
    // Silently fail
  }
}

function selectAutocompleteItem(item: typeof autocompleteItems.value[0]) {
  if (!item) return
  const ta = textareaRef.value
  if (!ta) return

  const cursor = ta.selectionStart ?? content.value.length
  const textBefore = content.value.substring(0, cursor)
  const textAfter = content.value.substring(cursor)

  // Find the trigger position to replace
  let triggerPos = cursor
  if (autocompleteType.value === 'emoji') {
    triggerPos = textBefore.lastIndexOf(':')
  } else if (autocompleteType.value === 'mention') {
    triggerPos = textBefore.lastIndexOf('@')
  } else if (autocompleteType.value === 'hashtag') {
    triggerPos = textBefore.lastIndexOf('#')
  }

  const before = content.value.substring(0, triggerPos)
  content.value = before + item.value + textAfter

  closeAutocomplete()

  nextTick(() => {
    const pos = triggerPos + item.value.length
    ta.selectionStart = pos
    ta.selectionEnd = pos
    ta.focus()
  })
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (!autocompleteVisible.value) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    autocompleteIndex.value = Math.min(autocompleteIndex.value + 1, autocompleteItems.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    autocompleteIndex.value = Math.max(autocompleteIndex.value - 1, 0)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (autocompleteItems.value[autocompleteIndex.value]) {
      e.preventDefault()
      selectAutocompleteItem(autocompleteItems.value[autocompleteIndex.value]!)
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeAutocomplete()
  }
}

// ── Original composer logic ─────────────────────────────────────────
const languageOptions = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ar', label: 'العربية' },
]
const selectedLanguage = ref(
  languageOptions.find(l => l.code === (
    typeof navigator === 'undefined' ? 'en' : (navigator.language?.split('-')[0] || 'en')
  )) || languageOptions[1]!
)

const visibilityOptions = [
  { value: 'public', label: 'compose.visibility.public', icon: '🌐' },
  { value: 'unlisted', label: 'compose.visibility.unlisted', icon: '🔓' },
  { value: 'private', label: 'compose.visibility.private', icon: '🔒' },
  { value: 'direct', label: 'compose.visibility.direct', icon: '✉️' },
]

const VISIBILITY_RANK: Record<string, number> = { direct: 0, private: 1, unlisted: 2, public: 3 }

function initialVisibility() {
  const defaultOpt = visibilityOptions.find(o => o.value === compose.defaultVisibility) ?? visibilityOptions[0]!
  if (props.replyTo?.visibility) {
    // Clamp: can't be more public than the parent
    const parentRank = VISIBILITY_RANK[props.replyTo.visibility] ?? 3
    const defaultRank = VISIBILITY_RANK[defaultOpt.value] ?? 3
    if (defaultRank > parentRank) {
      return visibilityOptions.find(o => o.value === props.replyTo!.visibility) ?? defaultOpt
    }
  }
  return defaultOpt
}

const selectedVisibility = ref(initialVisibility())
const quotePolicyOptions: Array<{ value: import('@/types/mastodon').QuotePolicy; label: string }> = [
  { value: 'public', label: 'compose.quote_policy.public' },
  { value: 'followers', label: 'compose.quote_policy.followers' },
  { value: 'nobody', label: 'compose.quote_policy.nobody' },
]
const quotePolicyIcons: Record<import('@/types/mastodon').QuotePolicy, string> = {
  public: '↗',
  followers: '◎',
  nobody: '⊘',
}

const AUTOSAVE_DELAY_MS = 1000
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let draftSessionFinished = false
const isHydratingDraft = ref(false)
const draftSavedAt = ref<string | null>(null)
const draftSaveLabel = computed(() => {
  if (drafts.saving) return t('compose.draft_saving')
  if (drafts.error) return t('compose.draft_save_failed')
  return draftSavedAt.value ? t('compose.draft_saved') : t('compose.save_draft')
})

function draftSnapshot(): ComposeDraftInput {
  return {
    content: content.value,
    objectType: objectType.value,
    articleTitle: articleTitle.value,
    articleSummary: articleSummary.value,
    spoilerText: spoilerText.value,
    showContentWarning: showCw.value,
    visibility: selectedVisibility.value.value as import('@/types/mastodon').StatusVisibility,
    language: selectedLanguage.value.code,
    sensitive: compose.sensitive,
    quotePolicy: compose.quotePolicy,
    mediaAttachments: [...compose.mediaAttachments],
    showPoll: compose.showPoll,
    pollOptions: [...compose.pollOptions],
    pollExpiresIn: compose.pollExpiresIn,
    pollMultiple: compose.pollMultiple,
    inReplyToId: compose.inReplyToId,
    inReplyToStatus: compose.inReplyToStatus,
    quoteId: compose.quoteId,
    quoteStatus: compose.quoteStatus,
  }
}

const canSaveDraft = computed(() => !isEditing.value && hasDraftContent(draftSnapshot()))

async function saveDraftNow() {
  if (isEditing.value || isHydratingDraft.value) return null
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  const saved = await drafts.save(draftSnapshot())
  draftSavedAt.value = saved?.updatedAt ?? null
  return saved
}

function finishDraftSession() {
  if (draftSessionFinished) return
  draftSessionFinished = true
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  if (!isEditing.value && compose.publishedTick === mountedPublishedTick) {
    void saveDraftNow()
  }
  drafts.startFresh()
  compose.reset()
  generatedArticleMediaMarkdown.clear()
  content.value = ''
  objectType.value = 'Note'
  articleTitle.value = ''
  articleSummary.value = ''
  spoilerText.value = ''
  showCw.value = false
  draftSavedAt.value = null
  showDraftMenu.value = false
}

function scheduleDraftSave() {
  if (draftSessionFinished || isEditing.value || isHydratingDraft.value) return
  draftSavedAt.value = null
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    void saveDraftNow()
  }, AUTOSAVE_DELAY_MS)
}

async function loadDraft(id: string) {
  await saveDraftNow()
  const draft = drafts.drafts.find((item) => item.id === id)
  if (!draft) return
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }

  isHydratingDraft.value = true
  compose.reset()
  generatedArticleMediaMarkdown.clear()
  drafts.select(id)
  content.value = draft.content
  objectType.value = draft.objectType
  articleTitle.value = draft.articleTitle
  articleSummary.value = draft.articleSummary
  spoilerText.value = draft.spoilerText
  showCw.value = draft.showContentWarning
  selectedVisibility.value = visibilityOptions.find(option => option.value === draft.visibility)
    ?? visibilityOptions[0]!
  selectedLanguage.value = languageOptions.find(option => option.code === draft.language)
    ?? languageOptions[1]!
  compose.sensitive = draft.sensitive
  compose.quotePolicy = draft.quotePolicy
  compose.mediaAttachments = draft.mediaAttachments.map(media => ({ ...media }))
  compose.showPoll = draft.showPoll
  compose.pollOptions = [...draft.pollOptions]
  compose.pollExpiresIn = draft.pollExpiresIn
  compose.pollMultiple = draft.pollMultiple
  compose.inReplyToId = draft.inReplyToId
  compose.inReplyToStatus = null
  compose.quoteId = draft.quoteId
  compose.quoteStatus = null
  draftSavedAt.value = draft.updatedAt
  showDraftMenu.value = false

  nextTick(() => {
    isHydratingDraft.value = false
    textareaRef.value?.focus()
  })
}

async function removeDraft(id: string) {
  await drafts.remove(id)
  if (drafts.activeDraftId === null) draftSavedAt.value = null
}

function draftTitle(draft: ComposeDraft): string {
  return draft.articleTitle.trim()
    || draft.content.trim().split(/\r?\n/, 1)[0]?.slice(0, 80)
    || t('compose.untitled_draft')
}

function formatDraftDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

watch(
  () => ({
    content: content.value,
    objectType: objectType.value,
    articleTitle: articleTitle.value,
    articleSummary: articleSummary.value,
    spoilerText: spoilerText.value,
    showCw: showCw.value,
    visibility: selectedVisibility.value.value,
    language: selectedLanguage.value.code,
    sensitive: compose.sensitive,
    quotePolicy: compose.quotePolicy,
    mediaAttachments: compose.mediaAttachments,
    showPoll: compose.showPoll,
    pollOptions: compose.pollOptions,
    pollExpiresIn: compose.pollExpiresIn,
    pollMultiple: compose.pollMultiple,
    inReplyToId: compose.inReplyToId,
    quoteId: compose.quoteId,
    draftAccountId: drafts.accountId,
  }),
  scheduleDraftSave,
  { deep: true },
)

function loadEditingDraft() {
  if (!compose.editingId) return
  content.value = compose.text
  objectType.value = compose.objectType
  articleTitle.value = compose.title
  articleSummary.value = compose.articleSummary
  spoilerText.value = compose.contentWarning
  showCw.value = compose.showContentWarning
  selectedVisibility.value = visibilityOptions.find(option => option.value === compose.visibility)
    ?? visibilityOptions[0]!
  selectedLanguage.value = languageOptions.find(option => option.code === compose.language)
    ?? languageOptions[1]!
}

watch(() => compose.editingId, (editingId) => {
  if (editingId) {
    generatedArticleMediaMarkdown.clear()
    loadEditingDraft()
  } else {
    content.value = ''
    objectType.value = 'Note'
    articleTitle.value = ''
    articleSummary.value = ''
    spoilerText.value = ''
    showCw.value = false
  }
}, { immediate: true })

const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0
    || compose.mediaAttachments.length > 0
    || Boolean(compose.quoteId)
  const validTitle = objectType.value !== 'Article'
    || (articleTitle.value.trim().length > 0 && articleTitle.value.length <= 200)
  return hasContent && validTitle && charsRemaining.value >= 0 && !compose.uploading
})

async function selectObjectType(type: 'Note' | 'Article') {
  objectType.value = type
  if (type === 'Article') {
    if (compose.showPoll) togglePoll()
    showCw.value = false
    for (const media of [...compose.mediaAttachments]) {
      const descriptionResult = media.description_generation_status === 'pending'
        ? compose.waitForMediaDescription(media.id)
        : null
      const insertedMarkdown = insertArticleMedia(media)
      if (descriptionResult) {
        trackGeneratedArticleDescription(descriptionResult, insertedMarkdown)
      } else if (
        media.description_generation_status === 'complete'
        && media.description
      ) {
        generatedArticleMediaMarkdown.set(media.id, insertedMarkdown)
      }
      await nextTick()
    }
  }
}

function togglePoll() {
  if (compose.showPoll) {
    compose.showPoll = false
    compose.pollOptions = []
  } else {
    compose.showPoll = true
    compose.pollOptions = ['', '']
  }
}

function triggerFileInput() {
  fileInput.value?.click()
}

async function onFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return

  for (const file of Array.from(input.files)) {
    if (compose.mediaAttachments.length >= 4) break
    await addComposerMedia(file)
  }

  // Reset input so the same file can be re-selected
  input.value = ''
}

// ── ALT text editor ─────────────────────────────────────────────────
const altEditMedia = ref<MediaAttachment | null>(null)
const altEditText = ref('')
const altEditDirty = ref(false)
const altSaving = ref(false)

function openAltEditor(media: MediaAttachment) {
  if (altSaving.value) return
  altEditMedia.value = media
  altEditText.value = media.description || ''
  altEditDirty.value = false
}

function altGenerationFailureMessage(media: MediaAttachment) {
  if (media.description_generation_error === 'rate_limited') {
    return t('compose.alt_generation_rate_limited')
  }
  if (media.description_generation_error === 'rate_limiter_unavailable') {
    return t('compose.alt_generation_unavailable')
  }
  return t('compose.alt_generation_failed')
}

function onAltInput() {
  if (!altEditMedia.value || altEditDirty.value) return
  altEditDirty.value = true
  compose.markMediaDescriptionEdited(altEditMedia.value.id)
}

function closeAltEditor() {
  if (altSaving.value) return
  if (altEditMedia.value && altEditDirty.value) {
    compose.resumeMediaDescriptionPolling(altEditMedia.value.id)
  }
  altEditMedia.value = null
  altEditDirty.value = false
}

async function saveAlt() {
  if (!altEditMedia.value || !auth.token || altSaving.value) return
  const media = altEditMedia.value
  const mediaId = media.id
  altEditDirty.value = true
  altSaving.value = true
  compose.markMediaDescriptionEdited(mediaId)
  try {
    const { data } = await updateMedia(
      mediaId,
      { description: altEditText.value },
      auth.token,
    )
    Object.assign(media, data)
    compose.markMediaDescriptionReviewed(mediaId)
    if (altEditMedia.value === media) {
      altEditMedia.value = null
      altEditDirty.value = false
    }
  } catch {
    // Keep the editor and the author's text open so a transient failure can
    // be retried without allowing a polling response to replace their input.
  } finally {
    altSaving.value = false
  }
}

watch(
  () => altEditMedia.value?.description,
  (description) => {
    if (!altEditDirty.value) altEditText.value = description || ''
  },
)

/** Handle paste events — if clipboard contains images, upload them */
async function onPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
      event.preventDefault()
      const file = item.getAsFile()
      if (file && compose.mediaAttachments.length < 4) {
        await addComposerMedia(file)
      }
    }
  }
}

/** Handle drag & drop of files */
async function onDrop(event: DragEvent) {
  const files = event.dataTransfer?.files
  if (!files) return

  for (const file of Array.from(files)) {
    if (compose.mediaAttachments.length >= 4) break
    if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')) {
      await addComposerMedia(file)
    }
  }
}

function submit() {
  if (!canSubmit.value) return
  emit('submit', {
    content: content.value,
    object_type: objectType.value,
    title: objectType.value === 'Article' ? articleTitle.value.trim() : undefined,
    summary: objectType.value === 'Article' ? articleSummary.value.trim() || undefined : undefined,
    spoiler_text: showCw.value ? spoilerText.value : '',
    visibility: selectedVisibility.value.value,
    language: selectedLanguage.value.code,
    in_reply_to_id: props.replyTo?.id ?? compose.inReplyToId ?? undefined,
    quote_id: compose.quoteId ?? undefined,
    quote_policy: compose.quotePolicy,
    media_ids: compose.mediaAttachments.map(m => m.id),
    draft_id: drafts.activeDraftId ?? undefined,
  })
  // Draft is NOT cleared here — publishing may still fail. The compose
  // store bumps publishedTick only on success (its reset() clears media
  // and quote state), and the watcher below clears the local fields then.
}

watch(() => compose.publishedTick, () => {
  generatedArticleMediaMarkdown.clear()
  content.value = ''
  objectType.value = 'Note'
  articleTitle.value = ''
  articleSummary.value = ''
  spoilerText.value = ''
  showCw.value = false
})
</script>

<template>
  <form
    @submit.prevent="submit"
    class="border-b border-outline dark:border-outline-dark last:border-b-0 px-4 py-4 bg-transparent text-slate-900 dark:text-slate-100"
  >
    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*,video/*,audio/*,.webp,.gif"
      multiple
      class="hidden"
      @change="onFileSelect"
    />

    <div class="flex flex-wrap items-center gap-2 mb-3">
      <!-- Visibility selector -->
      <Listbox v-model="selectedVisibility" :disabled="isEditing">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.visibility.label')"
            :title="t('compose.visibility.label')"
          >
            <span>{{ selectedVisibility.icon }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.post_visibility_label') }}</span>
              <span class="font-semibold">{{ t(selectedVisibility.label) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 w-56"
          >
            <ListboxOption
              v-for="option in visibilityOptions"
              :key="option.value"
              v-slot="{ active, selected }"
              :value="option"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
                ]"
              >
                <span>{{ option.icon }}</span>
                <span>{{ t(option.label) }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>

      <!-- Quote policy selector -->
      <Listbox v-model="compose.quotePolicy" :disabled="isEditing">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.quote_policy.label')"
            :title="t('compose.quote_policy.label')"
          >
            <span>{{ quotePolicyIcons[compose.quotePolicy] }}</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.quote_permission_label') }}</span>
              <span class="font-semibold">{{ t(`compose.quote_policy.${compose.quotePolicy}`) }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 w-52"
          >
            <ListboxOption
              v-for="opt in quotePolicyOptions"
              :key="opt.value"
              v-slot="{ active, selected }"
              :value="opt.value"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
                ]"
              >
                <span>{{ quotePolicyIcons[opt.value] }}</span>
                <span>{{ t(opt.label) }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>

      <!-- Language selector -->
      <Listbox v-model="selectedLanguage" :disabled="isEditing">
        <div class="relative">
          <ListboxButton
            class="inline-flex items-center gap-2 rounded-xl border border-outline bg-surface px-3 py-1.5 text-sm text-slate-700 shadow-soft transition-all hover:border-brand-300 hover:bg-brand-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-200 dark:hover:border-brand-700 dark:hover:bg-brand-950/30"
            :aria-label="t('compose.language')"
            :title="t('compose.language')"
          >
            <span>文</span>
            <span class="inline-flex flex-col items-start leading-tight">
              <span class="text-[11px] font-medium text-slate-400 dark:text-slate-500">{{ t('compose.post_language_label') }}</span>
              <span class="font-semibold">{{ selectedLanguage.label }}</span>
            </span>
          </ListboxButton>
          <ListboxOptions
            class="sb-menu absolute left-0 top-full z-20 mt-1.5 max-h-56 w-44 overflow-auto"
          >
            <ListboxOption
              v-for="lang in languageOptions"
              :key="lang.code"
              v-slot="{ active, selected }"
              :value="lang"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                :class="[
                  active ? 'bg-surface-2 dark:bg-white/5' : '',
                  selected ? 'font-semibold text-brand-600 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
                ]"
              >
                <span class="w-6 font-mono text-xs uppercase text-slate-400 dark:text-slate-500">{{ lang.code }}</span>
                <span>{{ lang.label }}</span>
              </button>
            </ListboxOption>
          </ListboxOptions>
        </div>
      </Listbox>

      <!-- Twitter-style drafts affordance, pinned to the right of the compose controls. -->
      <button
        v-if="!isEditing"
        type="button"
        data-testid="draft-menu-button"
        class="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-bold text-brand-600 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:text-brand-400 dark:hover:bg-brand-950/40"
        :aria-expanded="showDraftMenu"
        @click="showDraftMenu = true"
      >
        <span>{{ t('compose.drafts') }}</span>
        <span v-if="drafts.count" class="min-w-5 rounded-full bg-brand-100 px-1.5 py-0.5 text-center text-[11px] leading-4 text-brand-700 dark:bg-brand-950 dark:text-brand-300">{{ drafts.count }}</span>
      </button>
    </div>

    <!-- Explicit post type selector: visible in every composer layout. -->
    <fieldset class="mb-3 disabled:cursor-not-allowed disabled:opacity-60" :disabled="isEditing">
      <legend class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {{ t('compose.post_type') }}
      </legend>
      <div class="grid grid-cols-2 gap-2" role="radiogroup" :aria-label="t('compose.post_type')">
        <button
          type="button"
          role="radio"
          :aria-checked="objectType === 'Note'"
          :disabled="isEditing"
          data-testid="compose-type-note"
          class="rounded-xl border px-3 py-2.5 text-left transition"
          :class="objectType === 'Note'
            ? 'border-brand-500 bg-brand-50 text-brand-800 ring-2 ring-brand-500/20 dark:bg-brand-950/40 dark:text-brand-200'
            : 'border-outline bg-surface text-slate-600 hover:border-brand-300 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-300'"
          @click="selectObjectType('Note')"
        >
          <span class="block text-sm font-bold">{{ t('compose.note_type') }}</span>
          <span class="mt-0.5 block text-xs opacity-75">{{ t('compose.note_type_description') }}</span>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="objectType === 'Article'"
          :disabled="isEditing"
          data-testid="compose-type-article"
          class="rounded-xl border px-3 py-2.5 text-left transition"
          :class="objectType === 'Article'
            ? 'border-brand-500 bg-brand-50 text-brand-800 ring-2 ring-brand-500/20 dark:bg-brand-950/40 dark:text-brand-200'
            : 'border-outline bg-surface text-slate-600 hover:border-brand-300 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-300'"
          @click="selectObjectType('Article')"
        >
          <span class="block text-sm font-bold">{{ t('compose.article_type') }}</span>
          <span class="mt-0.5 block text-xs opacity-75">{{ t('compose.article_type_description') }}</span>
        </button>
      </div>
    </fieldset>

    <!-- Reply indicator -->
    <div v-if="replyTo" class="mb-2 text-sm text-slate-500 dark:text-slate-400">
      {{ t('compose.replying_to', { name: `@${replyTo.account.acct}` }) }}
    </div>

    <div v-if="objectType === 'Article'" class="mb-2">
      <input
        v-model="articleTitle"
        type="text"
        maxlength="200"
        :placeholder="t('compose.article_title_placeholder')"
        class="w-full rounded-xl border border-outline bg-surface px-3.5 py-3 text-xl font-bold text-slate-950 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-white dark:placeholder:text-slate-500"
      />
      <div class="mt-1 text-right text-xs tabular-nums text-slate-400">{{ articleTitle.length }}/200</div>
      <textarea
        v-model="articleSummary"
        rows="2"
        maxlength="500"
        :placeholder="t('compose.article_summary_placeholder')"
        class="mt-2 w-full resize-none rounded-xl border border-outline bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-slate-900 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100 dark:placeholder:text-slate-500"
      />
      <div class="mt-1 text-right text-xs tabular-nums text-slate-400">{{ articleSummary.length }}/500</div>
    </div>

    <!-- CW input -->
    <input
      v-if="objectType !== 'Article' && showCw"
      v-model="spoilerText"
      type="text"
      :placeholder="t('compose.cw_placeholder')"
      class="mb-2 w-full rounded-xl border border-amber-300 bg-amber-50/70 px-3.5 py-2.5 text-sm text-slate-900 transition placeholder:text-amber-700/60 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-slate-100 dark:placeholder:text-amber-300/60"
    />

    <!-- Main textarea with autocomplete container -->
    <div class="relative">
      <textarea
        ref="textareaRef"
        v-model="content"
        :placeholder="objectType === 'Article' ? t('compose.article_body_placeholder') : t('compose.placeholder')"
        rows="5"
        class="w-full resize-none rounded-xl border border-outline bg-surface px-3.5 py-3 text-base leading-relaxed text-slate-900 transition placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100 dark:placeholder:text-slate-500"
        @paste="onPaste"
        @drop.prevent="onDrop"
        @dragover.prevent
        :aria-label="objectType === 'Article' ? t('compose.article_body_placeholder') : t('compose.placeholder')"
        @input="onTextareaInput"
        @keydown="onTextareaKeydown"
      />

      <div v-if="objectType === 'Article'" class="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
        {{ t('compose.article_markdown_help') }}
      </div>

      <!-- Autocomplete dropdown -->
      <div
        v-if="autocompleteVisible && autocompleteItems.length > 0"
        ref="autocompleteRef"
        class="sb-menu absolute left-0 right-0 bottom-full z-20 mb-1.5 max-h-52 overflow-y-auto"
      >
        <button
          v-for="(item, idx) in autocompleteItems"
          :key="item.key"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
          :class="idx === autocompleteIndex
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
            : 'text-slate-700 dark:text-slate-300'"
          @click="selectAutocompleteItem(item)"
          @mouseenter="autocompleteIndex = idx"
        >
          <img
            v-if="item.image"
            :src="item.image"
            :alt="item.label"
            class="h-6 w-6 flex-shrink-0 rounded-md object-cover"
            loading="lazy"
          />
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="truncate text-xs text-slate-400 dark:text-slate-500">{{ item.sublabel }}</span>
        </button>
      </div>
    </div>

    <!-- Media previews -->
    <div v-if="compose.mediaAttachments.length > 0" class="flex gap-2 mt-2 flex-wrap">
      <div
        v-for="media in compose.mediaAttachments"
        :key="media.id"
        class="group relative h-24 w-24 overflow-hidden rounded-xl ring-1 ring-outline dark:ring-outline-dark"
      >
        <img
          v-if="media.type === 'image' || media.type === 'gifv'"
          :src="media.preview_url ?? media.url"
          :alt="media.description ?? ''"
          class="w-full h-full object-cover"
        />
        <div v-else class="flex h-full w-full items-center justify-center bg-surface-2 text-2xl dark:bg-surface-2-dark">
          {{ media.type === 'video' ? '🎬' : '🎵' }}
        </div>
        <!-- ALT button -->
        <button
          type="button"
          @click="openAltEditor(media)"
          class="absolute bottom-1 left-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide backdrop-blur-sm transition-opacity"
          :class="media.description_generation_status === 'pending'
            ? 'bg-slate-950/75 text-white opacity-100'
            : media.description_generation_status === 'failed'
              ? 'bg-red-600/95 text-white opacity-100'
            : media.description
              ? 'bg-brand-600/90 text-white opacity-95'
              : 'bg-slate-950/60 text-white opacity-0 group-hover:opacity-100'"
          :aria-live="media.description_generation_status === 'pending' || media.description_generation_status === 'failed' ? 'polite' : undefined"
          data-testid="media-alt-button"
        >
          <span
            v-if="media.description_generation_status === 'pending'"
            class="inline-flex items-center gap-1"
            data-testid="media-alt-generating"
          >
            <span class="h-2 w-2 animate-spin rounded-full border border-white/50 border-t-white" />
            {{ t('compose.alt_generating') }}
          </span>
          <span
            v-else-if="media.description_generation_status === 'failed'"
            data-testid="media-alt-failed"
          >
            ! {{ t('compose.alt_generation_failed_short') }}
          </span>
          <template v-else>ALT</template>
        </button>
        <!-- Remove button -->
        <button
          type="button"
          @click="compose.removeMedia(media.id)"
          class="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/60 text-xs text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-slate-950/80"
          :aria-label="t('common.remove')"
        >
          ✕
        </button>
      </div>
    </div>

    <p
      v-if="compose.hasUnreviewedGeneratedAltText"
      class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400"
      data-testid="generated-alt-notice"
    >
      {{ t('compose.alt_generated_notice') }}
    </p>

    <!-- Quote preview -->
    <div
      v-if="compose.quoteStatus"
      class="mt-3 rounded-xl border border-outline bg-surface-2/60 p-3 dark:border-outline-dark dark:bg-surface-2-dark/60"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-xs font-medium text-slate-500 dark:text-slate-400">
            @{{ compose.quoteStatus.account.acct }}
          </div>
          <div
            class="mt-1 text-sm text-slate-800 dark:text-slate-100 line-clamp-3"
            v-html="compose.quoteStatus.content"
          />
        </div>
        <button
          type="button"
          class="rounded-lg p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300"
          :aria-label="t('common.cancel')"
          @click="compose.clearQuote()"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- ALT text editor modal -->
    <div v-if="altEditMedia" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm" @click.self="closeAltEditor">
      <div class="sb-card mx-4 w-full max-w-md p-5" :aria-busy="altSaving">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="sb-heading text-sm">{{ t('compose.alt_text') }}</h3>
          <button type="button" @click="closeAltEditor" :disabled="altSaving" data-testid="media-alt-close" class="rounded-lg p-1 text-slate-400 transition-colors hover:bg-surface-2 hover:text-slate-600 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-slate-300">✕</button>
        </div>
        <img
          v-if="altEditMedia.type === 'image' || altEditMedia.type === 'gifv'"
          :src="altEditMedia.preview_url ?? altEditMedia.url"
          class="mb-3 h-40 w-full rounded-xl bg-surface-2 object-contain dark:bg-canvas-dark"
        />
        <p
          v-if="altEditMedia.description_generation_status === 'failed'"
          class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300"
          role="alert"
          data-testid="media-alt-failure-message"
        >
          {{ altGenerationFailureMessage(altEditMedia) }}
        </p>
        <textarea
          v-model="altEditText"
          @input="onAltInput"
          :disabled="altSaving"
          :placeholder="t('compose.alt_placeholder')"
          rows="3"
          class="sb-input resize-none"
          maxlength="1500"
        />
        <div class="mt-3 flex items-center justify-between">
          <span class="text-xs tabular-nums text-slate-400 dark:text-slate-500">{{ altEditText.length }}/1500</span>
          <button
            type="button"
            @click="saveAlt"
            :disabled="altSaving"
            class="sb-btn sb-btn-primary sb-btn-sm disabled:cursor-wait disabled:opacity-60"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Poll editor -->
    <div v-if="compose.showPoll" class="mt-3 space-y-2.5 rounded-xl border border-outline bg-surface-2/50 p-3.5 dark:border-outline-dark dark:bg-surface-2-dark/40">
      <div v-for="(_, idx) in compose.pollOptions" :key="idx" class="flex items-center gap-2">
        <span class="w-4 text-xs font-semibold tabular-nums text-slate-400 dark:text-slate-500">{{ idx + 1 }}</span>
        <input
          v-model="compose.pollOptions[idx]"
          type="text"
          :placeholder="t('compose.poll_option_placeholder', { n: idx + 1 })"
          maxlength="50"
          class="sb-input flex-1"
        />
        <button
          v-if="compose.pollOptions.length > 2"
          type="button"
          @click="compose.pollOptions.splice(idx, 1)"
          class="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      <button
        v-if="compose.pollOptions.length < 4"
        type="button"
        @click="compose.pollOptions.push('')"
        class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
      >
        + {{ t('compose.poll_add_option') }}
      </button>

      <div class="flex items-center gap-4 border-t border-outline pt-2.5 dark:border-outline-dark">
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input v-model="compose.pollMultiple" type="checkbox" class="h-4 w-4 rounded border-outline accent-brand-600 dark:border-outline-dark" />
          {{ t('compose.poll_multiple') }}
        </label>

        <select
          v-model.number="compose.pollExpiresIn"
          class="rounded-xl border border-outline bg-surface px-2.5 py-1.5 text-sm text-slate-900 transition focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-outline-dark dark:bg-surface-2-dark dark:text-slate-100"
        >
          <option :value="300">5 {{ t('compose.poll_minutes') }}</option>
          <option :value="1800">30 {{ t('compose.poll_minutes') }}</option>
          <option :value="3600">1 {{ t('compose.poll_hours') }}</option>
          <option :value="21600">6 {{ t('compose.poll_hours') }}</option>
          <option :value="43200">12 {{ t('compose.poll_hours') }}</option>
          <option :value="86400">1 {{ t('compose.poll_days') }}</option>
          <option :value="259200">3 {{ t('compose.poll_days') }}</option>
          <option :value="604800">7 {{ t('compose.poll_days') }}</option>
        </select>
      </div>
    </div>

    <!-- Upload progress -->
    <div v-if="compose.uploading" class="mt-2 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
      <svg class="h-4 w-4 animate-spin text-brand-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      {{ t('compose.uploading') }}
    </div>

    <!-- Toolbar -->
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-outline pt-3 dark:border-outline-dark">
      <div class="flex items-center gap-1.5 flex-wrap">
        <!-- Media upload -->
        <button
          type="button"
          @click="triggerFileInput"
          :disabled="compose.mediaAttachments.length >= 4 || compose.uploading || compose.showPoll"
          class="sb-btn sb-btn-ghost rounded-xl p-2 text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
          :aria-label="t('compose.add_media')"
          :title="t('compose.add_media')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 16l4.6-4.6a2 2 0 012.8 0L16 16m-2-2l1.6-1.6a2 2 0 012.8 0L20 14m-14 6h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2zm3-11h.01" /></svg>
        </button>

        <!-- CW toggle -->
        <button
          v-if="objectType !== 'Article'"
          type="button"
          @click="showCw = !showCw"
          class="sb-btn sb-btn-ghost rounded-xl p-2"
          :class="showCw
            ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
            : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
          :aria-label="t('compose.toggle_cw')"
          :title="t('compose.toggle_cw')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M12 9v4m0 4h.01M10.3 4.3L2.8 17.3A2 2 0 004.5 20h15a2 2 0 001.7-2.7L13.7 4.3a2 2 0 00-3.4 0z" /></svg>
        </button>

        <!-- Poll toggle -->
        <button
          v-if="objectType !== 'Article'"
          type="button"
          @click="togglePoll"
          :disabled="compose.mediaAttachments.length > 0"
          class="sb-btn sb-btn-ghost rounded-xl p-2"
          :class="compose.showPoll
            ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
            : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
          :aria-label="t('compose.poll_toggle')"
          :title="t('compose.poll_toggle')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M4 19V9m5 10V5m5 14v-7m5 7V8" /></svg>
        </button>

        <!-- Emoji picker -->
        <div class="relative" ref="emojiPickerRef">
          <button
            type="button"
            ref="emojiButtonRef"
            @click.stop="toggleEmojiPicker"
            class="sb-btn sb-btn-ghost rounded-xl p-2"
            :class="showEmojiPicker
              ? 'bg-brand-600 text-white shadow-soft hover:bg-brand-600 hover:text-white dark:bg-brand-500 dark:hover:bg-brand-500'
              : 'text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:text-brand-400 dark:hover:bg-brand-950/40 dark:hover:text-brand-300'"
            :aria-label="t('compose.emoji_picker')"
            :title="t('compose.emoji_picker')"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M15.2 15.2a4.5 4.5 0 01-6.4 0M9 9.5h.01M15 9.5h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </button>
          <Teleport to="body">
            <div
              v-if="showEmojiPicker"
              class="fixed z-[9999]"
              :style="emojiPickerPosition"
              @click.stop
            >
              <EmojiPicker @select="onEmojiSelect" />
            </div>
          </Teleport>
        </div>

        <!-- Media count -->
        <span v-if="compose.mediaAttachments.length > 0" class="sb-chip tabular-nums">
          {{ compose.mediaAttachments.length }}/4
        </span>
      </div>

      <div class="ml-auto flex items-center gap-2 sm:gap-3">
        <button
          v-if="!isEditing"
          type="button"
          data-testid="save-draft-button"
          :disabled="!canSaveDraft"
          class="sb-btn sb-btn-secondary"
          @click="saveDraftNow"
        >
          {{ draftSaveLabel }}
        </button>

        <!-- Char counter -->
        <span
          class="text-sm tabular-nums"
          :class="charsRemaining < 0 ? 'font-semibold text-red-500' : 'text-slate-400 dark:text-slate-500'"
        >
          {{ charsRemaining }}
        </span>

        <!-- Submit -->
        <button
          type="submit"
          :disabled="!canSubmit || compose.publishing"
          class="sb-btn sb-btn-primary"
        >
          <svg v-if="compose.publishing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          {{ isEditing ? t('status.edit') : t('compose.submit') }}
        </button>
      </div>
    </div>
  </form>

  <Teleport to="body">
    <TransitionRoot :show="showDraftMenu" as="template">
      <Dialog class="relative z-[90]" @close="showDraftMenu = false">
        <TransitionChild
          as="template"
          enter="ease-out duration-200"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="ease-in duration-150"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="fixed inset-0 bg-slate-950/45 backdrop-blur-[1px]" />
        </TransitionChild>

        <div class="fixed inset-0 overflow-y-auto p-0 sm:p-4">
          <div class="flex min-h-full items-start justify-center sm:items-center">
            <TransitionChild
              as="template"
              enter="ease-out duration-200"
              enter-from="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
              enter-to="translate-y-0 opacity-100 sm:scale-100"
              leave="ease-in duration-150"
              leave-from="translate-y-0 opacity-100 sm:scale-100"
              leave-to="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
            >
              <DialogPanel
                data-testid="drafts-modal"
                class="min-h-screen w-full overflow-hidden bg-surface text-slate-900 shadow-2xl sm:min-h-0 sm:max-w-xl sm:rounded-2xl dark:bg-surface-dark dark:text-slate-100"
              >
                <header class="flex h-14 items-center gap-3 border-b border-outline px-3 dark:border-outline-dark">
                  <button
                    type="button"
                    class="grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:hover:bg-white/10"
                    :aria-label="t('common.close')"
                    @click="showDraftMenu = false"
                  >
                    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path stroke-linecap="round" d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                  <div class="min-w-0 flex-1">
                    <DialogTitle class="truncate text-xl font-extrabold">{{ t('compose.drafts') }}</DialogTitle>
                    <p class="truncate text-xs text-slate-500 dark:text-slate-400">{{ t('compose.drafts_subtitle') }}</p>
                  </div>
                  <span v-if="drafts.count" class="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400">{{ drafts.count }}</span>
                </header>

                <div v-if="drafts.error" class="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                  {{ t('compose.draft_save_failed') }}
                </div>

                <div v-if="drafts.loading" class="flex items-center justify-center gap-2 px-4 py-12 text-sm text-slate-500 dark:text-slate-400">
                  <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  {{ t('compose.drafts_loading') }}
                </div>

                <p v-else-if="drafts.count === 0" class="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
                  {{ t('compose.no_drafts') }}
                </p>

                <ul v-else class="max-h-[calc(100vh-3.5rem)] divide-y divide-outline overflow-y-auto sm:max-h-[70vh] dark:divide-outline-dark">
                  <li v-for="draft in drafts.drafts" :key="draft.id" class="group flex items-stretch transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                    <button type="button" class="min-w-0 flex-1 px-5 py-4 text-left" @click="loadDraft(draft.id)">
                      <span class="mb-1 flex items-start gap-2">
                        <span
                          class="min-w-0 flex-1 text-[15px] text-slate-900 dark:text-white"
                          :class="draft.objectType === 'Article' ? 'truncate font-bold' : 'line-clamp-2 whitespace-pre-wrap leading-5'"
                        >
                          {{ draft.objectType === 'Article' ? draftTitle(draft) : (draft.content.trim() || draftTitle(draft)) }}
                        </span>
                        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:bg-white/10 dark:text-slate-400">
                          {{ draft.objectType === 'Article' ? t('compose.draft_article') : t('compose.draft_note') }}
                        </span>
                      </span>
                      <span v-if="draft.objectType === 'Article' && draft.content.trim()" class="line-clamp-2 block whitespace-pre-wrap text-sm leading-5 text-slate-600 dark:text-slate-300">{{ draft.content.trim() }}</span>
                      <span class="mt-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                        <span>{{ formatDraftDate(draft.updatedAt) }}</span>
                        <span v-if="draft.pendingSync">· {{ t('compose.draft_pending_sync') }}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="m-3 self-center rounded-full p-2.5 text-slate-400 opacity-70 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 group-hover:opacity-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                      :aria-label="t('compose.discard_draft')"
                      :title="t('compose.discard_draft')"
                      @click="removeDraft(draft.id)"
                    >
                      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673A2.25 2.25 0 0115.916 21H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </li>
                </ul>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </TransitionRoot>
  </Teleport>
</template>
