# Job Evidence Kit

> Status: active
> Updated: 2026-11-17
> Intended user: 希望保留岗位来源、核对重复并按个人规则筛选的求职者。
> Operating boundary: 本地证据整理与用户触发的有限浏览；不自动申请、发消息或代替个人决策。浏览适配器为实验功能。
> Risks and failure modes: 平台条款/账号限制、网页变化、采集不完整、规则误读、历史库过期、私人数据被分享。
> Sources: 本项目源码/合成测试与[官方资料](docs/sources.md)。

把“搜索→打开详情→保留原链接→查旧记录→按规则预筛→人工决定”串起来。工具本地运行，个人规则和材料存项目外；没有模型API、云端OCR、遥测或定时任务。

**浏览自动化目前处于实验阶段。** 已完成的测试与未测边界见[验收记录](ACCEPTANCE.md)。低频仅约束工具动作，不能保证平台允许、账号不受限或页面内部网络请求总量。

## 功能

- **可配置工作流**：一个版本化JSON配置关键词、地区、规则、上下文、历史索引及运行上限；校验/预览不发网络请求。
- **BOSS浏览采集扩展**：在用户点击图标的标签页执行有限正常导航，采集详情正文与原链接；可随时停止，遇登录/验证/跨源或缺失正文就停。不调用隐藏招聘API，不读取Cookie或复制profile。
- **多来源离线材料**：复用文本、图片、视频、原生标签页录制与本地FFmpeg/Tesseract处理；不要求所有来源都录屏。
- **分层查重**：精确详情链接、同平台同ID不同参数、同公司分别提示；保留原始参数和冲突，不自动合并、重开或再次申请。
- **可解释预筛**：有限规则提取业务归属、固定单休、独立广告要求等线索；工资区间不当固定工资，未知不补齐，给出正文证据与待核问题。
- **本地报告**：HTML、Markdown、结构化JSON；原材料、来源及采集状态可回查。报告不是投递结果。

平台使用与浏览器授权不同。BOSS现行协议限制未经许可第三方工具接入取数及非正常采集；本项目不提供平台许可、不绕验证，使用者须自行评估是否启用。详见[来源与边界](docs/sources.md)。

## 快速试用：仅合成数据，不访问网站

Python 3.10+，标准库，无pip/npm运行依赖。Node仅用于扩展/前端测试。图片和视频另需自行安装FFmpeg、ffprobe、Tesseract及`chi_sim/eng`语言包；工具不会安装依赖。

从项目根目录运行：

```bash
job_demo_dir="$(mktemp -d /tmp/job-evidence-demo.XXXXXX)"
cp examples/browser-capture.example.json "$job_demo_dir/browser-capture.json"
python -B scripts/job_workflow.py validate --config examples/config.example.json
python -B scripts/job_workflow.py review --config examples/config.example.json \
  "$job_demo_dir/browser-capture.json" --output "$job_demo_dir/review"
```

打开输出目录的`review.html`。示例使用假的公司、招聘ID和参数，不代表真实岗位。`/tmp`只是演示位置，真实材料请指定项目外稳定私有目录。

## 设置个人流程

将示例配置和规则复制到项目外，填写城市、关键词、自己的能力边界与历史索引。完整字段见[配置说明](docs/configuration.md)。

```bash
python -B scripts/job_workflow.py validate --config /outside-project/my.config.json
python -B scripts/job_workflow.py plan --config /outside-project/my.config.json \
  --output /outside-project/browser-plan.json
```

计划只包含关键词/城市/限额，不包含个人画像和历史库。默认全局最多3岗、2个搜索页、180秒、动作间隔至少8秒；导航并发1，无自动重试。额度不会按关键词重置，后面的搜索词可能本批未执行。

在Chrome扩展管理中加载本项目`extension/`（开发者模式，用户自行决定安装），然后在正常BOSS搜索/详情标签页点击扩展图标，导入浏览计划并显式开始。使用期望的浏览器profile；扩展只获得用户触发的标签权限，不核验账号身份。实际UI按钮与流程以扩展页面为准。

完成/停止后导出JSON到项目外，再运行：

```bash
python -B scripts/job_workflow.py review --config /outside-project/my.config.json \
  /outside-project/browser-capture.json
```

不传`--output`时使用配置的`storage.output_root`生成新批次。已存在结果不覆盖。阅读[工作流程与判断边界](docs/workflow.md)，核原文后再决定是否推进；工具不会修改你的看板或联系HR。

## 原有离线与录制入口

```bash
python -B scripts/job_capture.py doctor
python -B scripts/job_workflow.py prepare --config /outside-project/my.config.json \
  /outside-project/jd.txt --output /outside-project/text-review
python -B scripts/job_capture.py prepare /outside-project/video.mkv \
  --notes /outside-project/links.txt --output /outside-project/media-review
python -B scripts/job_capture.py record --output /outside-project/capture-001
```

`record`在Linux/WSL启动只监听127.0.0.1的本地录制页，本人选择单标签；不接受窗口/全屏/音频。单次180秒、96MiB、会话15分钟，不自动重启。可显式给`--context/--known-jobs`；`--open`仅支持WSL启动显式指定的Windows Chrome，须同时提供`--chrome/--user-data-dir/--profile`，不扫描或新建profile。

`prepare`只接受项目外本地文本/图像/视频，不接收URL/HTML/HAR或浏览器凭据；默认2秒抽帧、最多120帧/600秒/1GiB、媒体处理总预算10分钟。可用`--crop/--start/--duration/--psm`显式选择，不静默降级。OCR无法可靠恢复所有关键字段，须核原图；原工具真实样本曾漏读公司/地区/薪资，抽取或重构不等于已解决识别质量。

## 数据与发布

`source.json/jobs.json/context.md/known-jobs.json`与录像可能含私人数据或URL参数，全部留项目外。HTML展示URL去参数只是隐私显示，不参与身份等价计算。分享前人工检查；无自动脱敏保证。

公开仓库只含通用代码、合成测试与示例。MIT许可仅覆盖项目代码/文档，第三方平台内容与依赖分别遵守其授权；不会随包分发浏览器或媒体工具。

## 开发验证

```bash
python -B -m unittest discover -s scripts/tests -v
node scripts/tests/job_recorder.test.mjs
node tests/browser_adapter.test.mjs
node tests/browser_runner.test.mjs
node tests/browser_transport.test.mjs
git diff --check
```

测试/媒体串行运行；媒体测试在依赖缺失时明确跳过。没有CI/定时工作流，测试不访问真实岗位站点。本机HTTP测试需要允许loopback socket。真实账号/共享流程的测试另行安排，不以合成通过冒充。
