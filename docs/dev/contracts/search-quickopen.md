# 搜索与快速打开契约

## 命令
- `workspace.search.start`：`options={searchId,query,caseSensitive,wholeWord,regex,includeGlobs,excludeGlobs,maxFileBytes,maxResults}`；后台搜索。
- `workspace.search.cancel`：`options.searchId`；取消当前搜索。
- `workspace.tree.list`：`path` 为相对目录；快速打开用 BFS 建立文件索引。

## 事件
- `workspace:search-result {searchId,hits[]}`：增量命中，`hits` 字段为 `relPath,line,col,lineText`。
- `workspace:search-completed {searchId,summary}`：summary 含 `filesScanned,hits,truncated,cancelled`。
- `workspace:tree-listed {relDir,entries[]}`：目录树单层结果。

## UI
`SearchPanel` 通过 Ctrl+Shift+F 打开；输入 300ms 防抖；正则开关显示“正则引擎待集成”。`QuickOpen` 通过 Ctrl+P 打开，子序列评分、最多展示 50 项，索引最多递归 200 个目录。

## 限制
正则引擎由后续阶段引入；命中打开当前仍通过 `open_file` 绝对路径语义；行定位由前端尽力执行。
