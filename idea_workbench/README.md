# IdeaFlow

本地科研工作台：**idea → 实验 → 结果 → insight → 下一步**。主界面是有方向的研究流向图，支线从具体发现处分出，也可以综合多个来源回到主线。Codex 通过配套 Skill 和命令行使用同一份记录。

核心记录服务使用 Python 3.10+ 标准库，无需模型密钥或数据库服务；可使用网页，也可打包为包含运行环境的 macOS App。当前为单人、本机 MVP；MCP、远程执行同步和自主研究循环尚未实现。

## macOS App

桌面版位于 `desktop/`，采用 Electron 窗口，复用同一套画布、SQLite 记录和本地 API。打包后的 `IdeaFlow.app` 可直接打开，无需另外安装 Python 或启动终端。

界面固定为浅色，包括画布、侧栏、欢迎页和原生窗口，不随系统深色模式切换。

- **打开研究项目**（⌘O）：选择包含 `.idea-workbench/` 的项目文件夹，或已有记录目录。直接使用原记录，Codex/CLI 的更新会同步显示。
- **新建研究项目**（⌘N）：选择一个项目文件夹，创建其中的 `.idea-workbench/`；已有研究记录不会覆盖。
- 自动记住最近项目，下次启动恢复；“文件”菜单可切换项目、在 Finder 中显示项目及导出 JSON。
- 每个项目拥有独立且稳定的本地页面地址。拖动布局、缩放、所选节点和未保存的草稿可跨 App 重启恢复。网页与 App 各自保存视图，已有网页布局不会自动迁移。
- App 自动管理自己的本地服务，关闭窗口即退出；Codex 启动的独立实验进程不受影响。研究数据留在项目目录，最近项目和视图继续保存在 `~/Library/Application Support/Idea Workbench/`，沿用既有目录和页面地址以保留布局与草稿。产品名称已更新为 IdeaFlow；Skill 调用名为 `$ideaflow`；CLI 模块名和 `.idea-workbench/` 数据目录保持兼容。

在 macOS 上从仓库根目录构建：

```sh
python3 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install -r idea_workbench/desktop/requirements-build.txt
npm --prefix idea_workbench/desktop ci
node idea_workbench/desktop/package.mjs --python .venv-desktop/bin/python
```

构建完成会打印 `IdeaFlow.app` 的绝对路径，将它复制到“应用程序”即可。产物默认位于系统临时目录的 `ideaflow-release/IdeaFlow-darwin-ARCH/`，可通过 `--out /path/to/release` 指定其他目录；建议避开 iCloud 同步目录，以免自动生成的 Finder 元数据干扰代码签名。构建当前机器的架构，使用本地临时签名；公开分发给其他用户前仍需 Developer ID 签名和 Apple 公证。开发启动：`npm --prefix idea_workbench/desktop start`（使用本机 `python3`，也可设置 `IDEA_WORKBENCH_PYTHON`）。

构建脚本可选 `--toolchain /path/to/existing/node/project` 复用已安装的 Electron Packager，以及 `--electron-zip-dir /path/to/cache` 复用官方 Electron ZIP；这些目录只在构建时使用，不成为 App 的运行依赖。

## 立即体验真实示例

在包含 `idea_workbench/` 的仓库根目录运行：

```sh
python3 -m idea_workbench --store runs/idea-workbench-demo demo
python3 -m idea_workbench --store runs/idea-workbench-demo serve
```

打开 <http://127.0.0.1:8770/>。示例实际运行四次小型 CPU 多项式拟合实验，保存源文件、参数和指标，再建立两条支线和待验证的后续方向。它是合成数据教学研究，不代表真实研究项目的历史或普适科学结论。`demo` 拒绝写入已有研究节点的存储目录；再次体验请选择新目录。已有示例只需执行 `serve`。

页面支持创建、编辑节点，暂停/恢复，查看来源路径、运行参数、代码元数据及日志，比较两次运行，以及生成可复制给 Codex 的上下文。图由已保存的关系生成，连线统一为实线，只表达来源与流向，不代表结论已证实。

