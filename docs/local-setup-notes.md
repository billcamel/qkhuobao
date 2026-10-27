# 本地化说明（qkhuobao 私有副本）

本文记录这台机器（`video-ai` / 192.168.100.114）对火宝短剧的本地化改动与运维约定。
上游：`chatfire-AI/huobao-drama`；本仓库：`billcamel/qkhuobao`。

## Git 约定

| remote | 地址 | 用途 |
|---|---|---|
| origin | `git@github.com:billcamel/qkhuobao.git` | 我们的改动都推这里 |
| upstream | `git@github.com:chatfire-AI/huobao-drama.git` | 只用来同步上游 |

```bash
# 日常
git add -A && git commit -m "<type>: <说明>" && git push
# 同步上游（可能冲突，冲突时优先保住我们的补丁）
git fetch upstream && git merge upstream/master
```

**必须用 SSH，不能用 HTTPS。** 这台机器上 `github.com:443` 被阻断（网页和 git 都连不上，连试 3 次全失败），但 `ssh.github.com:443` 通。
`~/.ssh/config` 里已把 `github.com` 指向 `ssh.github.com:443`，密钥为 `~/.ssh/id_ed25519_github`。
`api.github.com` 也通，所以 `gh` 的 API 类操作可用，但 `gh` 的 git 操作仍走上面的 SSH 通道。

### 代理（备用通道，已配好）

内网 HTTP 代理，两个都通，端口都是 7890：

| 地址 | 实测到 github.com |
|---|---|
| 192.168.100.240:7890 | 0.64s（默认用这个） |
| 192.168.100.166:7890 | 0.77s |

git 已按 host 配好（只对 github.com 生效，不影响别的站）：

```bash
git config --global --get-regexp proxy
# http.https://github.com/.proxy  http://192.168.100.240:7890
# https.https://github.com/.proxy http://192.168.100.240:7890
```

需要时临时给别的工具挂代理（gh / pip / curl）：

```bash
export HTTPS_PROXY=http://192.168.100.240:7890 HTTP_PROXY=http://192.168.100.240:7890
```

刻意**没有**写进 `~/.bashrc`：代理一旦不在线，全局 export 会把所有外网访问一起拖死。按需临时挂更安全。
两条通道（SSH-443、HTTPS-代理）现在都验证可用，其一挂掉就换另一条。


## 本地补丁清单（与上游的差异）

> 2026-10-27 更新到 `89c8dc3` 后：上游已原生实现参考图传递（`parseReferenceImages` → Ark `image` 字段），
> 我们之前的适配器补丁 **已废弃删除**，不要再重新打。

1. ~~`backend/src/services/adapters/volcengine-image.ts` 参考图补丁~~ —— 上游已原生支持，补丁下线。
2. **`backend/workspace/prompts/*.md`** — 每个 Agent 的前置模型（仍需要我们维护）：
   - `script_rewriter` → `deepseek-v4-pro`（长文连贯）
   - `extractor` / `storyboard_breaker` / `prompt_generator` → `deepseek-flash`（快而省）
3. **`scripts/start.sh`** — 单服务启动脚本（后端同时托管前端静态站，默认 5679）。

4. **Seedream 请求参数**（同在 `volcengine-image.ts`）：传 `size="宽x高"`（只传 width/height 时 Ark 会忽略、出方图）；
   不传 `sequential_image_generation`（seedream-5-0-flash 报 400）；不传 `watermark=false`，保留「AI生成」角标。
5. **故事板工作流**（制作环节：资产 → 故事板 → 视频；先定妆图再故事板，出图才能参考设定图，详见 CLAUDE.md「故事板」）：剧本场景 → 段 → 镜 → 拍，结构化故事板推导分镜描述与视频提示词；
   每段一张 Seedream 故事板图（版本 + 审核）；审核通过后自动生成去标注的「净版关键帧图」作视频第 1 张参考图。
   实测：带文字/箭头的故事板直接做视频参考，箭头会被画进视频开头；不挂故事板时构图与场景明显偏离设定图。
6. **文本 Agent 编排**：改写/提取/故事板/视频提示词改为落库异步任务（agent_tasks），以是否调用保存工具判定成败并做规则校验；
   重新生成故事板前自动留存快照，可恢复。
7. **稳健性**：生图结果下载对连接超时重试（实测 Ark TOS 偶发 10 秒连接超时会丢图）；API Key 含中文/空白时给出明确提示。

## 运行方式

- systemd 用户单元 `~/.config/systemd/user/huobao-drama.service`，开机自启、崩溃 5 秒后自动拉起
- 访问：http://192.168.100.114:5679 （仅内网）
- 日志：`journalctl --user -u huobao-drama -f`
- 别再手工跑 `scripts/start.sh`，会和 systemd 抢 5679 端口

## AI 模型接入

| 类型 | provider | 模型 | 备注 |
|---|---|---|---|
| 文本 | openai（OpenAI 兼容中转） | deepseek-flash / v4-pro / v3.2 / reasoner | 该中转只开通了 deepseek 与 qwen3，gemini/claude/gpt 全 401 |
| 图像 | volcengine（Ark） | doubao-seedream-5-0-flash-260915 | 720×1280，角标「AI生成」去不掉（合规标识） |
| 视频 | volcengine（Ark） | doubao-seedance-2-0-mini-260615 | 480p/720p、5~15 秒；fast 与完整版未开通（ModelNotOpen） |

已知限制与对策：

- **Seedance 不接收首帧**，只走多模态参考图，所以「从这张图开始动」做不到，只能靠参考图 + 提示词描述起始画面。
- **Ark 视频有真人隐私过滤**：拿 i2i 产出的高写实图当 `reference_image` 会被拒（`InputImageSensitiveContentDetected.PrivacyInformation`）。**纯文生图产出的定妆图能过**。所以：定妆图必须纯文生图，然后每个镜头都用它当参考。
  故事板图与净版关键帧图都是 i2i 产物：3D 漫剧风格实测能过；写实风格下若视频因 PrivacyInformation 被拒，生成任务会自动去掉故事板参考、只用定妆图重新提交（原任务标记 board_reference_fallback）；项目记下该风格（dramas.board_ref_blocked_style），之后含人物的段不再先挂关键帧被拒一次，空镜段照挂，换风格后重新尝试。
- **写实风格预设**（value 以 `live-` 开头）：现代都市剧 / 古装历史剧 / 院线电影感 / 胶片文艺片 / 纪录片纪实 / 年代战争纪实；提示词均声明虚构人物、不像任何真实存在的人。
- **连脸靠提示词锚定**：把发型发色、脸型、服装、耳饰在每条提示词里逐字重写一遍，并固定机位、压低动作幅度；实测人脸相似度 0.47→0.66（女主）、0.41→0.69（男主），不合格帧归零。
- 合规：AI 生成内容需按《AI生成合成内容标识办法》显式标识，图片角标别去。

## 后期与质检工具（在 `~/drama-workspace`，不在本仓库）

- `scripts/dub_episode.py` — edge-tts 配音 + ASS 硬字幕 + 混音到 -16 LUFS
- `scripts/qc_episode.py` — 成片质检：编码/9:16/黑帧/冻结/静音/响度
- `scripts/face_check.py` — 人脸一致性核验（OpenCV YuNet + SFace，阈值 0.363）
- `scripts/assemble_episode.py` — 统一调色/帧率 + 交叉溶解 + 二次响度归一
