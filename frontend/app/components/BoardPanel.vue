<template>
  <div class="prod-content board-panel">
    <div class="prod-section-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.board.title') }}</span>
      <span v-if="segments.length" class="tag mono">{{ t('episode.board.stat', { scenes: groups.length, n: segments.length, dur: totalSeconds }) }}</span>
      <span v-if="segments.length" class="tag mono">{{ t('episode.board.approvedStat', { done: approvedCount, total: segments.length }) }}</span>
      <div class="ml-auto flex gap-1">
        <label v-if="segments.length" class="board-ref-toggle" :title="t('episode.board.referenceHint')">
          <input type="checkbox" :checked="boardReference" @change="emit('toggle-reference', $event.target.checked)">
          {{ t('episode.board.reference') }}
        </label>
        <button class="btn btn-sm" :disabled="busy || !hasScript" @click="emit('generate')">
          <Loader2 v-if="running" :size="11" class="animate-spin" />
          <Sparkles v-else :size="11" />
          {{ running ? progressLabel : (segments.length ? t('episode.board.regenerate') : t('episode.board.generate')) }}
        </button>
        <button v-if="segments.length" class="btn btn-sm" :disabled="busy" @click="emit('history')">
          <History :size="11" />
          {{ t('episode.sb.history') }}
        </button>
        <button v-if="segments.length" class="btn btn-sm" :disabled="!missingImageIds.length || batchStarting" @click="batchImages">
          <Loader2 v-if="batchStarting" :size="11" class="animate-spin" />
          <ImageIcon v-else :size="11" />
          {{ t('episode.board.batchImages', { n: missingImageIds.length }) }}
        </button>
      </div>
    </div>

    <!-- 资产先行：设定图是故事板出图的参考，缺图时提醒（不拦截） -->
    <div v-if="missingAssets.length" class="board-asset-banner">
      <span>{{ t('episode.board.missingAssets', { n: missingAssets.length, names: missingAssetNames }) }}</span>
      <button type="button" class="link-btn" @click="emit('goto-assets')">{{ t('episode.ref.gotoGenerate') }}</button>
    </div>

    <div v-if="!segments.length && running" class="step-loading">
      <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
      <div class="loading-text">{{ progressLabel }}</div>
    </div>
    <div v-else-if="!segments.length" class="step-empty">
      <div class="empty-visual"><LayoutPanelTop :size="32" :stroke-width="1.3" /></div>
      <div class="empty-title">{{ t('episode.board.emptyTitle') }}</div>
      <div class="empty-desc">{{ hasScript ? t('episode.board.emptyDesc') : t('episode.board.needScript') }}</div>
      <button class="btn btn-primary" :disabled="busy || !hasScript" @click="emit('generate')">
        <Sparkles :size="13" />
        {{ t('episode.board.generate') }}
      </button>
    </div>

    <div v-else class="board-scroll">
      <section v-for="group in groups" :key="group.key" class="board-scene">
        <header class="board-scene-head">
          <div class="board-scene-title">
            <span class="board-scene-no mono">{{ group.no }}</span>
            {{ group.heading }}
            <span class="dim mono">{{ group.seconds }}s</span>
          </div>
          <div v-if="group.summary" class="board-scene-summary">{{ group.summary }}</div>
        </header>

        <article v-for="sb in group.items" :key="sb.id" class="board-seg">
          <div class="board-seg-head">
            <strong>{{ t('episode.board.segment', { n: sb.part }) }}</strong>
            <span class="dim mono">#{{ sb.storyboard_number }} · {{ sb.duration }}s</span>
            <span v-if="sb.title" class="dim">{{ sb.title }}</span>
            <span v-if="sb.version" class="dim mono">{{ t('episode.board.versionN', { n: sb.version }) }}</span>
            <span :class="['tag', 'board-status', `is-${statusKey(sb)}`]">{{ t(`episode.board.status.${statusKey(sb)}`) }}</span>
            <span v-if="sb.status === 'approved' && sb.cleanStatus !== 'none'" :class="['board-clean', `is-${sb.cleanStatus}`]" :title="t('episode.board.cleanHint')">
              {{ t(`episode.board.clean.${sb.cleanStatus}`) }}
              <button v-if="sb.cleanStatus === 'failed'" type="button" class="link-btn" @click="review(sb, 'approved')">{{ t('episode.board.retry') }}</button>
            </span>
            <div class="ml-auto flex gap-1">
              <button class="btn btn-sm" :disabled="isGenerating(sb.id)" @click="genImage(sb)">
                <Loader2 v-if="isGenerating(sb.id)" :size="11" class="animate-spin" />
                <ImageIcon v-else :size="11" />
                {{ isGenerating(sb.id) ? t('episode.board.imaging') : (sb.imageUrl ? t('episode.board.reimage') : t('episode.board.image')) }}
              </button>
              <button v-if="sb.versionCount > 1" class="btn btn-sm" @click="openVersions(sb)">{{ t('episode.board.versions') }}</button>
              <button v-if="sb.imageUrl && sb.status !== 'approved'" class="btn btn-sm board-approve" @click="review(sb, 'approved')">
                <Check :size="11" /> {{ t('episode.board.approve') }}
              </button>
              <button v-if="sb.imageUrl && sb.status !== 'rejected'" class="btn btn-sm" @click="review(sb, 'rejected')">
                {{ t('episode.board.reject') }}
              </button>
              <button class="btn btn-sm" @click="startEdit(sb)">
                <Pencil :size="11" /> {{ t('episode.board.edit') }}
              </button>
            </div>
          </div>

          <div class="board-seg-body">
            <div class="board-image-col">
              <button v-if="sb.imageUrl" type="button" class="board-image" @click="emit('preview', mediaSrc(sb.imageUrl), `${group.no} · ${t('episode.board.segment', { n: sb.part })}`)">
                <img :src="thumbOf(mediaSrc(sb.imageUrl))" :alt="sb.title || ''" loading="lazy" @error="thumbFallback($event, mediaSrc(sb.imageUrl))">
              </button>
              <div v-else class="board-image board-image-empty">
                <LayoutPanelTop :size="22" :stroke-width="1.4" />
                <span>{{ isGenerating(sb.id) ? t('episode.board.imaging') : t('episode.board.noImage') }}</span>
              </div>
              <div v-if="sb.missingRefs.length" class="board-missing">
                {{ t('episode.board.missingRefs', { names: sb.missingRefs.join(t('common.listJoin')) }) }}
                <button type="button" class="link-btn" @click="emit('goto-assets')">{{ t('episode.ref.gotoGenerate') }}</button>
              </div>
              <div v-if="imageErrors[sb.id]" class="board-missing is-error">{{ imageErrors[sb.id] }}</div>
            </div>

            <div class="board-text">
              <div class="board-state"><span>{{ t('episode.board.start') }}</span>{{ sb.board.start_state }}</div>
              <div v-for="shot in sb.board.shots" :key="shot.no" class="board-shot">
                <div class="board-shot-head">
                  <strong>{{ t('episode.board.shotN', { n: shot.no }) }}</strong>
                  <span class="mono dim">{{ shot.start }}-{{ shot.end }}s</span>
                  <span>{{ [shot.size, shot.angle, shot.movement].filter(Boolean).join('｜') }}</span>
                </div>
                <div v-if="shot.purpose" class="board-purpose">{{ t('episode.board.purpose') }}{{ shot.purpose }}</div>
                <div v-for="beat in shot.beats" :key="beat.code" class="board-beat">
                  <span class="board-beat-code mono">{{ beat.code }}</span>
                  <div>
                    <div>{{ beat.action }}<span v-if="beat.camera" class="dim">（{{ beat.camera }}）</span></div>
                    <div v-if="beat.sound" class="dim">{{ t('episode.board.sound') }}{{ beat.sound }}</div>
                    <div v-if="beat.narration" class="board-line">{{ t('episode.board.narration') }}{{ beat.narration }}</div>
                    <div v-for="(d, i) in beat.dialogue || []" :key="i" class="board-line">{{ d.speaker }}：「{{ d.line }}」</div>
                  </div>
                </div>
              </div>
              <div class="board-state"><span>{{ t('episode.board.end') }}</span>{{ sb.board.end_state }}</div>
              <button type="button" class="link-btn" @click="togglePrompt(sb.id)">
                {{ openPrompts.includes(sb.id) ? t('episode.board.hidePrompt') : t('episode.board.showPrompt') }}
              </button>
              <pre v-if="openPrompts.includes(sb.id)" class="board-prompt">{{ sb.videoPrompt || '—' }}</pre>
            </div>
          </div>
        </article>
      </section>
    </div>

    <!-- 编辑故事板 -->
    <div v-if="editing" class="overlay" @click.self="editing = null">
      <div class="dialog board-edit-dialog">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ t('episode.board.editTitle', { n: editing.storyboard_number }) }}</h2>
          <button class="btn btn-ghost btn-icon" @click="editing = null"><X :size="14" /></button>
        </header>
        <div class="dialog-body board-edit-body">
          <label class="board-field">
            <span>{{ t('episode.board.start') }}</span>
            <textarea v-model="editing.board.start_state" rows="2" />
          </label>
          <div v-for="shot in editing.board.shots" :key="shot.no" class="board-edit-shot">
            <div class="board-edit-row">
              <strong>{{ t('episode.board.shotN', { n: shot.no }) }}</strong>
              <input v-model.number="shot.start" type="number" min="0" class="board-num"> -
              <input v-model.number="shot.end" type="number" min="1" class="board-num"> s
              <input v-model="shot.size" :placeholder="t('episode.board.size')">
              <input v-model="shot.angle" :placeholder="t('episode.board.angle')">
              <input v-model="shot.movement" :placeholder="t('episode.board.movement')">
            </div>
            <input v-model="shot.purpose" class="board-wide" :placeholder="t('episode.board.purpose')">
            <div v-for="beat in shot.beats" :key="beat.code" class="board-edit-beat">
              <span class="board-beat-code mono">{{ beat.code }}</span>
              <div class="board-edit-beat-fields">
                <textarea v-model="beat.frame" rows="2" :placeholder="t('episode.board.frame')" />
                <textarea v-model="beat.action" rows="2" :placeholder="t('episode.board.action')" />
                <input v-model="beat.sound" :placeholder="t('episode.board.sound')">
                <input v-model="beat.narration" :placeholder="t('episode.board.narration')">
                <textarea v-model="beat.dialogueText" rows="2" :placeholder="t('episode.board.dialogueHint')" />
              </div>
            </div>
          </div>
          <label class="board-field">
            <span>{{ t('episode.board.end') }}</span>
            <textarea v-model="editing.board.end_state" rows="2" />
          </label>
          <p class="batch-video-note">{{ t('episode.board.editNote') }}</p>
        </div>
        <footer class="dialog-foot">
          <button class="btn" @click="editing = null">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="editSaving" @click="saveEdit">
            <Loader2 v-if="editSaving" :size="12" class="animate-spin" />
            {{ t('common.save') }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 版本切换 -->
    <div v-if="versionDialog.open" class="overlay" @click.self="versionDialog.open = false">
      <div class="dialog board-version-dialog">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ t('episode.board.versionsTitle', { n: versionDialog.sb?.storyboard_number }) }}</h2>
          <button class="btn btn-ghost btn-icon" @click="versionDialog.open = false"><X :size="14" /></button>
        </header>
        <div class="dialog-body board-version-grid">
          <div v-if="versionDialog.loading"><Loader2 :size="14" class="animate-spin" /></div>
          <div v-for="v in versionDialog.items" :key="v.id" :class="['board-version', { on: v.id === versionDialog.sb?.versionId }]">
            <img v-if="v.image_url" :src="thumbOf(mediaSrc(v.image_url))" alt="" @error="thumbFallback($event, mediaSrc(v.image_url))">
            <div v-else class="board-image-empty">{{ v.status === 'failed' ? t('episode.board.imageFailed') : t('episode.board.imaging') }}</div>
            <div class="board-version-foot">
              <span class="mono">{{ t('episode.board.versionN', { n: v.version }) }}</span>
              <button v-if="v.image_url && v.id !== versionDialog.sb?.versionId" class="btn btn-sm" @click="selectVersion(v)">{{ t('episode.board.useVersion') }}</button>
              <span v-else-if="v.id === versionDialog.sb?.versionId" class="tag">{{ t('episode.board.current') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Check, History, Image as ImageIcon, LayoutPanelTop, Loader2, Pencil, Sparkles, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { episodeAPI, storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { thumbOf, thumbFallback } from '~/composables/useMedia'

const props = defineProps({
  episodeId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  scenes: { type: Array, default: () => [] },
  characters: { type: Array, default: () => [] },
  propItems: { type: Array, default: () => [] },
  hasScript: { type: Boolean, default: false },
  running: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  progressLabel: { type: String, default: '' },
  boardReference: { type: Boolean, default: true },
  // 生图模型选择（顶栏）：{ model, configId }
  imageOptions: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['generate', 'history', 'refresh', 'preview', 'goto-assets', 'toggle-reference'])
const { t } = useI18n()

const scriptScenes = ref([])
async function loadScriptScenes() {
  try { scriptScenes.value = await episodeAPI.scriptScenes(props.episodeId) || [] } catch { scriptScenes.value = [] }
}
watch(() => [props.episodeId, props.storyboards.length, props.running], loadScriptScenes, { immediate: true })

function mediaSrc(raw) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

function parseBoard(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return null }
}

/** 段落视图：故事板 + 绑定素材缺图提示 + 版本数（版本数来自已出图次数，用于显示「版本」按钮） */
const segments = computed(() => {
  const counters = {}
  return props.storyboards
    .map(sb => ({ sb, board: parseBoard(sb.board) }))
    .filter(x => x.board)
    .map(({ sb, board }) => {
      const no = sb.script_scene || '—'
      counters[no] = (counters[no] || 0) + 1
      const scene = props.scenes.find(s => s.id === sb.scene_id)
      const chars = props.characters.filter(c => (sb.character_ids || []).includes(c.id))
      const prps = props.propItems.filter(p => (sb.prop_ids || []).includes(p.id))
      const missingRefs = [
        ...(scene && !scene.image_url ? [scene.location] : []),
        ...chars.filter(c => !c.image_url).map(c => c.name),
        ...prps.filter(p => !p.image_url).map(p => p.name),
      ]
      return {
        ...sb,
        board,
        part: counters[no],
        status: sb.board_status || 'draft',
        imageUrl: sb.board_image_url || '',
        versionId: sb.board_version_id || null,
        version: versionNumbers.value[sb.id]?.current || null,
        versionCount: versionNumbers.value[sb.id]?.count || (sb.board_image_url ? 1 : 0),
        cleanStatus: versionNumbers.value[sb.id]?.clean || 'none',
        videoPrompt: sb.video_prompt || '',
        missingRefs,
      }
    })
})

const groups = computed(() => {
  const map = new Map()
  for (const seg of segments.value) {
    const key = seg.script_scene || '—'
    if (!map.has(key)) {
      const info = scriptScenes.value.find(s => s.scene_no === key)
      map.set(key, { key, no: key, heading: info?.heading || '', summary: info?.summary || '', seconds: 0, items: [] })
    }
    const g = map.get(key)
    g.items.push(seg)
    g.seconds += Number(seg.duration || 0)
  }
  return [...map.values()]
})

/** 缺设定图的资产：已有故事板时只看各段绑定的素材，否则看本集全部资产 */
const missingAssets = computed(() => {
  const segs = segments.value
  const bound = (kind, id) => !segs.length || segs.some(s =>
    kind === 'scene' ? s.scene_id === id
      : kind === 'character' ? (s.character_ids || []).includes(id)
        : (s.prop_ids || []).includes(id))
  return [
    ...props.characters.filter(c => !c.image_url && bound('character', c.id)).map(c => c.name),
    ...props.scenes.filter(s => !s.image_url && bound('scene', s.id)).map(s => s.location),
    ...props.propItems.filter(p => !p.image_url && bound('prop', p.id)).map(p => p.name),
  ].filter(Boolean)
})
const missingAssetNames = computed(() => {
  const names = missingAssets.value
  return names.slice(0, 4).join(t('common.listJoin')) + (names.length > 4 ? '…' : '')
})

const totalSeconds = computed(() => segments.value.reduce((s, x) => s + Number(x.duration || 0), 0))
const approvedCount = computed(() => segments.value.filter(s => s.status === 'approved').length)
const missingImageIds = computed(() => segments.value.filter(s => !s.imageUrl && !isGenerating(s.id)).map(s => s.id))

function statusKey(seg) {
  if (seg.status === 'approved' || seg.status === 'rejected' || seg.status === 'pending') return seg.status
  return seg.imageUrl ? 'stale' : 'draft'
}

// ─── 版本信息（懒加载：出图、切换版本后刷新） ───
const versionNumbers = ref({})
async function loadVersionInfo(id) {
  try {
    const list = await storyboardAPI.boardVersions(id) || []
    const sb = props.storyboards.find(s => s.id === id)
    const current = list.find(v => v.id === sb?.board_version_id)
    versionNumbers.value = { ...versionNumbers.value, [id]: { count: list.filter(v => v.image_url).length, current: current?.version || null, clean: current?.clean_status || 'none', list } }
    return list
  } catch { return [] }
}
watch(() => props.storyboards.filter(s => s.board_image_url).map(s => `${s.id}:${s.board_version_id}`).join(','), () => {
  for (const sb of props.storyboards) if (sb.board_image_url) loadVersionInfo(sb.id)
}, { immediate: true })

// ─── 出图：每段一个生图任务，轮询该段最新版本直到出图或失败 ───
const generatingIds = ref([])
const imageErrors = ref({})
const batchStarting = ref(false)
function isGenerating(id) { return generatingIds.value.includes(id) }

async function followImage(id) {
  if (!generatingIds.value.includes(id)) generatingIds.value.push(id)
  try {
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 4000))
      const list = await loadVersionInfo(id)
      const latest = list[0]
      if (latest?.status === 'completed') { emit('refresh'); return }
      if (latest?.status === 'failed') {
        imageErrors.value = { ...imageErrors.value, [id]: latest.error || t('episode.board.imageFailed') }
        return
      }
    }
  } finally {
    generatingIds.value = generatingIds.value.filter(x => x !== id)
  }
}

