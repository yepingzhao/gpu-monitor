# 本地开发与使用

这是 https://github.com/yepingzhao/gpu-monitor 的本地改进版本，原项目是 https://github.com/huia711/gpu-monitor。

## 改进内容

刷新时保留最后一次成功的数据；每台服务器返回后只更新自己的子树。服务器、GPU 和进程使用稳定的 ID，以便 VS Code 保持展开和选中状态。修改刷新间隔时不清空列表。实际查询失败仍显示错误，避免把旧数据当作最新结果。

`.vscodeignore` 不再排除所有 `node_modules`。VSIX 必须包含 `ssh2` 及其运行依赖，以修复原 0.1.2 的加载失败。

## 开发与测试

在仓库目录执行：

```powershell
npm ci
npm test
```

用 VS Code 打开这个目录，按 F5，选择 Run GPU Monitor。新的 Extension Development Host 窗口使用本地源码编译结果。修改 `src` 中的 TypeScript 后重新编译、重载开发窗口。

回归测试使用受控的延迟查询，不连接真实服务器。测试检查等待结果期间旧数据仍可见、仅更新对应子树、稳定且唯一的节点 ID，以及新增服务器的根列表更新。

手动验收：展开一个服务器及一个有进程的 GPU，点击刷新。等待期间数据应保留，完成后展开状态应保留；另一台服务器应不随其重建。模拟断网时应能看到错误，恢复网络后可重新刷新。

## 打包与安装

```powershell
npx @vscode/vsce package
code --install-extension .\ssh-gpu-monitor-0.1.3.vsix --force
```

打包会自动编译。也可以使用 VS Code 扩展菜单中的 Install from VSIX。安装后执行 Developer: Reload Window。

此本地包保留 `huia.ssh-gpu-monitor` ID，以复用现有设置并替换已安装版本。它不是原作者在 Marketplace 发布的 0.1.3。将来官方更高版本的更新可能覆盖本地改进；如需固定本地版本，可在扩展菜单关闭该扩展的自动更新。

## GitHub 与发布

改动位于 fork 的 `smooth-refresh` 分支，可继续提交改动或向上游提交 PR。

本地使用无需注册 publisher，也无需上架。公开发布独立版本时，应先改用自己的 publisher，并更新仓库、问题链接和首页信息，再按 VS Code 官方文档配置 Marketplace 发布身份。当前 `huia` 身份只用于本地替换，不能用你的账号更新原作者的市场条目。

官方文档：https://code.visualstudio.com/api/working-with-extensions/publishing-extension
