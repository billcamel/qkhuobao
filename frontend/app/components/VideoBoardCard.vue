<template>
  <section class="video-inspector-section vboard">
    <div class="video-inspector-prompt-head">
      <span class="video-inspector-label">{{ t('episode.board.title') }}</span>
      <span class="vboard-meta mono">{{ sceneLabel }}</span>
      <span :class="['tag', 'vboard-status', `is-${statusKey}`]">{{ t(`episode.board.status.${statusKey}`) }}</span>
      <span :class="['vboard-ref', `is-${refState}`]" :title="refHint">{{ refShort }}</span>
      <button type="button" class="btn btn-sm ml-auto" @click="emit('edit')">{{ t('episode.board.gotoEdit') }}</button>
    </div>

    <!-- 上下布局：故事板图占满宽度（图上文字可读）→ 镜头时间条 → 段首段尾衔接；逐拍内容见图与下方视频提示词 -->
    <button v-if="imageSrc" type="button" class="vboard-image" @click="emit('preview', imageSrc, sceneLabel)">
      <img :src="imageSrc" :alt="sb.title || ''" loading="lazy">
    </button>
    <div v-else class="vboard-image vboard-image-empty">
      <span>{{ t('episode.board.noImage') }}</span>
      <button type="button" class="link-btn" @click="emit('edit')">{{ t('episode.board.gotoImage') }}</button>
    </div>

    <!-- 镜头时间条：宽度按时长比例，对照视频时间轴 -->
    <div class="vboard-timeline" :title="t('episode.board.timelineHint')">
      <div
        v-for="shot in board.shots"
        :key="shot.no"
        class="vboard-seg"
        :style="{ flexGrow: Math.max(shot.end - shot.start, 0.5) }"
        :title="[shot.size, shot.angle, shot.movement].filter(Boolean).join(' · ')"
      >
        <span class="vboard-seg-head"><strong>{{ t('episode.board.shotN', { n: shot.no }) }}</strong><span class="mono">{{ shot.start }}-{{ shot.end }}s</span></span>
        <span class="vboard-seg-cam">{{ [shot.size, shot.movement].filter(Boolean).join(' · ') }}</span>
      </div>
    </div>
    <div class="vboard-states">
      <div class="vboard-state"><b>{{ t('episode.board.start') }}</b>{{ board.start_state }}</div>
      <div class="vboard-state"><b>{{ t('episode.board.end') }}</b>{{ board.end_state }}</div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const props = defineProps({
  sb: { type: Object, required: true },
  board: { type: Object, required: true },
  /** 「S02 · 第 2 段 · 第四道封锁线」这类定位文案 */
  sceneLabel: { type: String, default: '' },
})
const emit = defineEmits(['preview', 'edit'])
const { t } = useI18n()

const imageSrc = computed(() => {
  const raw = props.sb.board_image_url || ''
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
})

const statusKey = computed(() => {
  const s = props.sb.board_status
  if (s === 'approved' || s === 'rejected' || s === 'pending') return s
  return props.sb.board_image_url ? 'stale' : 'draft'
})

const refState = computed(() => props.sb.board_reference_state || 'not_approved')
const refShort = computed(() => t(`episode.board.refShort.${refState.value}`))
const refHint = computed(() => ({
  used: t('episode.board.refUsed'),
  not_approved: t('episode.board.refNotApproved'),
  clean_missing: t('episode.board.refCleanMissing'),
  off: t('episode.board.refOff'),
}[refState.value] || ''))
</script>

<style scoped>
.vboard .video-inspector-prompt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vboard-meta { font-size: 11.5px; color: var(--text-2); }
.vboard-status.is-approved { color: var(--tag-success-text); background: var(--success-bg); }
.vboard-status.is-pending { color: var(--tag-info-text); background: var(--info-bg); }
.vboard-status.is-rejected, .vboard-status.is-stale { color: var(--tag-warning-text); background: var(--warning-bg); }
.vboard-ref { font-size: 11px; padding: 1px 7px; border-radius: var(--radius-pill); background: var(--surface-muted); color: var(--text-2); }
.vboard-ref.is-used { background: var(--success-bg); color: var(--tag-success-text); }
.vboard-ref.is-clean_missing, .vboard-ref.is-not_approved { background: var(--warning-bg); color: var(--tag-warning-text); }
.vboard-image { display: block; width: 100%; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface-muted); cursor: zoom-in; }
.vboard-image img { display: block; width: 100%; height: auto; max-height: 440px; object-fit: contain; }
.vboard-image-empty { aspect-ratio: 21 / 9; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; color: var(--text-3); font-size: 12px; cursor: default; }
.vboard-timeline { display: flex; gap: 3px; }
.vboard-seg { flex-basis: 0; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent-text); font-size: 11.5px; line-height: 1.35; }
.vboard-seg-head { display: flex; gap: 6px; align-items: baseline; }
.vboard-seg-head strong { font-weight: 700; }
.vboard-seg-cam { color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vboard-states { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
@media (max-width: 1280px) { .vboard-states { grid-template-columns: 1fr; } }
.vboard-state { padding: 5px 9px; border-radius: var(--radius-sm); background: var(--info-bg); font-size: 12px; line-height: 1.5; color: var(--text-1); }
.vboard-state b { margin-right: 4px; }
.link-btn { background: none; border: 0; padding: 0; color: var(--accent-text); font-size: 12px; cursor: pointer; }
</style>
