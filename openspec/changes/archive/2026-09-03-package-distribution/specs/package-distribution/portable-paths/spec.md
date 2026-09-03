## Purpose

定义路径可移植契约：所有 OMP/DSH 数据路径由 `OMP_HOME`/`DSH_HOME` env 驱动，无硬编码绝对路径，使包能在任意 user 机器（OMP 装在非 `~/.omp`、DSH home 非默认）正确读写数据。

## ADDED Requirements

### Requirement: OMP 数据路径 env 驱动

读取 OMP 数据（模型目录、sessions、config.yml）时，系统 SHALL 以 `OMP_HOME` 为根，缺省回退 `~/.omp`。系统 MUST NOT 硬编码 `~/.omp` 而不读 `OMP_HOME`。

#### Scenario: OMP_HOME 指向非默认路径

- **WHEN** user 的 OMP 装在 `/data/omp`（`OMP_HOME=/data/omp`）
- **THEN** 模型目录解析为 `/data/omp/agent`（而非 `~/.omp/agent`），sessions/config.yml 同样以 `/data/omp` 为根

#### Scenario: 未设 OMP_HOME 回退默认

- **WHEN** `OMP_HOME` 未设置
- **THEN** OMP 数据路径回退 `~/.omp`，行为与当前默认一致

### Requirement: DSH 数据路径 env 驱动

桥接层自有存储（bridge-store）SHALL 以 `DSH_HOME` 为根，缺省回退 `~/.omp/dsh`。系统 MUST NOT 硬编码 profile home 的绝对路径。

#### Scenario: DSH_HOME 指向 profile home

- **WHEN** dsh 以 profile 启动且 `DSH_HOME` 指向该 profile home
- **THEN** bridge-store 写入 `$DSH_HOME/bridge-store.sqlite`，不同 profile 的数据互不串扰

### Requirement: 无硬编码绝对路径

源码 SHALL NOT 包含任何开发机特定绝对路径（`/home/u1/...`、workspace checkout 路径等）作为数据/模块解析目标。

#### Scenario: 源码不含机器特定路径

- **WHEN** 扫描 `src/` 全部文件
- **THEN** 不存在 `/home/u1`、`workspaces/dsh-omp`、`workspaces/dsh-alpha` 等硬编码路径字面量
