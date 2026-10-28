<template>
  <div class="char-voice" @click.stop @keydown.stop>
    <span class="char-voice-label">{{ t('episode.asset.voice.label') }}</span>
    <span class="char-voice-name" :class="{ dim: !voice }" :title="voice ? voice.name : ''">
      {{ voice ? voice.name : t('episode.asset.voice.unset') }}
    </span>
    <button
      v-if="audioUrl"
      type="button"
      class="btn btn-sm btn-ghost char-voice-icon"
      :title="t('episode.asset.voice.playAudio')"
      @click="openPlayer('audio')"
    >
      <Play :size="12" />
    </button>
    <button
      v-if="clipUrl"
      type="button"
      class="btn btn-sm btn-ghost char-voice-icon"
      :title="t('episode.asset.voice.playClip')"
      @click="openPlayer('clip')"
    >
      <Clapperboard :size="12" />
    </button>
    <button
      v-if="hasImage"
      type="button"
      class="btn btn-sm"
      :title="t('episode.asset.voice.generateClip')"
      :disabled="generatingClip"
      @click="generateClip"
    >
      <Loader2 v-if="generatingClip" :size="11" class="animate-spin" />
      {{ generatingClip ? t('episode.asset.voice.generatingClip') : (clipUrl ? t('episode.asset.voice.regenClip') : t('episode.asset.voice.generateClip')) }}
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
            <div class="char-voice-actions">
              <button type="button" class="btn btn-sm" :disabled="uploading" @click="fileInput?.click()">
                <Loader2 v-if="uploading" :size="11" class="animate-spin" />
                {{ uploading ? t('episode.asset.voice.uploading') : t('episode.asset.voice.upload') }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="!hasImage || generatingAudio"
                :title="hasImage ? '' : t('episode.asset.voice.needImage')"
                @click="generateFromPortrait"
              >
                <Loader2 v-if="generatingAudio" :size="11" class="animate-spin" />
                {{ generatingAudio ? t('episode.asset.voice.generating') : t('episode.asset.voice.generateFromPortrait') }}
              </button>
            </div>
            <input
              ref="fileInput"
              class="char-voice-file"
              type="file"
              accept=".mp3,.wav,.m4a,.aac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac"
              @change="onFile"
            />
            <p class="field-hint">
              {{ t('episode.asset.voice.needTts') }}
              <button type="button" class="btn btn-ghost btn-sm" @click="goSettings">{{ t('episode.asset.voice.goSettings') }}</button>
            </p>
            <audio v-if="dialogAudio" class="char-voice-audio" :src="mediaUrl(dialogAudio)" controls autoplay />
            <div class="char-voice-group-title">{{ t('episode.asset.voice.library') }}</div>
            <div v-if="loading" class="char-voice-empty">
              <Loader2 :size="14" class="animate-spin" />
              {{ t('common.loading') }}
            </div>
            <p v-else-if="!library.length" class="dim char-voice-nomatch">{{ t('episode.asset.voice.libraryEmpty') }}</p>
            <div v-else class="char-voice-groups">
              <div v-for="item in library" :key="item.audio_url" class="char-voice-option" :class="{ current: isCurrent(item) }">
                <div class="char-voice-option-main">
                  <strong>{{ item.name }}</strong>
                  <span v-if="isCurrent(item)" class="tag tag-accent">{{ t('episode.asset.voice.current') }}</span>
                </div>
                <div class="char-voice-option-actions">
                  <button type="button" class="btn btn-sm btn-ghost char-voice-icon" :title="t('episode.asset.voice.playAudio')" @click="dialogAudio = item.audio_url">
                    <Play :size="12" />
                  </button>
                  <button type="button" class="btn btn-sm btn-primary" :disabled="applying === item.audio_url || isCurrent(item)" @click="applyLibrary(item)">
                    <Loader2 v-if="applying === item.audio_url" :size="11" class="animate-spin" />
                    {{ t('episode.asset.voice.use') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="playerOpen" class="overlay" @click.self="playerOpen = false">
        <div class="dialog char-voice-player" role="dialog" aria-modal="true">
          <div class="dialog-head">
            <div class="dialog-title">{{ voice?.name || t('episode.asset.voice.playAudio') }}</div>
            <button type="button" class="btn btn-ghost btn-icon" @click="playerOpen = false"><X :size="14" /></button>
          </div>
          <audio v-if="playerMode === 'audio' && audioUrl" class="char-voice-audio" :src="mediaUrl(audioUrl)" controls autoplay />
          <video v-else-if="clipUrl" class="char-voice-video" :src="mediaUrl(clipUrl)" controls autoplay playsinline />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Clapperboard, Loader2, Play, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { characterVoiceAPI, taskAPI, uploadAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps({
  character: { type: Object, required: true },
})
const emit = defineEmits(['updated'])
const { t } = useI18n()

const AUDIO_EXT = /\.(mp3|wav|m4a|aac)$/i
const open = ref(false)
const loading = ref(false)
const library = ref([])
const uploading = ref(false)
const generatingAudio = ref(false)
const generatingClip = ref(false)
const applying = ref('')
const clearing = ref(false)
const playerOpen = ref(false)
const playerMode = ref('audio')
const dialogAudio = ref('')
const fileInput = ref(null)

const voice = computed(() => {
  const c = props.character
  if (!c) return null
  const audio = c.voice?.audio_url || c.voice_preview_url || c.voicePreviewUrl || ''
  if (!audio) return null
  return {
    name: c.voice?.name || c.voice_name || c.voiceName || fileStem(audio),
    audio_url: audio,
    clip_url: c.voice?.clip_url || c.voice_clip_url || c.voiceClipUrl || null,
    source: c.voice?.source || null,
    meta: c.voice?.meta || null,
  }
})

const audioUrl = computed(() => voice.value?.audio_url || '')
const clipUrl = computed(() => voice.value?.clip_url || '')
const pendingTaskId = computed(() => Number(voice.value?.meta?.clip_task_id) || 0)
const hasImage = computed(() => !!(props.character?.image_url || props.character?.imageUrl || props.character?.local_path || props.character?.localPath))

function fileStem(raw) {
  const name = String(raw || '').split('/').pop() || ''
  return name.replace(/\.[^.]+$/, '') || t('episode.asset.voice.label')
}

function mediaUrl(raw) {
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function sameAudio(a, b) {
  return String(a || '').replace(/^\//, '') === String(b || '').replace(/^\//, '')
}

function isCurrent(item) {
  return sameAudio(audioUrl.value, item?.audio_url)
}

async function loadLibrary() {
  loading.value = true
  try {
    const data = await characterVoiceAPI.list()
    library.value = data?.items || []
  } catch (err) {
    library.value = []
    toastError(err)
  } finally {
    loading.value = false
  }
}

function openPicker() {
  open.value = true
  dialogAudio.value = ''
  loadLibrary()
}

function goSettings() {
  open.value = false
  navigateTo('/settings')
}

function openPlayer(mode) {
  playerMode.value = mode
  playerOpen.value = true
}

async function applySaved(updated) {
  if (updated) emit('updated', updated)
  toast.success(t('episode.asset.voice.saved'))
  open.value = false
}

async function onFile(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file || !props.character?.id) return
  if (!AUDIO_EXT.test(file.name || '')) {
    toast.warning(t('episode.asset.voice.fileInvalid'))
    return
  }
  uploading.value = true
  try {
    const uploaded = await uploadAPI.audio(file)
    const audioPath = uploaded?.path || uploaded?.url
    const updated = await characterVoiceAPI.set(props.character.id, {
      audio_url: audioPath,
      name: file.name,
      source: 'upload',
    })
    await applySaved(updated)
    loadLibrary()
  } catch (err) {
    toastError(err, { fallback: 'episode.asset.voice.saveFailed' })
  } finally {
    uploading.value = false
  }
}

async function applyLibrary(item) {
  if (!props.character?.id || !item?.audio_url) return
  applying.value = item.audio_url
  try {
    const updated = await characterVoiceAPI.set(props.character.id, {
      audio_url: item.audio_url,
      name: item.name,
      source: 'library',
    })
    await applySaved(updated)
  } catch (err) {
    toastError(err, { fallback: 'episode.asset.voice.saveFailed' })
  } finally {
    applying.value = ''
  }
}

let pollTimer = null
let pollingId = 0

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  pollingId = 0
}

function watchTask(taskId) {
  if (!taskId || pollingId === taskId) return
  pollingId = taskId
  generatingClip.value = true
  const tick = async () => {
    if (pollingId !== taskId) return
    try {
      const task = await taskAPI.get(taskId)
      if (task?.status === 'completed' || task?.status === 'failed') {
        generatingClip.value = false
        pollingId = 0
        const updated = await characterVoiceAPI.get(props.character.id)
        emit('updated', updated)
        if (task.status === 'completed') {
          openPlayer('clip')
          toast.success(t('episode.asset.voice.clipReady'))
        } else {
          toastError(task.errorMsg || task.error_msg, { fallback: 'episode.asset.voice.previewFailed' })
        }
        return
      }
    } catch { /* 下一轮再查 */ }
    pollTimer = setTimeout(tick, 4000)
  }
  tick()
}

async function generateFromPortrait() {
  if (!props.character?.id) return
  if (!hasImage.value) {
    toast.warning(t('episode.asset.voice.needImage'))
    return
  }
  generatingAudio.value = true
  try {
    const res = await characterVoiceAPI.generate(props.character.id)
    if (res?.character) {
      emit('updated', res.character)
      toast.success(t('episode.asset.voice.saved'))
    }
    open.value = false
    if (res?.clip_error) toastError(res.clip_error, { fallback: 'episode.asset.voice.previewFailed' })
    if (res?.status === 'failed') {
      toastError(res.error, { fallback: 'episode.asset.voice.previewFailed' })
      return
    }
    if (res?.task_id) watchTask(res.task_id)
  } catch (err) {
    toastError(err, { fallback: 'episode.asset.voice.generateFailed' })
  } finally {
    generatingAudio.value = false
  }
}

async function generateClip() {
  if (!props.character?.id) return
  if (!hasImage.value) {
    toast.warning(t('episode.asset.voice.needImage'))
    return
  }
  generatingClip.value = true
  try {
    const res = await characterVoiceAPI.preview(props.character.id)
    if (res?.character) emit('updated', res.character)
    if (res?.status === 'failed') {
      generatingClip.value = false
      toastError(res.error, { fallback: 'episode.asset.voice.previewFailed' })
      return
    }
    if (res?.task_id) watchTask(res.task_id)
    else generatingClip.value = false
  } catch (err) {
    generatingClip.value = false
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
  flex-wrap: wrap;
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
.char-voice-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.char-voice-file {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.char-voice-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
}
.char-voice-groups { display: flex; flex-direction: column; max-height: 280px; overflow: auto; }
.char-voice-group-title { font-size: 12px; font-weight: 650; color: var(--text-2); }
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
.char-voice-option-actions { display: flex; gap: 6px; flex-shrink: 0; }
.char-voice-nomatch { font-size: 12px; padding: 4px 0 8px; }
.char-voice-player { width: min(420px, calc(100vw - 32px)); }
.char-voice-audio { width: 100%; display: block; }
.char-voice-video { width: 100%; max-height: 70vh; background: #000; display: block; }
.dialog-sub { margin-top: 2px; color: var(--text-3); font-size: 12px; }
@media (max-width: 640px) {
  .char-voice-option { align-items: flex-start; flex-direction: column; }
}
</style>