async function genImage(seg) {
  if (isGenerating(seg.id)) return
  const { [seg.id]: _, ...rest } = imageErrors.value
  imageErrors.value = rest
  try {
    await storyboardAPI.boardImage(seg.id, props.imageOptions.model, props.imageOptions.configId)
    followImage(seg.id)
  } catch (e) { toastError(e) }
}

async function batchImages() {
  const ids = missingImageIds.value
  if (!ids.length) return
  batchStarting.value = true
  try {
    const res = await episodeAPI.boardImages(props.episodeId, ids, props.imageOptions.model, props.imageOptions.configId)
    for (const s of res?.started || []) followImage(s.storyboard_id)
    if (res?.failed?.length) toastError(res.failed[0].error)
    else toast.success(t('episode.board.batchStarted', { n: res?.started?.length || 0 }))
  } catch (e) {
    toastError(e)
  } finally {
    batchStarting.value = false
  }
}

// 页面刷新后：仍在出图中的段继续跟踪
watch(() => props.storyboards.map(s => s.id).join(','), async () => {
  for (const sb of props.storyboards) {
    if (!sb.board || isGenerating(sb.id)) continue
    const list = versionNumbers.value[sb.id]?.list || await loadVersionInfo(sb.id)
    if (list[0]?.status === 'processing') followImage(sb.id)
  }
}, { immediate: true })

