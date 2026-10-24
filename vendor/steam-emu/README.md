# 内置 Goldberg 模拟器源（gbe_fork）

本目录存放 aw2 内置的 Goldberg 系模拟器 **gbe_fork** 预编译包，供 `emu-apply` 打补丁时开箱即用（首次使用自动解压所需 DLL 到 `<数据目录>\tools\steam-emu`）。

- 上游项目：<https://github.com/Detanup01/gbe_fork>（Mr_Goldberg/goldberg_emulator 的社区延续）
- 内置版本：`emu-win-release-vs22`，2026-09-27 release
- 包名：`gbe_fork-emu-win-release-vs22-2026-09-27.7z`
- SHA-256：`300186c34f49a9ea75b33ce2af299267cc1dad0225cf45e81a229578d4e11c85`
- 许可证：**LGPL-3.0**（全文见本项目根目录 LICENSE，同许可证兼容）
  - 本项目仅原样再分发该预编译包、未做任何修改，符合 LGPL 再分发条款
  - 完整源代码可在上述上游仓库获取
- 想使用更新/其他版本：`node src\cli.js emu-source <新版7z或解压目录>` 安装后会覆盖内置版的展开结果
