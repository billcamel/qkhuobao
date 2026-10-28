<template>
  <div class="char-voice" @click.stop @keydown.stop>
    <span class="char-voice-label">{{ t('episode.asset.voice.label') }}</span>
    <span class="char-voice-name" :class="{ dim: !voice }" :title="voice ? voice.name : ''">
      {{ voice ? voice.name : t('episode.asset.voice.unset') }}
    </span>
    <button
      v-if="clipUrl"
      type="button"
      class="btn btn-sm btn-ghost char-voice-icon"
      :title="t('episode.asset.voice.play')"
      @click="playerOpen = true"
    >
      <Play :size="12" />
    </button>
    <button
      v-if="voice"
      type="button"
      class="btn btn-sm"
      :title="hasImage ? '' : t('episode.asset.voice.needImage')"
      :disabled="!hasImage || generatingKey === 'bound'"
      @click="generateClip()"
    >
      <Loader2 v-if="generatingKey === 'bound'" :size="11" class="animate-spin" />
      {{ generatingKey === 'bound' ? t('episode.asset.voice.generatingClip') : (clipUrl ? t('episode.asset.voice.regenClip') : t('episode.asset.voice.generateClip')) }}
    </button>
    <button type="button" class="btn btn-sm" @click="openPicker">
      {{ voice ? t('episode.asset.voice.change') : t('episode.asset.voice.pick') }}
    </button>
    <button
      v-if="voice"
      type="button"
      class="btn btn-sm btn-ghost char-voice-icon"
      :title="t('episode.asset.voice.clear')"
      :disabled="clearing"
      @click="clearVoice"
    >
      <Loader2 v-if="clearing" :size="12" class="animate-spin" />
      <X v-else :size="12" />
    </button>

    <Teleport to="body">
      <div v-if="open" class="overlay" @click.self="open = false">
        <form class="dialog char-voice-dialog" @submit.prevent>
          <div class="dialog-head">
            <div>
              <div class="dialog-title">{{ t('episode.asset.voice.dialogTitle') }}</div>
              <div class="dialog-sub">{{ t('episode.asset.voice.dialogSub', { name: character?.name || '' }) }}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-icon" @click="open = false">
              <X :size="14" />
            </button>
          </div>
          <div class="dialog-body char-voice-body">
            <div v-if="loading" class="char-voice-empty">
              <Loader2 :size="14" class="animate-spin" />
              {{ t('common.loading') }}
            </div>
            <div v-else-if="!configured" class="char-voice-empty">
              <p>{{ t('episode.asset.voice.empty') }}</p>
              <button type="button" class="btn btn-primary btn-sm" @click="goSettings">{{ t('episode.asset.voice.goSettings') }}</button>
            </div>
            <template v-else>
              <input v-model="query" class="input" :placeholder="t('episode.asset.voice.search')" />
              <div v-if="query && !filteredGroups.length" class="dim char-voice-nomatch">{{ t('episode.asset.voice.noMatch') }}</div>
              <div class="char-voice-groups">
                <section v-for="group in filteredGroups" :key="group.config_id" class="char-voice-group">
                  <div class="char-voice-group-title">{{ group.name }} · {{ group.provider }}</div>
                  <div v-if="!group.voices.length" class="dim char-voice-nomatch">{{ t('episode.asset.voice.noMatch') }}</div>
                  <div v-for="item in group.voices" :key="`${group.config_id}-${item.voice_id}`" class="char-voice-option" :class="{ current: isCurrent(group, item) }">
                    <div class="char-voice-option-main">
                      <strong>{{ item.name }}</strong>
                      <span class="tag">{{ t(`episode.asset.voice.gender.${item.gender}`) }}</span>
                      <span v-if="isCurrent(group, item)" class="tag tag-accent">{{ t('episode.asset.voice.applied') }}</span>
                      <span class="dim char-voice-id">{{ item.voice_id }}</span>
                    </div>
                    <div class="char-voice-option-actions">
                      <button type="button" class="btn btn-sm" :disabled="!hasImage || generatingKey === previewKey(group, item)" :title="hasImage ? '' : t('episode.asset.voice.needImage')" @click="generateClip(group, item)">
                        <Loader2 v-if="generatingKey === previewKey(group, item)" :size="11" class="animate-spin" />
                        {{ t('episode.asset.voice.generateClip') }}
                      </button>
                      <button type="button" class="btn btn-sm btn-primary" :disabled="applyingKey === previewKey(group, item) || isCurrent(group, item)" @click="applyVoice(group, item)">
                        <Loader2 v-if="applyingKey === previewKey(group, item)" :size="11" class="animate-spin" />
                        {{ t('episode.asset.voice.apply') }}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
              <div class="char-voice-custom">
                <div class="char-voice-group-title">{{ t('episode.asset.voice.custom') }}</div>
                <div class="char-voice-custom-row">
                  <select v-model="customConfigId" class="input">
                    <option v-for="group in providers" :key="group.config_id" :value="group.config_id">{{ group.name }}</option>
                  </select>
                  <input v-model="customId" class="input" :placeholder="t('episode.asset.voice.customId')" />
                  <input v-model="customName" class="input" :placeholder="t('episode.asset.voice.customName')" />
                  <button type="button" class="btn btn-sm btn-primary" :disabled="!customId.trim() || applyingKey === 'custom'" @click="applyCustom">
                    <Loader2 v-if="applyingKey === 'custom'" :size="11" class="animate-spin" />
                    {{ t('episode.asset.voice.apply') }}
                  </button>
                </div>
                <p class="field-hint">{{ t('episode.asset.voice.customHint') }}</p>
              </div>
            </template>
          </div>
        </form>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="playerOpen" class="overlay" @click.self="playerOpen = false">
        <div class="dialog char-voice-player" role="dialog" aria-modal="true">
          <div class="dialog-head">
            <div class="dialog-title">{{ voice?.name || t('episode.asset.voice.play') }}</div>
            <button type="button" class="btn btn-ghost btn-icon" @click="playerOpen = false"><X :size="14" /></button>
          </div>
          <video v-if="clipUrl" class="char-voice-video" :src="mediaUrl(clipUrl)" controls autoplay playsinline />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Loader2, Play, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { characterVoiceAPI, taskAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps({
  character: { type: Object, required: true },
})
const emit = defineEmits(['updated'])
const { t } = useI18n()

const open = ref(false)
const loading = ref(false)
const configured = ref(false)
const providers = ref([])
const query = ref('')
const generatingKey = ref('')
const applyingKey = ref('')
const clearing = ref(false)
const playerOpen = ref(false)
const customConfigId = ref(null)
const customId = ref('')
const customName = ref('')
const voice = computed(() => {
  const c = props.character
  if (!c) return null
  if (c.voice?.voice_id) return c.voice
  const id = c.voice_id || c.voiceId
  const provider = c.voice_provider || c.voiceProvider
  if (!id || !provider) return null
  return {
    provider,
    voice_id: id,
    name: c.voice_name || c.voiceName || id,
    clip_url: c.voice_clip_url || c.voiceClipUrl || null,
    config_id: null,
  }
})

const clipUrl = computed(() => voice.value?.clip_url || props.character?.voice_clip_url || props.character?.voiceClipUrl || '')
const pendingTaskId = computed(() => Number(voice.value?.meta?.clip_task_id) || 0)
const hasImage = computed(() => !!(props.character?.image_url || props.character?.imageUrl || props.character?.local_path || props.character?.localPath))

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  return providers.value.map(group => ({
    ...group,
    voices: (group.voices || []).filter(item => {
      if (!q) return true
      return `${item.name} ${item.voice_id}`.toLowerCase().includes(q)
    }),
  })).filter(group => !q || group.voices.length)
})