async function review(seg, status) {
  try {
    await storyboardAPI.reviewBoard(seg.id, status)
    emit('refresh')
    if (status === 'approved') followClean(seg.id)
  } catch (e) { toastError(e) }
}

// 审核通过后后端自动生成净版关键帧图（视频参考用），轮询到出图或失败
async function followClean(id) {
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 4000))
    await loadVersionInfo(id)
    const clean = versionNumbers.value[id]?.clean
    if (clean && clean !== 'processing') return
  }
}

// ─── 版本切换 ───
const versionDialog = ref({ open: false, loading: false, sb: null, items: [] })
async function openVersions(seg) {
  versionDialog.value = { open: true, loading: true, sb: seg, items: [] }
  versionDialog.value.items = await loadVersionInfo(seg.id)
  versionDialog.value.loading = false
}
async function selectVersion(v) {
  try {
    await storyboardAPI.selectBoardVersion(versionDialog.value.sb.id, v.id)
    versionDialog.value.open = false
    emit('refresh')
  } catch (e) { toastError(e) }
}

// ─── 编辑故事板文字（保存后重新推导描述与视频提示词，状态回到待出图/需重出） ───
const editing = ref(null)
const editSaving = ref(false)
const openPrompts = ref([])
function togglePrompt(id) {
  openPrompts.value = openPrompts.value.includes(id) ? openPrompts.value.filter(x => x !== id) : [...openPrompts.value, id]
}

