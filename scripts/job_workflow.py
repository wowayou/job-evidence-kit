#!/usr/bin/env python3
"""Configurable local job workflow; browser navigation lives in the optional extension."""
import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit

import job_capture as capture

ROOT = Path(__file__).resolve().parents[1]
LIMITS = {"max_jobs": (1, 3, 3), "max_pages": (1, 2, 2),
          "max_seconds": (30, 180, 180), "min_action_seconds": (5, 30, 8)}
RULE_KEYS = {"allowed_locations", "require_employer_owned", "exclude_fixed_single_rest",
             "exclude_independent_ads", "target_salary_min", "salary_review_floor"}


def fail(message):
    raise capture.CaptureError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("JSON存在重复键；不采用隐式覆盖。")
        result[key] = value
    return result


def read_json(path):
    try:
        return json.loads(capture.read_text(path), object_pairs_hook=unique_object,
                          parse_constant=lambda value: fail("JSON不接受NaN或Infinity。"))
    except (ValueError, OSError):
        fail("无法读取JSON文件；请检查文件、编码和格式。")


def shape(value, allowed, required, label):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        fail(f"{label}字段缺失或含未知字段。")


def text(value, label, maximum=300, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)
            or (not empty and not value.strip())):
        fail(f"{label}须为有效文本，最多{maximum}字符。")
    return value


def validate_limits(value):
    shape(value, LIMITS, LIMITS, "limits")
    for key, (low, high, _) in LIMITS.items():
        if type(value[key]) is not int or not low <= value[key] <= high:
            fail(f"limits.{key}须为{low}–{high}的整数。")
    return dict(value)


def load_config(path):
    path = path.expanduser().resolve()
    data = read_json(path)
    shape(data, {"version", "source", "searches", "limits", "review", "storage"},
          {"version", "source", "searches", "limits", "review", "storage"}, "配置")
    if type(data["version"]) is not int or data["version"] != 1 or data["source"] != "boss":
        fail("仅支持version=1、source=boss的浏览计划；不会自动换来源。")
    if not isinstance(data["searches"], list) or not 1 <= len(data["searches"]) <= 3:
        fail("searches须包含1–3组关键词/城市。")
    for search in data["searches"]:
        shape(search, {"keyword", "city_code", "city_label"},
              {"keyword", "city_code", "city_label"}, "search")
        text(search["keyword"], "keyword", 60)
        text(search["city_label"], "city_label", 60)
        if not isinstance(search["city_code"], str) or not re.fullmatch(r"[0-9]{9}", search["city_code"]):
            fail("city_code须为显式9位城市代码；工具不猜城市映射。")
    validate_limits(data["limits"])
    review = data["review"]
    shape(review, {"context", "known_jobs", "rules"}, {"context", "known_jobs", "rules"}, "review")
    if not isinstance(review["context"], list) or len(review["context"]) > 8:
        fail("review.context须为最多8个路径的数组。")
    def resolve(raw):
        text(raw, "文件路径", 4096)
        p = Path(raw).expanduser()
        return str((path.parent / p).resolve() if not p.is_absolute() else p.resolve())
    review["context"] = [resolve(raw) for raw in review["context"]]
    if review["known_jobs"] is not None:
        review["known_jobs"] = resolve(review["known_jobs"])
    rules = review["rules"]
    shape(rules, RULE_KEYS, RULE_KEYS, "review.rules")
    locations = rules["allowed_locations"]
    if not isinstance(locations, list) or not 1 <= len(locations) <= 20:
        fail("allowed_locations须为1–20个地区。")
    for item in locations:
        text(item, "地区", 60)
    for key in ["require_employer_owned", "exclude_fixed_single_rest", "exclude_independent_ads"]:
        if type(rules[key]) is not bool:
            fail(f"{key}须为布尔值。")
    for key in ["target_salary_min", "salary_review_floor"]:
        if rules[key] is not None and (type(rules[key]) not in (int, float) or not 0 < rules[key] <= 1000000):
            fail(f"{key}须为空或正金额；金额仅提示核实，不自动作固定工资。")
    shape(data["storage"], {"output_root"}, {"output_root"}, "storage")
    data["storage"]["output_root"] = str(capture.outside_repo(Path(resolve(data["storage"]["output_root"]))))
    capture.load_review_inputs(SimpleNamespace(context=review["context"], known_jobs=review["known_jobs"]))
    return data


def browser_plan(config):
    return {key: config[key] for key in ["version", "source", "searches", "limits"]}


