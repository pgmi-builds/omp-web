## 1. 包身份一致

- [ ] 1.1 将 `apps/omp-web/cordis.patch.yml` 的 mount 名从 `dsh-omp-provider` 统一为 `@pgmi-builds/omp-web`（本 change 在 §2 一起重写该文件；此处确认 `name` 与 `package.json` 的 `name` 一致）。验证：`node -e "console.log(require('./package.json').name)"` 输出 `@pgmi-builds/omp-web`，bundle patch 里 `name` 字段相等。
- [ ] 1.2 确认 `package.json` 的 `files` 含 `dist` + `cordis.patch.yml`，`main`/`exports` 指向 `dist/index.js`，`dsh.bundle.patch` 指向 `./cordis.patch.yml`。验证：`npm pack --dry-run` 列出 `dist/` 与 `cordis.patch.yml`，无 src/、无本地绝对路径文件。

## 2. bundle patch 自包含挂载

- [ ] 2.1 重写 `apps/omp-web/cordis.patch.yml`：`insert omp-provider`（`name: '@pgmi-builds/omp-web'`）+ disable `agent-loop`/`llm-deepseek`/`llm-pi-ai`/`agent-presets`/`session-persistence-jsonl` + `permission`（3-preset 表 + `defaultPreset: danger-full-access`），不含 `webserver.port`/`settings.path`/`agent-default-model` 静态值。验证：`openspec validate package-distribution --strict` 通过，bundle patch YAML 可被 `loadOverlayPatches` 解析。
- [ ] 2.2 将手写 profile patch（`~/.omp/omp-web/profiles/omp-web/cordis.patch.yml`）里的通用 mount/disable 行移除（移交到 bundle patch），保留 profile 特定行（`webserver.port`、`agent-default-model`——后者由 model-selection-bridge 动态追踪，可留可去）。验证：profile patch 不再含 `insert omp-provider` 与已移交的 disable 行。
- [ ] 2.3 保留手写 profile patch 的 `settings.path`（D6：有意，settings under profile，`~/.omp/omp-web/profiles/omp-web/settings.yaml`）。验证：bundle patch 不 hardcode 任何 settings/DSH_HOME 路径，profile 层的 `settings.path` 与 systemd env 的 `DSH_HOME` 分离保留。

## 3. 路径 env 驱动

- [ ] 3.1 `apps/omp-web/src/models.ts` 的 `OMP_AGENT_DIR` 改为 `join(process.env.OMP_HOME ?? join(homedir(), ".omp"), "agent")`，与 `omp-store.ts`/`store/index.ts` 一致。验证：`grep -rn '~/.omp\|/home/u1\|workspaces/' src/` 无硬编码；`npm run build` 通过。
- [ ] 3.2 在 `omp-store.ts` / `store/index.ts` 路径解析处加注释：上游 dsh settings 是 home 级全局单例（`$DSH_HOME/settings.yaml`），profile 支持 bundle 组合但不自带 settings 隔离；本包不读 settings.yaml，隔离由独立 `DSH_HOME` 保证。验证：注释存在，无功能改动。

## 4. peer 依赖 optional

- [ ] 4.1 `apps/omp-web/package.json` 加 `peerDependenciesMeta`，将 `@deepseek-ai/cordis` 与 7 个 `@deepseek-ai/dsh-*` 标记 `optional: true`（理由见 design.md D4：避免 `npm install` 拉 alpha.3 副本干扰 user 已有 dsh 版本）。验证：`npm install --dry-run` 不拉取 `@deepseek-ai/dsh-*` 副本；`npm run build` 通过。

## 5. 本地 registry 安装验证（user 视角）

- [ ] 5.1 本地生产 profile `omp-web` 从 `file:` 依赖切到 registry：`dsh plugin --profile omp-web add @pgmi-builds/omp-web`（或 `pnpm add @pgmi-builds/omp-web`），确认 node_modules 下是 `@pgmi-builds/omp-web`（registry tarball），不再是 `dsh-omp-provider` alias。验证：`readlink`/`ls node_modules/@pgmi-builds/omp-web` 存在，`node_modules/dsh-omp-provider` 不存在。
- [ ] 5.2 重启 `omp-web.service`，验证 3081 Web UI 正常启动、`omp-provider` 挂载、模型选择器读 OMP 模型目录、bridge-store 写到 `DSH_HOME`。验证：`systemctl --user restart omp-web.service` 后 `journalctl --user -u omp-web.service` 无 loader 解析失败、无 `cannot resolve profile bundle` 错误，浏览器打开 3081 能建会话。
- [ ] 5.3 验证 optional peer 生效：确认安装过程不拉取 `@deepseek-ai/dsh-*` 副本（宿主 dsh-alpha 已提供），运行时 import 正常。验证：profile node_modules 里无独立 `@deepseek-ai/dsh-*`（除 workspace 提供的），启动无 import 失败。

## 6. 收尾

- [ ] 6.1 运行 `openspec validate package-distribution --strict` 通过；`npm run build` 无回归。
- [ ] 6.2 记录本地「生产 profile（registry）vs 开发测试基地（file: 依赖）」两条线的启动方式（README 或 docs），明确开发迭代改 src 的 build+重启路径。