function mediaUrl(raw) {
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function previewKey(group, item) {
  return `${group.config_id}:${item.voice_id}`
}

function isCurrent(group, item) {
  return voice.value?.provider === item.provider && voice.value?.voice_id === item.voice_id && (voice.value?.config_id == null || voice.value.config_id === group.config_id)
}

async function loadVoices() {
  loading.value = true
  try {
    const data = await characterVoiceAPI.list()
    configured.value = !!data?.configured
    providers.value = data?.providers || []
    if (!customConfigId.value && providers.value[0]) customConfigId.value = providers.value[0].config_id
  } catch (err) {
    configured.value = false
    providers.value = []
    toastError(err)
  } finally {
    loading.value = false
  }
}

function openPicker() {
  open.value = true
  query.value = ''
  loadVoices()
}

function goSettings() {
  open.value = false
  navigateTo('/settings')
}

async function applyVoice(group, item, key = previewKey(group, item)) {
  if (!props.character?.id) return
  applyingKey.value = key
  try {
    const updated = await characterVoiceAPI.set(props.character.id, {
      provider: item.provider || group.provider,
      voice_id: item.voice_id,
      voice_name: item.name,
      config_id: group.config_id,
    })
    emit('updated', updated)
    toast.success(t('episode.asset.voice.saved'))
  } catch (err) {
    toastError(err, { fallback: 'episode.asset.voice.saveFailed' })
  } finally {
    applyingKey.value = ''
  }
}

async function applyCustom() {
  const group = providers.value.find(item => item.config_id === Number(customConfigId.value)) || providers.value[0]
  if (!group || !customId.value.trim()) return
  await applyVoice(group, {
    provider: group.provider,
    voice_id: customId.value.trim(),
    name: customName.value.trim() || customId.value.trim(),
  }, 'custom')
}

let pollTimer = null
let pollingId = 0
let openWhenDone = false

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  pollingId = 0
}