def instant(value):
    text(value, "时间", 80)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
    except ValueError:
        fail("采集时间须为带时区的ISO时间。")
    return value


def detail_link(url):
    text(url, "source_url", 8192)
    parsed = capture.source_links(url)
    if len(parsed) != 1 or parsed[0]["kind"] != "detail" or parsed[0]["original_url"] != url:
        fail("source_url须为完整受支持详情链接，不接受凭据、图片或非HTTP(S)地址。")
    return parsed[0]


def load_batch(path, config):
    path = capture.outside_repo(path)
    batch = read_json(path)
    fields = {"schema_version", "source_kind", "capture_id", "created_at", "status", "stop_reason",
              "source", "limits", "jobs", "warnings"}
    shape(batch, fields, fields, "浏览材料")
    if (type(batch["schema_version"]) is not int or batch["schema_version"] != 1
            or batch["source_kind"] != "browser_capture" or batch["source"] != "boss"):
        fail("浏览材料版本/来源不支持。")
    text(batch["capture_id"], "capture_id", 120)
    instant(batch["created_at"])
    if batch["status"] not in {"completed", "stopped", "failed"}:
        fail("浏览材料状态无效。")
    text(batch["stop_reason"], "stop_reason", 2000, empty=True)
    validate_limits(batch["limits"])
    for key in ("max_jobs", "max_pages", "max_seconds"):
        if batch["limits"][key] > config["limits"][key]:
            fail("材料声明上限超过本次配置；不静默截断或采用另一配置。")
    if batch["limits"]["min_action_seconds"] < config["limits"]["min_action_seconds"]:
        fail("材料声明操作间隔小于本次配置。")
    if (not isinstance(batch["warnings"], list) or len(batch["warnings"]) > 100
            or not isinstance(batch["jobs"], list) or len(batch["jobs"]) > batch["limits"]["max_jobs"]):
        fail("浏览材料jobs/warnings超限或格式错误。")
    for warning in batch["warnings"]:
        text(warning, "warning", 2000)
    fields = {"source_url", "observed_at", "title", "company", "location", "salary_text", "text", "collection_method"}
    for job in batch["jobs"]:
        shape(job, fields, fields, "岗位")
        link = detail_link(job["source_url"])
        if link["platform"] != "boss" or job["collection_method"] != "dom":
            fail("BOSS浏览包须为BOSS详情和dom来源；不改写来源。")
        instant(job["observed_at"])
        for key in ["title", "company", "location", "salary_text"]:
            text(job[key], key, 500, empty=True)
        if not isinstance(job["text"], str) or not job["text"].strip() or len(job["text"]) > 50000 or "\0" in job["text"]:
            fail("岗位正文须为非空文本且不超过50000字符。")
    if not batch["jobs"] and batch["status"] == "completed":
        fail("空批次不能标采集完成；保留真实停止原因。")
    return batch


def duplicate_candidates(job, known):
    link = detail_link(job["source_url"])
    result = []
    company = re.sub(r"\s+", "", job["company"]).casefold()
    for item in known:
        old = [x for entry in item["links"] for x in capture.source_links(entry["url"])
               if x["kind"] == "detail"]
        exact = any(x["url"] == link["url"] for x in old)
        identity = any((x["platform"], x["job_id"]) == (link["platform"], link["job_id"]) for x in old)
        name = bool(company) and company == re.sub(r"\s+", "", item["company"]).casefold()
        tier = "same_detail_url" if exact else "same_platform_id_review" if identity else "same_company_review" if name else None
        if tier:
            result.append({"tier": tier, "card": item["card"], "company": item["company"],
                           "role": item["role"], "process_status": item["process_status"],
                           "automatic_merge": False, "query_values_shown": False})
    return result


def evidence(value, lines):
    return {"value": value, "evidence": [{"line": n, "quote": line} for n, line in lines]}


