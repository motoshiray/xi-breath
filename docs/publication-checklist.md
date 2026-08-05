# GitHub 发布检查单

## 上传前

- [ ] 使用全新公开仓，不复用私人仓的 Git 历史。
- [ ] 再次确认仓库中只有虚构示例。
- [ ] 搜索 `.env`、Token、IP、绝对路径、邮箱和真实姓名。
- [ ] 确认没有真实照片、音频、备份、日志或数据库。
- [ ] 确认所有新增素材的许可范围。
- [ ] 在 GitHub 设置中启用 Private vulnerability reporting。

## 建议的仓库设置

- 仓库描述：`一个把事件记忆与主体感情自报分开的中文公开参考框架。`
- Topics：`memory-architecture`、`affective-computing`、`human-ai-relationship`、`privacy-by-design`、`append-only`
- 默认分支保护：至少要求 PR 后才能合并。
- Issue 模板：提醒提交者不得粘贴真实私密材料。

## 首次发布后

- [ ] 从 GitHub 下载仓库压缩包，再做一次离线隐私复核。
- [ ] 检查 README 中的相对链接。
- [ ] 打开 `starter/index.html` 验证静态示例。
- [ ] 把许可证选择和“有限开放”的含义写进 Release notes。

不要为了展示效果加入真实数据。一个诚实的空框架，比一份无法撤回的公开生活更有价值。