连线统一使用平滑曲线，按实际路径判断遮挡，必要时从附近空隙绕开节点；分叉与汇合端点会错开。手动将卡片叠在一起可能无法完全避让，此时保留局部连线，移开卡片后重新计算，不绕到整张画布的边缘。拖动节点时实时更新连线，不改变保存的来源关系。

主界面只保留画布和浮动操作。画布与研究支线独立：现有项目的全部节点和来源关系放在同一张主画布；点击左上角“切换画布 → 新建画布”才创建另一张空白画布。新建想法或实验不会创建画布。画布归属存入项目数据库，各画布独立保存本机节点位置、缩放和平移。首次打开旧项目会事务式补上画布归属，不修改已有节点 ID、来源关系、运行及修订历史。

节点显示两类：胶囊形“想法”（idea / insight）与矩形“实验”（experiment / next），均使用浅色卡片。节点右上角及详情中的小状态灯表示状态：黄色待验证、蓝色进行中、绿色已完成、灰色已暂停；旁边保留状态文字。选中、悬停和连线目标用外框强调。创建只需填写标题和内容，新节点可以不连接任何来源。选中节点后，在节点旁的工具条里调整“进行中 / 待验证 / 已完成 / 已暂停”；状态更新立即保存。新想法默认进行中，新实验默认待验证，编辑内容不会覆盖另一次状态调整。

从节点下方圆点拖到目标节点即可保存有向连线；也可以点“连线”或聚焦圆点按 Enter，再点击目标节点。Esc 或“取消连线”退出。连接不受节点创建顺序限制，但不允许自连、闭环或跨画布；重复连线不会重复写入。右侧来源/去向中的“移除连线”只删除关系，不删除节点或实验。新建、连线及移除连线保持当前节点位置；需要整体整理时使用“更多 → 重新排布”。

按住 `Command` 拖动画出选框，选中相交的节点和连线；`Command`＋点击可增减选择，也可单击连线单独选中。框选不会移动节点或平移画布，松开后显示选中数量。松开 `Command` 后拖动任一已选节点，即可整体移动选中的节点并保持相对位置，连线实时跟随，松手自动保存布局；`Alt`＋方向键也可整组微调，配合 `Shift` 增大步长。未选中的节点不会被连线带动。按 `Delete` / `Backspace` 或点击“删除所选”，核对范围后批量删除；`Esc` 或空白处单击取消选择。删除节点会移除其关联连线和运行记录，其他节点、其他画布和磁盘上的实验文件保留；仅删除连线不会删除节点。有排队或运行中任务的实验暂不允许删除，整批操作不会部分生效。

点击节点后才展开右侧详情；拖动左边缘调整宽度，关闭按钮、空白处单击或 `Esc` 收起详情。分隔条也支持左右方向键调整宽度。重新打开应用默认收起详情，草稿继续保留。

滚轮 / 触控板双指滑动平移，捏合缩放，`Shift`＋滚轮横向平移。可拖动空白平移、拖动节点调整位置。底部“适应画布”显示当前画布全部节点；“更多”中提供重新排布、查找节点、比较运行和导出。键盘可用 `+` / `-` 缩放、`0` 适应画布、方向键平移；聚焦节点后 `Alt`＋方向键移动节点，配合 `Shift` 增大步长。视图保存在当前浏览器、当前地址下，换浏览器或端口不会同步布局。重新排布只恢复当前画布的自动位置，不修改研究记录。

## 建立自己的研究

```sh
python3 -m idea_workbench init --name "我的研究" --project .
python3 -m idea_workbench serve
python3 -m idea_workbench install-skill --project .
```

默认记录保存在当前目录的 `.idea-workbench/`。安装命令只将配套 Skill 放入本项目 `.agents/skills/ideaflow/`，不修改全局 Codex 设置，遇到不同内容的现有 Skill 会停止。之后可在 Codex 中使用 `$ideaflow`；若技能列表未更新，重新打开会话或重启客户端。发现位置依据 [Codex 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)。

