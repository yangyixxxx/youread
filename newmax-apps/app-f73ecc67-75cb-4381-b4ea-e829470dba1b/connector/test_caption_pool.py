"""节点池使用隔离目录/假控制器，不切真实出口或联网。"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError
from email.message import Message
from connector.caption_pool import CaptionPool, ClashController, PoolError, GROUP, save_json
from connector import server as s, yt_worker as yt
from connector.setup_caption_pool import enhanced_config

class Controller:
    def __init__(self, nodes=None):
        self.nodes, self.selected = nodes or ['节点A','节点B','节点C'], []
    def members(self):
        return self.nodes
    def select(self, node):
        self.selected.append(node)

class PoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        save_json(self.directory/'caption-proxy.json', {'enabled':True,'group':GROUP,'proxyUrl':'http://127.0.0.1:18883','clashConfig':'not-read-in-fake'})
        self.now = 1000
        self.control = Controller()
        self.pool = CaptionPool(self.directory, self.control, lambda:self.now, self.sleep)
    def sleep(self, seconds):
        self.now += seconds
    def make_error(self, code='RATE_LIMITED', retry_after=0):
        error = s.ConnectorError(code,'隔离错误',429)
        error.retry_after = retry_after
        return error
    def test_429_rotates_once_then_success_same_proxy_url_and_persists(self):
        calls=[]
        def fetch(proxy):
            calls.append(proxy)
            if len(calls)==1: raise self.make_error()
            return {'raw':'成功'}
        self.assertEqual(self.pool.fetch(fetch),{'raw':'成功'})
        self.assertEqual(self.control.selected,['节点A','节点B'])
        self.assertEqual(calls,['http://127.0.0.1:18883']*2)
        self.assertEqual(self.now,1020)
        self.assertEqual(self.pool.state['cooldowns']['节点A'],2800)
        reloaded=CaptionPool(self.directory,self.control,lambda:self.now,self.sleep)
        reloaded.warmup()
        self.assertEqual(reloaded.status()['cooling'],1)
    def test_all_429_limited_to_three_no_repeat_during_cooldown(self):
        calls=[]
        def fetch(proxy):
            calls.append(proxy)
            raise self.make_error()
        with self.assertRaises(PoolError) as caught:self.pool.fetch(fetch)
        self.assertEqual(caught.exception.code,'CAPTION_COOLDOWN')
        self.assertEqual(len(calls),3)
        self.assertEqual(self.now,1040)
        self.assertEqual(self.pool.status()['available'],0)
        with self.assertRaises(PoolError):self.pool.fetch(fetch)
        self.assertEqual(len(calls),3)
        self.assertFalse(self.pool.running)
    def test_retry_after_honored_and_failed_node_recovers(self):
        self.control.nodes=['节点A']
        with self.assertRaises(PoolError):self.pool.fetch(lambda p:(_ for _ in ()).throw(self.make_error(retry_after=7200)))
        self.assertEqual(self.pool.state['cooldowns']['节点A'],8200)
        self.now=8201
        self.assertEqual(self.pool.fetch(lambda p:'恢复'),'恢复')
    def test_no_captions_does_not_rotate_or_call_paid(self):
        with self.assertRaises(s.ConnectorError):self.pool.fetch(lambda p:(_ for _ in ()).throw(self.make_error('NO_CAPTIONS')))
        self.assertEqual(self.control.selected,['节点A'])
        self.assertEqual(self.pool.state['cooldowns'],{})
        self.assertEqual(self.pool.status()['paidFallback'],'not_configured')
    def test_stopping_interrupts_interval(self):
        self.pool.state['lastRequest']=1000
        with self.assertRaises(PoolError) as caught:self.pool.fetch(lambda p:self.make_error(),lambda:True)
        self.assertEqual(caught.exception.code,'STOPPING')
        self.assertEqual(self.control.selected,[])
    def test_controller_failure_never_falls_back_to_shared_exit(self):
        self.control.members=MagicMock(side_effect=PoolError('CLASH_UNAVAILABLE','不可用'))
        call=MagicMock()
        with self.assertRaises(PoolError):self.pool.fetch(call)
        call.assert_not_called()
    def test_disabled_uses_existing_behavior_and_invalid_local_url_rejected(self):
        self.pool.config['enabled']=False
        self.assertEqual(self.pool.fetch(lambda proxy:proxy),None)
        self.assertEqual(self.control.selected,[])
        for proxy in ['http://evil.com:18883','http://user:pass@127.0.0.1:18883','https://127.0.0.1:18883','http://127.0.0.1:80']:
            save_json(self.directory/'caption-proxy.json',{'enabled':True,'group':GROUP,'proxyUrl':proxy,'clashConfig':'unused'})
            with self.assertRaises(PoolError):CaptionPool(self.directory,self.control)
    def test_corrupt_cooldown_not_silently_reset(self):
        (self.directory/'caption-pool-state.json').write_text('bad',encoding='utf-8')
        with self.assertRaises(PoolError):CaptionPool(self.directory,self.control)
        self.assertEqual((self.directory/'caption-pool-state.json').read_text(),'bad')
    def test_maximum_three_of_many_nodes(self):
        self.control.nodes=[str(i) for i in range(8)]
        with self.assertRaises(PoolError):self.pool.fetch(lambda p:(_ for _ in ()).throw(self.make_error()))
        self.assertEqual(len(self.control.selected),3)

class BoundaryTests(unittest.TestCase):
    def test_private_group_only_and_switch_verified(self):
        c=ClashController('not-read')
        c.request=MagicMock(side_effect=[{'type':'Selector','all':['A'],'now':'A'}, {}, {'now':'A'}])
        self.assertEqual(c.members(),['A']);c.select('A')
        self.assertTrue(all('/proxies/' in x.args[1] and 'GLOBAL' not in x.args[1] for x in c.request.call_args_list))
        c.request=MagicMock(return_value={'now':'B'})
        with self.assertRaises(PoolError):c.select('A')
    def test_worker_same_proxy_and_zero_hidden_retries(self):
        opts=yt.options('captions','http://127.0.0.1:18883')
        self.assertEqual(opts['proxy'],'http://127.0.0.1:18883')
        self.assertEqual(opts['retries'],0);self.assertEqual(opts['extractor_retries'],0)
        info={'subtitles':{'en':[{'ext':'json3','url':'https://www.youtube.com/api/timedtext?v=abcdefghijk'}]}}
        response=MagicMock();response.__enter__.return_value.url=info['subtitles']['en'][0]['url'];response.__enter__.return_value.headers={};response.__enter__.return_value.read.return_value=b'{}'
        with patch.object(yt,'build_opener') as opener:
            opener.return_value.open.return_value=response
            yt.fetch_captions(info,'http://127.0.0.1:18883')
            proxy_handler=opener.call_args.args[1]
            self.assertEqual(proxy_handler.proxies,{'http':'http://127.0.0.1:18883','https':'http://127.0.0.1:18883'})
    def test_worker_reports_429_retry_after_without_url_or_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'out.json';fake=MagicMock();fake.YoutubeDL.return_value.__enter__.return_value.extract_info.return_value={'id':'abcdefghijk'}
            headers=Message();headers['Retry-After']='7200'
            with patch.dict('sys.modules',{'yt_dlp':fake}),patch.object(yt.sys,'argv',['yt_worker.py','captions','https://www.youtube.com/watch?v=abcdefghijk',str(output),'http://127.0.0.1:18883']),patch.object(yt,'fetch_captions',side_effect=HTTPError('https://signed.invalid?secret=hidden',429,'hidden',headers,None)):
                self.assertEqual(yt.main(),1)
            result=json.loads(output.read_text())
            self.assertEqual(result,{'ok':False,'code':'RATE_LIMITED','retryAfter':7200})
            self.assertNotIn('hidden',output.read_text())
    def test_installer_preserves_other_config_and_duplicate_refusal(self):
        original={'mode':'rule','secret':'test-only','rules':['MATCH,old'],'proxies':[{'name':x} for x in ['IPLC US-Home','IPLC AI-Prime','IPLC Japan']],'proxy-groups':[{'name':'old','type':'select','proxies':['DIRECT']},{'name':'🇺🇸 美国手动','type':'select','proxies':['IPLC US-Home','IPLC AI-Prime','IPLC Japan','REJECT']}]}
        copied=copy.deepcopy(original);new,nodes=enhanced_config(original)
        self.assertEqual(original,copied)
        self.assertEqual(new['mode'],'rule');self.assertEqual(new['rules'],original['rules']);self.assertEqual(new['proxy-groups'][0],original['proxy-groups'][0])
        self.assertEqual(len(nodes),3);self.assertEqual(new['listeners'][0]['listen'],'127.0.0.1');self.assertEqual(new['listeners'][0]['proxy'],GROUP)
        with self.assertRaises(PoolError):enhanced_config(new)
    def test_all_cooling_rejected_before_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            pool=MagicMock();pool.enabled=True;pool.status.return_value={'nodeCount':3,'available':0}
            backend=s.YtDlpBackend(pool=pool)
            lib=s.Library(tmp,backend);self.addCleanup(lib.close)
            lib.state['videos']=[{'id':'abcdefghijk','transcriptStatus':'error','transcriptError':'旧失败'}]
            before=copy.deepcopy(lib.state)
            with self.assertRaises(s.ConnectorError) as caught:lib.request_transcript('abcdefghijk')
            self.assertEqual(caught.exception.code,'CAPTION_COOLDOWN')
            self.assertEqual(lib.jobs.qsize(),0)
            self.assertEqual(lib.state,before)

    def test_empty_restricted_metadata_not_misreported_as_no_captions(self):
        with patch.object(yt,'build_opener') as opener:
            with self.assertRaises(yt.SafeFailure) as caught:yt.fetch_captions({'id':'abcdefghijk','formats':[]})
            self.assertEqual(str(caught.exception),'CAPTION_LIST_UNAVAILABLE')
            opener.assert_not_called()

    def test_backend_attaches_pool_and_converts_cooldown(self):
        pool=MagicMock();pool.enabled=True;pool.fetch.side_effect=PoolError('CAPTION_COOLDOWN','冷却')
        backend=s.YtDlpBackend(pool=pool)
        with self.assertRaises(s.ConnectorError) as caught:backend.captions('abcdefghijk')
        self.assertEqual(caught.exception.code,'CAPTION_COOLDOWN')
        self.assertEqual(caught.exception.status,429)

if __name__=='__main__':unittest.main()