def extract_facts(job):
    numbered = [(n, line.strip()) for n, line in enumerate(job["text"].splitlines(), 1) if line.strip()]
    def matches(pattern):
        return [(n, line) for n, line in numbered if re.search(pattern, line, re.I)]
    def unnegated(lines, term):
        result = []
        for n, line in lines:
            hit = re.search(term, line, re.I)
            if hit and not re.search(r"不|非|无需|无须|待定|待确认|可选|视情况|大小周|单双休", line):
                result.append((n, line))
        return result
    own = unnegated(matches(r"(?:公司|雇主|本公司|集团)(?:的)?(?:自有|自营)(?:产品|品牌|网站|业务|服务|渠道)"), r"(?:自有|自营)")
    agency = unnegated(matches(r"(?:为|向)(?:外部)?客户.{0,12}(?:代运营|SEO服务|广告投放服务|营销服务)"),
                      r"(?:为|向)(?:外部)?客户")
    ownership = "conflict" if own and agency else "employer_owned" if own else "client_marketing" if agency else "unknown"
    single = unnegated(matches(r"(?:长期|固定|每周)(?:实行|安排|为|是|休息)?(?:单休|休一(?:天|日))"),
                       r"(?:长期|固定|每周).{0,8}(?:单休|休一)")
    double = unnegated(matches(r"(?:周末|固定|每周)?双休"), r"双休")
    schedule = "conflict" if single and double else "fixed_single_rest" if single else "double_rest" if double else "unknown"
    ads = unnegated(matches(r"(?:独立负责|独立操作|独立操盘).{0,30}(?:Google\s*Ads|Meta\s*Ads|广告账户|投放预算|ROI)"),
                    r"(?:独立负责|独立操作|独立操盘)")
    ads_no = matches(r"(?:不要求|无需|无须|不承担).{0,15}(?:独立).{0,30}(?:广告|Ads|投放)")
    ad_value = "conflict" if ads and ads_no else "independent_required" if ads else "not_required" if ads_no else "unknown"
    salary = job["salary_text"]
    salary_range = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*[-–—~]\s*(\d+(?:\.\d+)?)\s*[kK]", salary)
    months = re.search(r"(\d{2})\s*薪", salary)
    return {"business_ownership": evidence(ownership, own + agency),
            "schedule": evidence(schedule, single + double), "independent_ads": evidence(ad_value, ads + ads_no),
            "salary": {"raw": salary, "range_min": float(salary_range[1])*1000 if salary_range else None,
                       "range_max": float(salary_range[2])*1000 if salary_range else None,
                       "salary_months": int(months[1]) if months else None, "fixed_monthly": None,
                       "evidence": "captured salary_text; advertised range is not fixed pay"}}


def screen(job, facts, duplicates, rules):
    reasons, pending, blockers = [], [], []
    if not job["title"] or not job["company"]:
        blockers.append("缺少公司或岗位标题，须回原页核对。")
    if not job["location"]:
        blockers.append("地区未读到；不能推定符合地区要求。")
    elif not any(place.casefold() in job["location"].casefold() for place in rules["allowed_locations"]):
        blockers.append("地区未匹配配置；远程资格或具体办公地待核，不自动改地区。")
    if rules["require_employer_owned"]:
        value = facts["business_ownership"]["value"]
        if value == "client_marketing":
            reasons.append("正文明确呈现为客户提供营销交付，触发业务归属排除规则。")
        elif value != "employer_owned":
            blockers.append("业务归属未知或冲突：主要服务雇主自有业务，还是外部客户营销交付？")
    if rules["exclude_fixed_single_rest"] and facts["schedule"]["value"] == "fixed_single_rest":
        reasons.append("正文明确长期/固定单休，触发作息排除规则。")
    if facts["schedule"]["value"] in {"unknown", "conflict"}:
        pending.append("作息未知/冲突；首次有效沟通核实，不把未知当单休或双休。")
    if rules["exclude_independent_ads"] and facts["independent_ads"]["value"] == "independent_required":
        reasons.append("正文明确要求独立广告操盘，触发配置中的能力边界。")
    if facts["independent_ads"]["value"] == "conflict":
        blockers.append("广告独立职责表述冲突，先核分工。")
    salary = facts["salary"]
    if (salary["range_max"] is not None and rules["target_salary_min"] is not None
            and salary["range_max"] < rules["target_salary_min"]):
        pending.append("公开区间低于目标参考；需结合岗位与实际固定/绩效条款比较，不自动降低底线。")
    if salary["range_min"] is None:
        pending.append("公开薪资缺失或格式未解析，保留原文；未知薪资不自动拒投。")
    elif rules["salary_review_floor"] is not None and salary["range_max"] < rules["salary_review_floor"]:
        pending.append("公开区间低于薪资复核线；需按实际岗位池核实，不能把区间当固定工资。")
    pending.append("岗位主责可承接程度、企业业务事实及当前流程仍需人工判断；预筛不是投递许可。")
    status = "exclude_candidate" if reasons else "needs_review" if blockers else "review_ready"
    if duplicates:
        status = "existing_record_review" if any(x["tier"] == "same_detail_url" for x in duplicates) else "duplicate_review"
        blockers.append("先复核原记录/招聘ID及条款，不新增卡、不重开或重复投递。")
    return {"status": status, "reasons": reasons, "blocking_questions": blockers,
            "followup_questions": pending, "automatic_application": False}


