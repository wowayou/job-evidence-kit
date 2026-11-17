# 配置与命令

> Status: active
> Updated: 2026-11-17
> Intended user: 本地工具使用者及维护者。
> Operating boundary: 显式JSON配置与本地命令，计划生成不启动浏览器或网络。
> Risks and failure modes: 配置路径失效、城市代码错误、历史库过期、把目标工资当接受底线、条件未知时误判。
> Sources: scripts/job_workflow.py、examples/config.example.json与对应测试。

从`examples/config.example.json`复制一份到项目外，修改个人条件。文件只能包含声明字段；未知字段、重复键、NaN、越界上限与缺失输入先报错。相对文件路径以配置文件所在目录为基准，不按当前终端目录猜测。

- `version=1`、`source=boss`。目前浏览计划只有BOSS适配器；现有离线工具仍接受多来源材料。
- `searches`为1–3组`keyword/city_code/city_label`。城市代码需本人核对实际页面；配置中的city_label用于阅读，不证明代码映射正确。
- `limits`全局：`max_jobs`1–3、`max_pages`1–2、`max_seconds`30–180、`min_action_seconds`5–30。默认3/2/180/8；无自动重试、导航并发1。
- `review.context`显式规则/能力文件，最多8个；`known_jobs`为历史JSON或null。缺失时提示，不能说无重复或已符合个人条件。
- `review.rules.allowed_locations`为地区关键词；业务归属、固定单休、广告独立操盘的开关由个人边界决定。首版不自动判断远程雇用资格、通勤或行业战略池。
- `target_salary_min`仅目标提示，`salary_review_floor`仅低区间复核提示，均可null；不自动拒绝公开薪资未知，也不授权接受低薪。
- `storage.output_root`须在项目外。review/prepare不传`--output`时在该目录生成新批次；显式输出也须项目外且不存在。

```bash
python -B scripts/job_workflow.py validate --config /outside-project/my.config.json
python -B scripts/job_workflow.py plan --config /outside-project/my.config.json --output /outside-project/browser-plan.json
python -B scripts/job_workflow.py review --config /outside-project/my.config.json /outside-project/browser-capture.json
python -B scripts/job_workflow.py prepare --config /outside-project/my.config.json /outside-project/jd.txt
```

`validate`与`plan`只读配置和显式上下文/索引，不联网。plan不包含review/storage，须在扩展中导入后亲自点击开始。`review`接受扩展JSON（schema 1），拒绝超配置限额与空成功包；保留停止原因和完整原URL，生成HTML/Markdown及JSON。`prepare`将已有文本/截图/录屏交给原离线工具，不额外安装工具。

输入JSON允许的岗位字段：`source_url, observed_at, title, company, location, salary_text, text, collection_method=dom`；正文单岗最多50000字符。输出原始浏览数据可能含未知参数，分享前人工检查；不要上传到公开仓库。