你可以对 Codex 说：“用 ideaflow 继续这个 idea，先读取研究背景，做一个最小实验，并记下结果、insight 和下一步。”这依赖 Codex 调用记录入口；Skill 不会监听任意终端命令，也不保证所有普通聊天自动归档。

下面的 `CANVAS_ID`、`IDEA_ID`、`EXPERIMENT_ID`、`FINDING_ID`、`RUN_ID` 替换为已有记录或前一步输出的真实 ID；先用 `status` 查看已有画布。所有命令以 JSON 返回结果，`context` 默认返回可读文本。

```sh
python3 -m idea_workbench status
python3 -m idea_workbench node --canvas CANVAS_ID --kind idea --status active --title "想验证的问题"
python3 -m idea_workbench node --canvas CANVAS_ID --kind experiment --source IDEA_ID \
  --status proposed --title "最小对照" --body "固定哪些条件、改变什么、看哪些指标"
python3 -m idea_workbench edit EXPERIMENT_ID --status active
python3 -m idea_workbench run --experiment EXPERIMENT_ID \
  --include idea_workbench/examples/polynomial.py --params '{"degree":3}' \
  --wait -- python3 idea_workbench/examples/polynomial.py --degree 3
python3 -m idea_workbench status RUN_ID
python3 -m idea_workbench node --kind idea --source EXPERIMENT_ID --status active \
  --title "这次改变了什么认识" --body-file insight.txt
python3 -m idea_workbench node --kind experiment --source FINDING_ID \
  --status proposed --title "下一项最小验证" --body "理由、预期结果分歧、资源约束"
```

新记录优先使用 `idea`（问题、假设、insight）和 `experiment`（拟议验证、实际实验）两类；历史 `insight` / `next` 仍可读取和显示，无需批量迁移。已有拟议实验开始执行时复用其节点，参数变体和不同种子记录为多次 run。旧 `next` 不能直接挂载 run，需要连接到一个 `experiment`。上面的独立发现与下一步节点只在有必要时添加，普通进展可以直接更新原节点内容。

节点状态与 run 状态独立：检查结果、确认该实验记录的任务已完成后，用 `edit EXPERIMENT_ID --status done` 更新；负结果也可以是已完成的实验，不代表假设成立。CLI 创建实验默认 `active`，记录尚未执行的计划时显式指定 `--status proposed`，与 App 的默认行为一致。

画布和连线也可由 Codex / CLI 管理：

```sh
python3 -m idea_workbench canvas --title "另一研究主题"
python3 -m idea_workbench node --canvas CANVAS_ID --kind experiment --status proposed --title "先记录实验"
python3 -m idea_workbench link --source SOURCE_ID --target TARGET_ID
python3 -m idea_workbench unlink --source SOURCE_ID --target TARGET_ID
```

未指定画布时，有来源的新节点继承来源画布，无来源节点进入主画布。`--source` 仍可用于一次创建并连接；普通画布操作默认先创建再连接。研究支线不等于新画布，相关分叉默认留在原画布，只有需要独立画布时才使用 `canvas` 命令。

从一个发现派生新问题：`node --kind idea --source FINDING_ID --reason "分叉理由" --title "新问题"`。综合同一画布内的多个来源时重复 `--source`，必要时用 `--idea IDEA_ID` 指定原有归属主线；`--idea` 不指定画布。编辑文本或暂停不会删除历史：`edit NODE_ID --status paused --body-file pause-note.txt`；恢复使用 `--status active`。

```sh
python3 -m idea_workbench context NODE_ID
python3 -m idea_workbench compare LEFT_RUN_ID RIGHT_RUN_ID
python3 -m idea_workbench import-run --experiment EXPERIMENT_ID --metrics existing-metrics.json
python3 -m idea_workbench export > research-export.json
```

