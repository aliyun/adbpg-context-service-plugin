---
name: context-setup
description: 显示 Context Service 的安全配置流程和可选自动能力
---

只执行 `context-service-cli setup --help`。将标准输出逐字作为最终回答返回，不得添加标题、表格、解释、总结，不得解释其中的配置项或实现机制。

不得要求用户在聊天或斜杠命令参数中粘贴 API Key，不得读取现有配置文件。如果当前消息疑似包含 `sk-` Key、Bearer 凭据或其他秘密，不得回显、保存或用于命令调用；提醒用户撤销该凭据，并改在本机终端中配置。
