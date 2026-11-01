# 隐私与费用 / Privacy and cost

本地保存不等于整个工作过程完全离线。自动整理和审查会涉及所配置的模型调用。

不要保存密码、验证码或第三方隐私。检查 DSH 的模型服务与计费设置。插件是 MIT 开源；模型服务、网络和宿主的费用另计。来源撤回不承诺清除原始对话、远端服务或外部备份。

Local storage does not make model-assisted review offline. The MIT plugin has no license fee; configured model services may charge. Withdrawal cannot erase unknown copies or remote history.

公开测试版 / Public beta 0.21.0-beta.3.

[安装与限制](../../README.md) · [English](../../README.en.md) · [试用导航](../README.md)

Beta.3：已识别的个人资料默认不自动注入，也不参与无关的旧记忆整理；普通搜索隐藏，需要相关资料时明确用 `memory_search` 的 `includePrivate: true`。识别规则不完整，文件工具仍可读明文；按需读取仍会进入当前日志及模型请求。既有会话、导出、缓存、备份和已发送数据未擦除，原始索引也没有迁移成指针库。

In beta.3 recognized private content is omitted from automatic projection and unrelated saved-memory context. Default search hides it; explicit relevant retrieval uses `includePrivate: true`. This is heuristic, not an access-control boundary or historical erasure.