`--store PATH` 放在子命令之前。多项目使用不同的存储目录；在其他仓库实验时，可从本工具所在目录启动，`init --project /path/to/research` 注册研究源码根目录，以后始终传对应的绝对 `--store` 路径。

## 参数、代码与执行

`run` 默认启动独立后台进程，立即返回 run ID，`--wait` 适合短实验。网页和记录服务可以关闭，运行进程仍独立继续；机器关机、系统杀进程等情况不具备自动恢复能力。运行结果不会因重跑而覆盖，每次执行分配新的 ID。

`--include` 可以重复，接受相对项目根目录的文件、目录或 glob。选中的源文件复制到该 run 的 `source/`，实验从这个副本运行，原项目后续编辑不会影响它。脚本使用相对源码路径；源码依赖也需要包含。最多 2,000 个文件、单文件 20 MiB、总计 100 MiB；数据集和模型应引用外部版本。

记录器同时保留所选文件范围内的 Git commit、分支、未提交 diff 和源文件清单。未提交/未跟踪代码可随快照保存，无 Git 或尚无提交的仓库也能使用。清单中的文件摘要是实际复制的字节；Git 元数据仅为辅助，不代替快照。

合作脚本可按以下约定输出：

```python
import json, os
from pathlib import Path

# args 是脚本已经解析后的实际配置，包含默认值。
Path(os.environ["IDEA_CONFIG_PATH"]).write_text(json.dumps(vars(args)))
Path(os.environ["IDEA_METRICS_PATH"]).write_text(json.dumps({"loss": measured_loss}))
```

这两个文件必须是 JSON 对象。`IDEA_RESULTS_DIR` 可用于图表和其他产物。默认捕获 stdout/stderr；页面可查看约定的文本产物，任意图片文件浏览尚未提供。缺少指标不会捏造数值；不合法的配置/指标会让本次运行显示失败。`--params` 是声明配置，脚本报告的 `actual_params` 才是实采配置，二者分别保存。比较优先使用实采配置，没有时明确保留声明来源。

已有结果导入不会重跑实验。只导入 JSON 指标与用户声明的参数，不补造历史 commit、实际参数或开始时间。

快照不是容器：外部数据、环境依赖、服务和运行中的自修改没有被完全冻结，环境记录目前只有执行平台及记录器 Python 版本。脚本应记录数据版本、种子和重要依赖。不要把凭据放入参数、命令行或日志；源文件选择排除了常见私密路径，但不提供通用秘密扫描。

## 数据与访问边界

- 数据库：`research.sqlite3`，记录节点、关系、修订与运行元数据。
- 运行目录：`runs/RUN_ID/`，保存快照、日志、配置、指标。
- JSON 导出包含记录和修订，不包含源码/大产物；完整备份请在运行结束并关闭写入进程后复制整个存储目录。
- 服务仅绑定 `127.0.0.1`，校验 Host/Origin，写操作使用同源请求令牌。HTTP 接口只修改研究记录，执行任意实验仍通过本机 CLI/Codex。
- 当前单人本机设计，没有多用户身份认证；不要用代理将其公开到互联网，也不要在多台机器之间共享可写 SQLite 文件。
- 支持保存历史修订，尚未提供一键回滚界面；可以从导出的旧文本再次编辑恢复。

## 验证

```sh
python3 -m unittest discover -s tests -p test_idea_workbench.py -v
node --check idea_workbench/static/app.js
node tests/test_idea_workbench_layout.cjs
node tests/test_idea_workbench_gestures.cjs
python3 -m unittest discover -s tests -p test_idea_workbench_desktop.py -v
# 打包后：验证包内链接、独立运行环境、静态页面、保存记录和退出清理。
python3 idea_workbench/desktop/smoke.py "/path/to/IdeaFlow.app"
```

仅测试与示例运行不调用付费模型。源码以 MIT 许可证公开发布，配套 Skill 随仓库提供；当前未发布到插件市场。
