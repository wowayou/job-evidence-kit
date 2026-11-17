"""Workflow acceptance: config, identity conflicts, negative/unknown facts, private outputs."""
import copy
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import job_capture as capture
import job_workflow as workflow

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='workflow-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.example=Path(__file__).resolve().parents[2]/'examples'
        for name in ['config.example.json','known-jobs.example.json','rules.example.md','browser-capture.example.json']:
            (self.root/name).write_bytes((self.example/name).read_bytes())
        self.path=self.root/'config.example.json'
        self.config=workflow.load_config(self.path)
        self.source=self.root/'browser-capture.example.json'
        self.batch=json.loads(self.source.read_text())
        self.job=self.batch['jobs'][0]
        self.out=self.root/'out'
        self.known=capture.load_known_jobs(self.root/'known-jobs.example.json')

    def write_config(self,value):
        self.path.write_text(json.dumps(value,ensure_ascii=False))

    def write_batch(self,value):
        self.source.write_text(json.dumps(value,ensure_ascii=False))

    def test_config_resolves_only_explicit_inputs_and_plan_omits_private_config(self):
        self.assertEqual(self.config['review']['context'],[str(self.root/'rules.example.md')])
        plan=workflow.browser_plan(self.config)
        self.assertEqual(set(plan),{'version','source','searches','limits'})
        self.assertNotIn('review',plan)
        self.assertNotIn(str(self.root),json.dumps(plan))
        with patch('socket.socket',side_effect=AssertionError('no network')):
            workflow.load_config(self.path)

    def test_unknown_keys_types_and_limits_fail_before_output(self):
        original=json.loads(self.path.read_text())
        bad=[]
        for key,value in [('extra',True),('source','untrusted'),('version',True),('searches',[])]:
            x=copy.deepcopy(original);x[key]=value;bad.append(x)
        for key,value in [('max_jobs',4),('max_pages',3),('max_seconds',181),('min_action_seconds',4),('max_jobs',True)]:
            x=copy.deepcopy(original);x['limits'][key]=value;bad.append(x)
        x=copy.deepcopy(original);x['review']['rules']['require_employer_owned']='yes';bad.append(x)
        x=copy.deepcopy(original);x['storage']['output_root']=str(workflow.ROOT/'private');bad.append(x)
        for value in bad:
            with self.subTest(value=value):
                self.write_config(value)
                with self.assertRaises(capture.CaptureError): workflow.load_config(self.path)
                self.assertFalse(self.out.exists())
        self.path.write_text('{"version":1,"version":2}')
        with self.assertRaises(capture.CaptureError): workflow.load_config(self.path)
        self.path.write_text('{"test":NaN}')
        with self.assertRaises(capture.CaptureError): workflow.load_config(self.path)

    def test_same_id_with_unknown_parameters_is_candidate_not_auto_merge(self):
        hints=workflow.duplicate_candidates(self.job,self.known)
        self.assertEqual(hints[0]['tier'],'same_platform_id_review')
        self.assertFalse(hints[0]['automatic_merge'])
        self.assertIn('已结束',hints[0]['process_status'])
        for query in ['?jobAdId=A','?jobAdId=B','?jobId=','?x=1&x=2']:
            job=dict(self.job,source_url=self.job['source_url'].split('?')[0]+query)
            self.assertEqual(workflow.duplicate_candidates(job,self.known)[0]['tier'],'same_platform_id_review')

    def test_exact_link_is_record_hint_not_application(self):
        job=dict(self.job,source_url=self.job['source_url'].split('?')[0])
        hints=workflow.duplicate_candidates(job,self.known)
        self.assertEqual(hints[0]['tier'],'same_detail_url')
        result=workflow.screen(job,workflow.extract_facts(job),hints,self.config['review']['rules'])
        self.assertEqual(result['status'],'existing_record_review')
        self.assertFalse(result['automatic_application'])

    def test_different_platform_and_id_never_inherit_same_job_identity(self):
        for url in ['https://www.zhipin.com/job_detail/other_id.html',
                    'https://www.yupao.com/zhaogong/100000001.html']:
            job=dict(self.job,source_url=url)
            hints=workflow.duplicate_candidates(job,self.known)
            self.assertEqual(hints[0]['tier'],'same_company_review')
            self.assertNotIn('salary',hints[0])
            job['company']='另一公司'
            self.assertEqual(workflow.duplicate_candidates(job,self.known),[])

    def test_unknown_schedule_and_pay_never_exclude(self):
        job=dict(self.job,text='负责公司自有产品网站内容。',salary_text='')
        facts=workflow.extract_facts(job)
        result=workflow.screen(job,facts,[],self.config['review']['rules'])
        self.assertEqual(facts['schedule']['value'],'unknown')
        self.assertEqual(result['status'],'review_ready')
        self.assertEqual(result['reasons'],[])
        self.assertIsNone(facts['salary']['fixed_monthly'])

    def test_salary_range_and_13th_month_never_become_fixed_pay(self):
        value=workflow.extract_facts(self.job)['salary']
        self.assertEqual((value['range_min'],value['range_max'],value['salary_months']),(8000,10000,13))
        self.assertIsNone(value['fixed_monthly'])

    def test_explicit_blockers_and_contradictions_are_distinct(self):
        for text,field,value in [
            ('固定单休。','schedule','fixed_single_rest'),
            ('为外部客户提供代运营服务。','business_ownership','client_marketing'),
            ('独立负责Google Ads广告账户与预算。','independent_ads','independent_required')]:
            with self.subTest(text=text):
                job=dict(self.job,text=text)
                facts=workflow.extract_facts(job)
                self.assertEqual(facts[field]['value'],value)
                result=workflow.screen(job,facts,[],self.config['review']['rules'])
                self.assertEqual(result['status'],'exclude_candidate')
                self.assertTrue(facts[field]['evidence'][0]['quote'])
        job=dict(self.job,text='负责公司自有产品网站。\n为外部客户提供代运营服务。\n长期单休。\n固定双休。')
        facts=workflow.extract_facts(job)
        self.assertEqual(facts['business_ownership']['value'],'conflict')
        self.assertEqual(facts['schedule']['value'],'conflict')
        self.assertEqual(workflow.screen(job,facts,[],self.config['review']['rules'])['status'],'needs_review')

    def test_negations_and_uncertain_language_are_not_hard_blockers(self):
        for line in ['不为外部客户提供代运营服务。','不要求独立负责Google Ads广告账户。',
                     '不是固定单休。','长期单休不是本岗要求。','单休或双休待定。',
                     '并不负责公司自有产品网站。','大小周，不是长期单休。']:
            with self.subTest(line=line):
                job=dict(self.job,text=line)
                facts=workflow.extract_facts(job)
                self.assertEqual(workflow.screen(job,facts,[],self.config['review']['rules'])['reasons'],[])
        facts=workflow.extract_facts(dict(self.job,text='并不负责公司自有产品网站。'))
        self.assertNotEqual(facts['business_ownership']['value'],'employer_owned')

    def test_missing_identity_is_blocking_not_invented(self):
        job=dict(self.job,title='',company='',location='',text='内容编辑')
        result=workflow.screen(job,workflow.extract_facts(job),[],self.config['review']['rules'])
        self.assertEqual(result['status'],'needs_review')
        self.assertGreaterEqual(len(result['blocking_questions']),3)

    def test_partial_batch_preserved_and_report_escapes_html(self):
        self.batch['status']='stopped';self.batch['stop_reason']='用户停止'
        self.job['title']='<script>alert(1)</script>'
        self.job['text']+='\n<script>evil()</script>'
        self.write_batch(self.batch)
        manifest=workflow.review_batch(self.config,self.source,self.out)
        self.assertEqual(manifest['capture_status'],'stopped')
        self.assertEqual(manifest['new_applications'],0)
        page=(self.out/'review.html').read_text()
        self.assertNotIn('<script>',page)
        self.assertIn('&lt;script&gt;',page)
        self.assertNotIn('securityId=',page)
        data=json.loads((self.out/'jobs.json').read_text())
        self.assertEqual(data[0]['source_url'],self.job['source_url'])
        self.assertEqual(json.loads((self.out/'source.json').read_text()),self.batch)

    def test_invalid_batch_does_not_create_output_and_empty_completed_rejected(self):
        for key,value in [('schema_version',True),('jobs',[]),('status','unknown'),('source','other')]:
            batch=copy.deepcopy(self.batch);batch[key]=value;self.write_batch(batch)
            with self.subTest(key=key),self.assertRaises(capture.CaptureError):
                workflow.review_batch(self.config,self.source,self.out)
            self.assertFalse(self.out.exists())
        batch=copy.deepcopy(self.batch);batch['jobs'][0]['source_url']='https://user:secret@www.zhipin.com/job_detail/id.html'
        self.write_batch(batch)
        with self.assertRaises(capture.CaptureError): workflow.load_batch(self.source,self.config)

    def test_empty_stopped_batch_has_no_candidates(self):
        batch=dict(self.batch,jobs=[],status='stopped',stop_reason='验证阻断')
        self.write_batch(batch)
        result=workflow.review_batch(self.config,self.source,self.out)
        self.assertEqual(result['job_count'],0)
        self.assertIn('本批未保存岗位',(self.out/'review.html').read_text())

    def test_same_batch_duplicates_are_hints_without_deleting_evidence(self):
        self.batch['jobs'].append(copy.deepcopy(self.job))
        self.write_batch(self.batch)
        workflow.review_batch(self.config,self.source,self.out)
        jobs=json.loads((self.out/'jobs.json').read_text())
        self.assertEqual(len(jobs),2)
        self.assertTrue(any(x['card']=='batch:job-1' for x in jobs[1]['duplicates']))

    def test_existing_output_and_input_inside_project_rejected(self):
        self.out.mkdir();(self.out/'keep').write_text('keep')
        with self.assertRaises(capture.CaptureError): workflow.review_batch(self.config,self.source,self.out)
        self.assertEqual((self.out/'keep').read_text(),'keep')
        with self.assertRaises(capture.CaptureError):
            workflow.load_batch(self.example/'browser-capture.example.json',self.config)

    def test_plan_and_validation_are_network_free_and_never_overwrite(self):
        target=self.root/'plan.json'
        with patch('socket.socket',side_effect=AssertionError('network')),redirect_stdout(io.StringIO()):
            self.assertEqual(workflow.main(['plan','--config',str(self.path),'--output',str(target)]),0)
        result=json.loads(target.read_text())
        self.assertEqual(result['limits']['max_jobs'],3)
        with redirect_stderr(io.StringIO()):
            self.assertEqual(workflow.main(['plan','--config',str(self.path),'--output',str(target)]),2)

if __name__=='__main__': unittest.main()