function startEdit(seg) {
  const board = JSON.parse(JSON.stringify(seg.board))
  for (const shot of board.shots) {
    for (const beat of shot.beats) beat.dialogueText = (beat.dialogue || []).map(d => `${d.speaker}：${d.line}`).join('\n')
  }
  editing.value = { id: seg.id, storyboard_number: seg.storyboard_number, board }
}

async function saveEdit() {
  const board = JSON.parse(JSON.stringify(editing.value.board))
  for (const shot of board.shots) {
    for (const beat of shot.beats) {
      const lines = String(beat.dialogueText || '').split('\n').map(l => l.trim()).filter(Boolean)
      beat.dialogue = lines.map((l) => {
        const m = l.match(/^([^：:]+)[：:]\s*(.+)$/)
        return m ? { speaker: m[1].trim(), line: m[2].trim() } : { speaker: '', line: l }
      }).filter(d => d.line)
      delete beat.dialogueText
      for (const k of ['frame', 'sound', 'narration', 'camera']) if (!beat[k]) delete beat[k]
    }
  }
  const duration = board.shots[board.shots.length - 1]?.end
  editSaving.value = true
  try {
    const res = await storyboardAPI.updateBoard(editing.value.id, board, { duration })
    if (res?.warnings?.length) toast.warning(t('episode.board.savedWithWarnings', { n: res.warnings.length }), { description: res.warnings.slice(0, 3).join('\n'), duration: 10000 })
    else toast.success(t('episode.board.saved'))
    editing.value = null
    emit('refresh')
  } catch (e) {
    toastError(e)
  } finally {
    editSaving.value = false
  }
}
</script>

