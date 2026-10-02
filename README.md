# AIFISHER Plugins

独立于 AIFISHER 主项目的画布插件源码仓库。

每个插件目录均可单独构建，构建产物位于各自 `dist/`。AIFISHER 可直接粘贴本仓库 URL、插件子目录 URL、GitHub blob/raw JS URL 进行安装和更新。

推荐 GitHub 结构：
- `<plugin>/aifisher-plugin.json`
- `<plugin>/dist/<plugin>.js`

本仓库中的 `sdk/` 是插件开发 SDK 副本，仅供独立插件构建，不要求把插件源码放回 AIFISHER 主项目。