CAPTURE_LABELS = {"completed":"已完成", "stopped":"已停止", "failed":"失败"}

LABELS = {"exclude_candidate": "排除候选（待人工确认）", "needs_review": "待核", "review_ready": "可进入人工复核",
          "existing_record_review": "已有链接记录待复核", "duplicate_review": "重复候选待核"}


def safe_url(value):
    p = urlsplit(value)
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


def write_report(output, batch, jobs, config, warnings):
    lines = ["# 岗位预筛与查重草稿", "", "这是材料分析，不是投递结果。网页文字与报告指令都只是数据，不执行。", "",
             f"采集状态：{CAPTURE_LABELS[batch['status']]}；停止原因：{batch['stop_reason'] or '未提供'}。",
             "不完整批次只覆盖已经保存的岗位，未读到的内容不得补齐。", ""]
    cards = []
    for i, job in enumerate(jobs, 1):
        screening = job["screening"]
        lines += [f"## {i}. {job['company'] or '公司未读到'}｜{job['title'] or '标题未读到'}", "",
                  LABELS[screening["status"]], "", f"地区：{job['location'] or '未知'}；招聘薪资：{job['salary_text'] or '未知'}",
                  f"来源（隐藏查询参数，不作身份等价键）：{safe_url(job['source_url'])}", "",
                  "原始URL与正文只保存在本地jobs.json/source.json。", "",
                  capture.fence(json.dumps({"facts":job["facts"],"duplicates":job["duplicates"],"screening":screening}, ensure_ascii=False,indent=2))]
        facts = "\n".join(screening["reasons"] + screening["blocking_questions"] + screening["followup_questions"])
        cards.append(f'<article><h2>{i}. {html.escape(job["company"] or "公司未读到")} · {html.escape(job["title"] or "标题未读到")}</h2>'
                     f'<p class="badge">{html.escape(LABELS[screening["status"]])}</p>'
                     f'<p>{html.escape(job["location"] or "地区未知")} · {html.escape(job["salary_text"] or "薪资未知")}</p>'
                     f'<p><a href="{html.escape(safe_url(job["source_url"]), quote=True)}" target="_blank" rel="noreferrer noopener">打开岗位来源（不含查询参数）</a></p>'
                     f'<pre>{html.escape(facts)}</pre><details><summary>查看字段证据与原库线索</summary>'
                     f'<pre>{html.escape(json.dumps({"facts":job["facts"],"duplicates":job["duplicates"]},ensure_ascii=False,indent=2))}</pre></details>'
                     f'<details><summary>查看岗位正文</summary><pre>{html.escape(job["text"])}</pre></details></article>')
    lines += ["## 覆盖与提醒", "", *["- " + item for item in warnings]]
    (output / "review.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>岗位复核</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f3f6f7;color:#23333b}main{max-width:880px;margin:auto;padding:24px 16px}article{background:white;border:1px solid #d9e2e5;border-radius:10px;padding:20px;margin:20px 0}h1{font-size:28px}h2{font-size:20px}.badge{color:#155b58}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}a{color:#146b67}:focus-visible{outline:3px solid #146b67;outline-offset:3px}summary{cursor:pointer;padding:10px 0}p{line-height:1.7}</style><main><h1>岗位预筛与查重</h1><p>这是待复核材料，不代表已投递。未知条件保持未知。</p>'
    page += f'<p role="status">采集状态：{html.escape(CAPTURE_LABELS[batch["status"]])} · 保存 {len(jobs)} 个岗位</p>'
    page += f'<p>{html.escape(batch["stop_reason"])}</p>' + ("".join(cards) if cards else '<p>本批未保存岗位，请查看停止原因；没有产生候选建议。</p>')
    page += '<h2>覆盖与提醒</h2><ul>'+''.join('<li>'+html.escape(w)+'</li>' for w in warnings)+'</ul></main></html>'
    (output / "review.html").write_text(page,encoding="utf-8")


def review_batch(config, source, output):
    output = capture.outside_repo(output)
    if output.exists():
        fail("输出目录已存在；不覆盖旧结果。")
    batch = load_batch(source, config)
    known, contexts = capture.load_review_inputs(SimpleNamespace(**{k:config['review'][k] for k in ['context','known_jobs']}))
    warnings = list(batch["warnings"])
    if batch["status"] != "completed":
        warnings.append("浏览批次未完成；仅整理已保存岗位，不冒充完整检索。")
    if not config["review"]["known_jobs"]:
        warnings.append("没有提供历史岗位库，空重复提示不代表新岗位。")
    if not contexts:
        warnings.append("未提供个人规则/能力上下文，需人工补充后再判断适合度。")
    jobs=[]
    comparison = list(known)
    for job in batch["jobs"]:
        facts=extract_facts(job)
        candidates=duplicate_candidates(job,comparison)
        jobs.append(dict(job, facts=facts, duplicates=candidates,
                         screening=screen(job,facts,candidates,config["review"]["rules"])))
        comparison.append({"company":job["company"], "role":job["title"],
                           "card":f"batch:job-{len(jobs)}", "process_status":"同批已采集；不是投递",
                           "links":capture.source_links(job["source_url"])})
    old=os.umask(0o077)
    try:
        output.mkdir(parents=True,exist_ok=False,mode=0o700)
        capture.save_json(output/'manifest.json',{'schema_version':1,'status':'processing'})
        capture.save_json(output/'source.json',batch)
        capture.save_json(output/'jobs.json',jobs)
        capture.save_json(output/'known-jobs.json',known)
        (output/'context.md').write_text('\n\n'.join(f'# {name}\n\n{value}' for name,value in contexts) or '# 未提供个人上下文\n',encoding='utf-8')
        write_report(output,batch,jobs,config,warnings)
        manifest={'schema_version':1,'status':'ready_for_review','capture_status':batch['status'],
                  'job_count':len(jobs),'new_applications':0,'warnings':warnings,
                  'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                  'context':[{'path':name,'sha256':hashlib.sha256(value.encode()).hexdigest()} for name,value in contexts]}
        capture.save_json(output/'manifest.json',manifest)
    except (OSError,ValueError,capture.CaptureError):
        if output.is_dir():
            capture.save_json(output/'manifest.json',{'schema_version':1,'status':'failed','error':'本地报告生成失败；不当完整结果。'})
        raise
    finally:
        os.umask(old)
    return manifest


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    for name in ['validate','plan','review','prepare']:
        cmd=sub.add_parser(name)
        cmd.add_argument('--config',required=True)
        if name in {'plan','review','prepare'}:
            cmd.add_argument('--output',required=(name=='plan'), help='新文件/目录；未给时在配置output_root中生成新批次')
        if name in {'review','prepare'}:
            cmd.add_argument('input')
    args=parser.parse_args(argv)
    try:
        config=load_config(Path(args.config))
        if args.action in {'review','prepare'} and not args.output:
            stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            args.output=str(Path(config['storage']['output_root'])/f'batch-{stamp}')
        if args.action=='validate':
            print('配置有效；未联网、未创建任务或改变浏览器。')
        elif args.action=='plan':
            output=capture.outside_repo(Path(args.output))
            if output.exists(): fail('计划文件已存在；不覆盖。')
            old=os.umask(0o077)
            try:
                output.parent.mkdir(parents=True,exist_ok=True)
                with output.open('x',encoding='utf-8') as stream:
                    json.dump(browser_plan(config),stream,ensure_ascii=False,indent=2)
            finally: os.umask(old)
            print('浏览计划已生成；尚未运行。导入扩展后须本人点击开始。')
        elif args.action=='prepare':
            command=['prepare',args.input,'--output',args.output]
            for path in config['review']['context']: command+=['--context',path]
            if config['review']['known_jobs']: command+=['--known-jobs',config['review']['known_jobs']]
            return capture.main(command)
        else:
            result=review_batch(config,Path(args.input).expanduser().resolve(),Path(args.output))
            print(f'报告完成：{result["job_count"]}个岗位；采集状态{result["capture_status"]}；未投递。')
            print('本地报告：'+str(Path(args.output).resolve()/'review.html'))
        return 0
    except (capture.CaptureError,OSError) as exc:
        print('未完成：'+(str(exc) if isinstance(exc,capture.CaptureError) else '本地文件访问失败。'),file=sys.stderr)
        return 2


if __name__=='__main__':
    sys.exit(main())
