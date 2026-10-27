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

## 本地补丁清单（与上游的差异）

1. **`backend/src/services/adapters/volcengine-image.ts`** — 补上参考图传递。
   上游把 `referenceImages` 一路传到 record 却从不使用，导致每个镜头各长一张脸；现在写入 Ark 的 `image` 字段做图生图。
   原文件备份见 `*.bak-*`（已加入 `.gitignore`）。
2. **`backend/workspace/prompts/*.md`** — 每个 Agent 的前置模型：
   - `script_rewriter` → `deepseek-v4-pro`（长文连贯）
   - `extractor` / `storyboard_breaker` / `prompt_generator` → `deepseek-flash`（快而省）
3. **`scripts/start.sh`** — 单服务启动脚本（后端同时托管前端静态站，默认 5679）。

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
- **连脸靠提示词锚定**：把发型发色、脸型、服装、耳饰在每条提示词里逐字重写一遍，并固定机位、压低动作幅度；实测人脸相似度 0.47→0.66（女主）、0.41→0.69（男主），不合格帧归零。
- 合规：AI 生成内容需按《AI生成合成内容标识办法》显式标识，图片角标别去。

## 后期与质检工具（在 `~/drama-workspace`，不在本仓库）

- `scripts/dub_episode.py` — edge-tts 配音 + ASS 硬字幕 + 混音到 -16 LUFS
- `scripts/qc_episode.py` — 成片质检：编码/9:16/黑帧/冻结/静音/响度
- `scripts/face_check.py` — 人脸一致性核验（OpenCV YuNet + SFace，阈值 0.363）
- `scripts/assemble_episode.py` — 统一调色/帧率 + 交叉溶解 + 二次响度归一
