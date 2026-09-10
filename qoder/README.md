# Context Service Qoder 插件

Context Service 为 Qoder 提供自动上下文、长期记忆、团队知识、规则查询和会话历史能力。插件在当前用户的电脑上运行，并通过用户配置的服务地址安全访问 Context Service。

## 主要能力

- 会话开始时自动注入适用的规则、角色和会话状态
- 根据当前问题召回相关知识和长期记忆
- 在每轮回答结束后按配置同步对话并提取长期记忆
- 提供 12 个按需工具，用于查询或管理记忆、知识、规则、会话和事件
- 提供 `/context-setup`、`/context-status`、`/context-test` 和 `/context-help` 四个命令
- 提供使用指导，帮助 Qoder 在合适的时机选择 Context Service 工具

所有写操作继续受 Qoder 权限机制控制。建议使用绑定普通用户身份的数据面 API Key，不要使用管理员 Key。

## 环境要求

- macOS 或 Linux
- Qoder CLI 1.1.30 或更高版本
- Node.js 18 或更高版本
- `curl` 和 `unzip`
- 可通过 HTTPS 访问的 Context Service 地址
- Context Service 普通用户 API Key

## 安装

正式发布后，通过 HTTPS 安装：

```bash
read -s CONTEXT_SERVICE_INSTALL_KEY
curl -fsSL https://adbpg-context-service-client.oss-cn-hangzhou.aliyuncs.com/install.sh | sh -s -- \
  --agent qoder \
  --base-url https://context-api.example.com \
  --api-key "$CONTEXT_SERVICE_INSTALL_KEY"
unset CONTEXT_SERVICE_INSTALL_KEY
```

安装过程会校验版本和下载内容，不需要 `sudo`，并在安装插件、注册 MCP、写入配置和完成只读诊断后才提交安装状态。安装完成后请完整重启 Qoder IDE。

开发期间可以从已校验的本地目录安装：

```bash
qodercli plugins validate . --strict
qodercli plugins install . --scope user --json
```

本地源码安装只用于开发验证；正式发布建议使用安装器，以便同时管理版本、工具连接、升级和卸载。

## 配置

在本机终端中隐藏输入 API Key：

```bash
read -s CONTEXT_SERVICE_SETUP_KEY
context-service-cli setup \
  --base-url https://context-api.example.com \
  --api-key "$CONTEXT_SERVICE_SETUP_KEY"
unset CONTEXT_SERVICE_SETUP_KEY
```

不要把 API Key 粘贴到 Qoder 聊天或斜杠命令参数中。配置文件在 macOS/Linux 上使用 `0600` 权限。

可按需开启自动能力：

```bash
context-service-cli setup \
  --base-url https://context-api.example.com \
  --api-key "$CONTEXT_SERVICE_SETUP_KEY" \
  --enable-prompt-hook \
  --enable-stop-sync \
  --enable-stop-memory-extraction
```

- `--enable-prompt-hook`：每次用户提交问题时召回相关知识和长期记忆
- `--enable-stop-sync`：每轮回答结束后同步本轮对话
- `--enable-stop-memory-extraction`：每轮回答结束后自动提取长期记忆，要求服务使用 Mem0

会话开始时的基础上下文注入默认开启。其余三个选项默认关闭，可单独开启。

## 使用

在 Qoder IDE 或 Qoder CLI 中使用：

| 命令 | 作用 |
|---|---|
| `/context-setup` | 显示安全配置流程和可选开关 |
| `/context-status` | 查看脱敏配置、自动能力开关和服务状态 |
| `/context-test` | 执行不写业务数据的连通性检查 |
| `/context-help` | 查看帮助和安全边界 |

推荐顺序：

```text
/context-setup → /context-status → /context-test
```

使用 `/mcp` 查看 Context Service 工具连接状态，使用 `/skills` 查看 Context Service 使用指导。配置或版本发生变化后，请完整重启 Qoder IDE。

## 自动能力说明

### 会话开始

新会话开始时，插件自动获取适用的规则、角色和会话状态，并注入当前会话。服务暂时不可用时不会阻断 Qoder。

### 问题相关召回

开启后，每次用户提交非空问题时，插件只召回与当前问题相关的知识和长期记忆。此功能会增加首个响应的等待时间。

### 对话同步与长期记忆

开启相应选项后，每轮回答结束时，插件只发送当前轮的用户文本和助手文本。对话同步和长期记忆保存相互独立，其中一项失败不会取消另一项，也不会阻断 Qoder。

插件不会上传完整聊天记录、工具输入输出、工作目录、仓库名或文件内容。详细数据边界见 [PRIVACY.md](./PRIVACY.md)。

## 工具能力

插件提供以下工具：

- 记忆：`save_memory`、`recall_memory`、`list_memories`、`delete_memory`
- 知识：`search_knowledge`、`list_knowledge`
- 规则：`rules_get`、`rules_check`
- 会话：`session_history`、`session_search`
- 事件：`event_emit`、`event_query`

会话和事件查询支持连续翻页：会话搜索使用 `limit/offset`；会话历史的
`offset` 从最新消息端开始计算；事件查询返回 `next_from_seq` 作为下一页游标。
调用方应在 `has_more=false` 时停止翻页。

写入或删除数据时，请检查 Qoder 的权限确认内容再决定是否允许。

## 状态、升级与卸载

```bash
context-service-cli status
context-service-cli test
context-service-cli version
context-service-cli doctor
```

升级由用户主动触发，不会在后台静默执行：

```bash
context-service-cli upgrade
```

默认卸载保留 API Key 配置和轮次状态：

```bash
context-service-cli uninstall
```

彻底删除已知配置和状态需要明确确认：

```bash
context-service-cli uninstall --purge-data --yes
```

安装、升级和卸载支持 `--dry-run` 与 `--json`。完成后请完整重启 Qoder IDE。

## 安全与隐私

- API Key 仅用于访问用户配置的 Context Service，不写入 Qoder 工具配置
- `--api-key` 在安装进程存活期间可能被同机进程观察；应使用隐藏输入变量并在安装后立即清理变量
- 非本机服务地址必须使用 HTTPS
- 自动对话同步和长期记忆保存默认关闭
- `/context-test` 不执行业务写入
- 写工具不会被安装器预授权
- 服务不可用时自动能力安全降级，不阻断 Qoder

更多说明见 [PRIVACY.md](./PRIVACY.md) 和 [SECURITY.md](./SECURITY.md)。
