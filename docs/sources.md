# 来源与验证边界

> Status: active
> Updated: 2026-11-17
> Intended user: 工具使用者、维护者与公开项目审阅者。
> Operating boundary: 实现与风险依据，不授予网站权限，不替代平台协议判断。
> Risks and failure modes: 文档/条款变化、选择器变化、未经平台许可使用工具、公开接口误当无限授权。
> Sources: 下列Chrome、Playwright、BOSS及GitHub官方文档。
> Verification date: 2026-11-17（资料核验；真实BOSS自动浏览未在本版本验收）。

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)：用户触发对当前标签页的临时访问；同源导航可保留，跨源/关闭撤销，不覆盖所有标签。
- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)：脚本注入所需权限与主frame行为；扩展不申请cookies、debugger或全站权限。
- [MV3后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：后台可被终止，不能依赖长期全局变量维持任务。本实现不做自动后台重启。
- [Chrome远程调试限制](https://developer.chrome.com/blog/remote-debugging-port)与[Playwright](https://playwright.dev/docs/api/class-browsertype)：日常默认用户目录不应作为通用自动化profile；本版采用用户触发扩展，不导出或复制登录态。
- [BOSS官方协议](https://about.zhipin.com/agreement?id=registerprotocol)：官方详情接口于核验日返回20260617v2（更新字段20260617），第七条第5/7项限制未经许可借助插件/第三方工具接入取数及爬虫/拟人程序等非正常采集。用户授权代理不等于平台许可；低频不构成账号安全保证。本项目不绕登录、人机验证或访问拒绝，不传播真实岗位数据集。
- [GitHub许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)：本项目以MIT许可代码；不据此许可第三方网站内容或个人资料。

没有CI、定时、托管服务、外部模型API或遥测。FFmpeg/Tesseract/Chrome由使用者自行安装，不随项目打包。实际检查及未验收项见[ACCEPTANCE](../ACCEPTANCE.md)。