<style scoped>
.board-panel { display: flex; flex-direction: column; min-height: 0; }
.board-ref-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); margin-right: 6px; cursor: pointer; }
.board-asset-banner { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; padding: 8px 12px; border-radius: var(--radius); background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); font-size: 12.5px; }
.board-scroll { flex: 1; overflow: auto; padding: 4px 2px 24px; display: flex; flex-direction: column; gap: 18px; }
.board-scene { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.board-scene-head { display: flex; flex-direction: column; gap: 4px; }
.board-scene-title { font-size: 15px; font-weight: 600; color: var(--text-0); display: flex; align-items: baseline; gap: 8px; }
.board-scene-no { font-size: 12px; padding: 1px 6px; border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent-text); }
.board-scene-summary { font-size: 12.5px; color: var(--text-2); }
.board-seg { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-base); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.board-seg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.board-status.is-approved { color: var(--tag-success-text); background: var(--success-bg); }
.board-status.is-pending { color: var(--tag-info-text); background: var(--info-bg); }
.board-status.is-rejected, .board-status.is-stale { color: var(--tag-warning-text); background: var(--warning-bg); }
.board-approve { color: var(--tag-success-text); }
.board-clean { font-size: 11.5px; color: var(--text-2); display: inline-flex; gap: 4px; align-items: center; }
.board-clean.is-completed { color: var(--tag-success-text); }
.board-clean.is-failed { color: var(--error); }
.board-seg-body { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 14px; }
@media (max-width: 1100px) { .board-seg-body { grid-template-columns: 1fr; } }
.board-image-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.board-image { display: block; width: 100%; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface-muted); cursor: zoom-in; }
.board-image img { display: block; width: 100%; height: auto; }
.board-image-empty { aspect-ratio: 21 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text-3); font-size: 12px; cursor: default; }
.board-missing { font-size: 12px; color: var(--warn-text); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.board-missing.is-error { color: var(--error); }
.board-text { font-size: 12.5px; line-height: 1.6; color: var(--text-1); display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.board-state { padding: 6px 10px; border-radius: var(--radius-sm); background: var(--info-bg); color: var(--text-1); }
.board-state span { font-weight: 600; margin-right: 4px; }
.board-shot { display: flex; flex-direction: column; gap: 4px; }
.board-shot-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.board-purpose { color: var(--text-2); }
.board-beat { display: grid; grid-template-columns: 28px 1fr; gap: 6px; }
.board-beat-code { font-size: 11px; font-weight: 600; color: var(--accent-text); padding-top: 2px; }
.board-line { color: var(--text-0); }
.board-prompt { white-space: pre-wrap; font-size: 12px; background: var(--surface-muted); border-radius: var(--radius-sm); padding: 8px 10px; margin: 0; max-height: 240px; overflow: auto; }
.link-btn { align-self: flex-start; background: none; border: 0; padding: 0; color: var(--accent-text); font-size: 12px; cursor: pointer; }
.board-edit-dialog { width: min(860px, 94vw); max-height: 88vh; display: flex; flex-direction: column; }
.board-edit-body { overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.board-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); }
.board-edit-shot { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.board-edit-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.board-edit-row input { flex: 1 1 120px; }
.board-edit-row .board-num { flex: 0 0 64px; width: 64px; min-width: 0; }
.board-wide { width: 100%; }
.board-edit-beat { display: grid; grid-template-columns: 28px 1fr; gap: 6px; }
.board-edit-beat-fields { display: flex; flex-direction: column; gap: 4px; }
.board-edit-body input, .board-edit-body textarea { font: inherit; font-size: 12.5px; padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-input); color: var(--text-0); resize: vertical; }
.board-version-dialog { width: min(900px, 94vw); }
.board-version-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; max-height: 70vh; overflow: auto; }
.board-version { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.board-version.on { border-color: var(--accent); }
.board-version img { display: block; width: 100%; }
.board-version-foot { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; font-size: 12px; }
</style>