function watchTask(taskId) {
  if (!taskId || pollingId === taskId) return
  pollingId = taskId
  generatingKey.value = 'bound'
  const tick = async () => {
    if (pollingId !== taskId) return
    try {
      const task = await taskAPI.get(taskId)
      if (task?.status === 'completed' || task?.status === 'failed') {
        generatingKey.value = ''
        pollingId = 0
        const updated = await characterVoiceAPI.get(props.character.id)
        emit('updated', updated)
        if (task.status === 'completed') {
          if (openWhenDone) playerOpen.value = true
          toast.success(t('episode.asset.voice.clipReady'))
        } else {
          toastError(task.errorMsg || task.error_msg, { fallback: 'episode.asset.voice.previewFailed' })
        }
        openWhenDone = false
        return
      }
    } catch { /* 下一轮再查 */ }
    pollTimer = setTimeout(tick, 4000)
  }
  tick()
}

async function generateClip(group, item) {
  if (!props.character?.id) return
  if (!hasImage.value) {
    toast.warning(t('episode.asset.voice.needImage'))
    return
  }
  const key = group && item ? previewKey(group, item) : 'bound'
  generatingKey.value = key
  openWhenDone = true
  try {
    const payload = group && item
      ? { provider: item.provider || group.provider, voice_id: item.voice_id, voice_name: item.name, config_id: group.config_id }
      : {}
    const res = await characterVoiceAPI.preview(props.character.id, payload)
    if (res?.character) emit('updated', res.character)
    if (res?.status === 'failed') {
      generatingKey.value = ''
      openWhenDone = false
      toastError(res.error, { fallback: 'episode.asset.voice.previewFailed' })
      return
    }
    if (res?.task_id) watchTask(res.task_id)
  } catch (err) {
    generatingKey.value = ''
    openWhenDone = false
    toastError(err, { fallback: 'episode.asset.voice.previewFailed' })
  }
}

watch(pendingTaskId, (id) => { if (id) watchTask(id) }, { immediate: true })
onBeforeUnmount(stopPoll)

async function clearVoice() {
  if (!props.character?.id) return
  clearing.value = true
  playerOpen.value = false
  try {
    const updated = await characterVoiceAPI.clear(props.character.id)
    emit('updated', updated)
    toast.success(t('episode.asset.voice.cleared'))
  } catch (err) {
    toastError(err, { fallback: 'episode.asset.voice.clearFailed' })
  } finally {
    clearing.value = false
  }
}

</script>

<style scoped>
.char-voice {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.char-voice-label {
  flex-shrink: 0;
  color: var(--text-3);
}
.char-voice-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}
.char-voice-icon { padding-inline: 6px; }
.char-voice-dialog { width: min(560px, calc(100vw - 32px)); }
.char-voice-body { display: flex; flex-direction: column; gap: 12px; }
.char-voice-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}
.char-voice-groups { display: flex; flex-direction: column; gap: 12px; max-height: 360px; overflow: auto; }
.char-voice-group-title { font-size: 12px; font-weight: 650; color: var(--text-2); margin-bottom: 6px; }
.char-voice-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.char-voice-option.current { background: var(--accent-bg); margin-inline: -8px; padding-inline: 8px; border-radius: var(--radius); }
.char-voice-option-main { min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.char-voice-option-main strong { font-size: 13px; }
.char-voice-id { font-size: 11px; }
.char-voice-option-actions { display: flex; gap: 6px; flex-shrink: 0; }
.char-voice-custom { display: flex; flex-direction: column; gap: 6px; }
.char-voice-custom-row { display: grid; grid-template-columns: 1.1fr 1fr 1fr auto; gap: 6px; }
.char-voice-nomatch { font-size: 12px; padding: 4px 0 8px; }
.char-voice-player { width: min(420px, calc(100vw - 32px)); }
.char-voice-video { width: 100%; max-height: 70vh; background: #000; display: block; }
.dialog-sub { margin-top: 2px; color: var(--text-3); font-size: 12px; }
@media (max-width: 640px) {
  .char-voice-custom-row { grid-template-columns: 1fr; }
  .char-voice-option { align-items: flex-start; flex-direction: column; }
}
</style>
