# Tasks — Upstream 0.1.3-alpha.2 Alignment

## 1. 对齐轮执行（本轮，已完成）

- [x] S1 载体 diff（fs-ext write-lease、session-format-catalog）+ 7 peers 清单核对
- [x] S2 checkout dsh-v0.1.3-alpha.2 + pnpm-workspace storeDir/verifyDepsBeforeRun patch（欠账补齐）
- [x] S4 install/build：unrun devDep、tsdown.client.ts resolveRepositoryRoot 两个必需 patch；build 全绿 224 client artifacts
- [x] S5 vendored types 10 包重灌（0.1.3-alpha.2 `lib/types`）
- [x] S5 迁移：replay.ts（brand/reason/stream）、agent.ts（snapshotEvents + AssistantStreamBridge）、session-persistence-omp.ts（五方法面重写）、supervisor.ts（brand + materialize 守卫）、index.ts（resume open/read）
- [x] tsc 0 错；单测 30/30
- [x] S6/S7 4999 冒烟：fence/auth/冷读/round-trip/词表/header 一致性 全绿（F1/F2/F3 实测发现并修复）
- [x] 本地实测报告 `docs/upstream-dsh-0.1.3-alpha.2-local-test-report.md`

## 2. 裁决与发布（待用户确认/下一窗口）

- [x] T4 peer 版本策略：`peerDependencies` 精确 pin bump → `0.1.3-alpha.2`（2026-09-08 用户裁决：精确 bump，弃区间方案）；vendored types 策略不变（宿主 lib/types 为源）
- [ ] T5 版本 0.3.0：changelog（seam 重写 + v2 流式 + header 一致性修复）、`npm pack --dry-run` 核对、publish（`--cache` 重定向）
- [ ] T6 prod 3081 升级窗口：profile `pnpm add @pgmi-builds/omp-web@0.3.0` → 重启 `omp-web.service` → prod 冒烟（fence 401/403、list、冷读旧会话、新会话 round-trip、feedback 写路径、`fileMention` 观察位）
- [ ] T7 旧遗留小修：`omp rpc: unhandled message_end role "fileMention"` 的映射/忽略（独立小 change）

## 3. 测试与清理

- [ ] T8 用户 4999 手动验收（冷读旧会话 + 新会话 + resume；注意 token 每次重启轮换）
- [ ] T9 验收后 `systemctl --user stop omp-web-4999-test`（勿 kill；Caddy 不动；4999 归还被 dashr 侧使用时先协调）
- [ ] T10 冒烟测试会话清理（`session-697bb1e3…`、`session-bad59e5e…`、`session-7dc9e379…` 的行 + OMP 转录文件；另有 2026-09-08 晚间 mobile 冒烟新增的两个）
- [x] T11 AGENTS.md 回写（§二 patch 清单、§三状态、§四 v2 对齐要点）
- [x] T12 ~~附加交付：dashr web-trust/mobile 源码移植~~ → **2026-09-08 用户裁决：不修 UI tweaks/mobile，移植代码已从 src 撤下并存档 `.scratch/mobile-port/`**（boot 脚本拼接缺分号的 SyntaxError 已定位修复法，见存档）；后续如重启该需求，以**直接挂载 better-dsh 包**为首选路径（用户倾向），而非源码移植
