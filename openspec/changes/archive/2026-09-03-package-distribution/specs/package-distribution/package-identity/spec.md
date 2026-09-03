## Purpose

定义包身份一致契约：registry 包名、bundle patch 里的 mount `name`、`files` 发布清单、`dsh.bundle.patch` 声明四处无漂移，确保 registry 安装后 cordis loader 能按包名解析模块。

## ADDED Requirements

### Requirement: mount name 与 registry 包名一致

bundle patch 里挂载 omp-provider 的 `name` SHALL 等于 registry 包名 `@pgmi-builds/omp-web`。系统 MUST NOT 使用任何旧别名（如 `dsh-omp-provider`）作为 mount name，除非同时以该别名 publish 到 registry。

#### Scenario: registry 安装后 loader 可解析

- **WHEN** user 从 registry 安装 `@pgmi-builds/omp-web`（node_modules 下只有 `@pgmi-builds/omp-web`）
- **THEN** cordis loader 按 mount `name` 解析到该包目录，不因旧别名 `dsh-omp-provider` 缺失而失败

### Requirement: 发布清单包含运行时必需文件

`package.json` 的 `files` SHALL 包含 `dist`（编译产物，`main`/`exports` 入口）与 `cordis.patch.yml`（`dsh.bundle.patch` 指向的 bundle patch）。`dsh.bundle.patch` SHALL 指向 `./cordis.patch.yml` 且该文件随包发布。

#### Scenario: tarball 内容完整

- **WHEN** 从 registry 拉取 `@pgmi-builds/omp-web` tarball
- **THEN** tarball 含 `dist/index.js`（main 入口）与 `cordis.patch.yml`（bundle patch），加载与挂载均不因文件缺失失败
