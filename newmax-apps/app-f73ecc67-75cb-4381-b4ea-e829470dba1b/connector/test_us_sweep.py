"""美国节点整轮检查的离线测试，不操作Clash或YouTube。"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError
from email.message import Message
from connector import check_us_captions as sweep
from connector.caption_pool import ClashController, GROUP, PoolError

class SweepTests(unittest.TestCase):
    def test_twenty_two_real_nodes_and_reject_never_tested(self):
        nodes=['美国'+str(i) for i in range(22)]
        proxies={n:{'type':'Trojan','alive':False} for n in nodes}
        proxies.update({sweep.US_GROUP:{'type':'Selector','all':nodes+['REJECT']},'REJECT':{'type':'Reject'}})
        actual,excluded=sweep.candidates_from(proxies)
        self.assertEqual(actual,nodes)
        self.assertEqual(excluded[0]['name'],'REJECT')
        self.assertEqual(len(actual),22)
    def test_pool_accepts_twenty_two_but_remains_bounded(self):
        client=ClashController('unused')
        client.request=MagicMock(return_value={'type':'Selector','all':['US'+str(i) for i in range(22)]})
        self.assertEqual(len(client.members()),22)
        client.request.return_value['all']=['US'+str(i) for i in range(65)]
        with self.assertRaises(PoolError):client.members()
    def test_expand_changes_private_group_only_and_preserves_input(self):
        original={'mode':'rule','rules':['MATCH,原组'],'proxies':[{'name':'US-A'},{'name':'US-B'}],
                  'proxy-groups':[{'name':'原组','type':'select','proxies':['US-A']},{'name':GROUP,'type':'select','proxies':['US-A']}]}
        before=copy.deepcopy(original)
        new=sweep.expand_config(original,['US-A','US-B'])
        self.assertEqual(original,before)
        self.assertEqual(new['mode'],original['mode']);self.assertEqual(new['rules'],original['rules'])
        self.assertEqual(new['proxy-groups'][0],original['proxy-groups'][0]);self.assertEqual(len(new['proxy-groups'][1]['proxies']),2)
        self.assertEqual(new['listeners'][0]['proxy'],GROUP);self.assertEqual(new['listeners'][0]['listen'],'127.0.0.1')
        with self.assertRaises(PoolError):sweep.expand_config(original,['missing'])
    def test_probe_records_empty_metadata_not_caption_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'out.json';fake=MagicMock()
            fake.YoutubeDL.return_value.__enter__.return_value.extract_info.return_value={'id':'abcdefghijk','formats':[]}
            with patch.dict('sys.modules',{'yt_dlp':fake}),patch.object(sweep.yt,'fetch_captions') as fetch:
                sweep.probe('abcdefghijk',out)
            result=json.loads(out.read_text())
            self.assertEqual(result['code'],'CAPTION_LIST_UNAVAILABLE');self.assertEqual(result['stage'],'video_details');fetch.assert_not_called()
    def test_probe_records_actual_429_stage_and_no_secret_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)/'out.json';fake=MagicMock()
            fake.YoutubeDL.return_value.__enter__.return_value.extract_info.return_value={'id':'abcdefghijk','formats':[{}],'duration':120,'subtitles':{'en':[{'ext':'json3','url':'https://www.youtube.com/api/timedtext?v=abcdefghijk'}]}}
            headers=Message();headers['Retry-After']='3600'
            with patch.dict('sys.modules',{'yt_dlp':fake}),patch.object(sweep.yt,'fetch_captions',side_effect=HTTPError('https://hidden.invalid?secret=private',429,'private',headers,None)):
                sweep.probe('abcdefghijk',out)
            value=json.loads(out.read_text());self.assertEqual(value['code'],'RATE_LIMITED');self.assertEqual(value['stage'],'caption_download');self.assertEqual(value['retryAfter'],3600)
            self.assertNotIn('private',out.read_text())
    def test_existing_transcript_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'connector').mkdir();path=root/'connector'/'library.json'
            original={'videos':[{'id':'abcdefghijk','transcriptStatus':'ready','title':'保留'}]};path.write_text(json.dumps(original),encoding='utf-8')
            value=sweep.commit_caption(root,'abcdefghijk',{'invalid':'本来不应读取'})
            self.assertFalse(value['saved']);self.assertEqual(json.loads(path.read_text()),original)
    def test_same_run_report_prevents_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            report=Path(tmp)/'report.json';report.write_text(json.dumps({'runId':'one','finished':True,'rows':[{}]}))
            with patch.object(sweep,'ClashController') as controller:
                self.assertEqual(sweep.sweep(Path('unused'),Path(tmp),report,'one'),0)
                controller.assert_not_called()
    def test_diagnostic_logger_stores_flags_not_raw_warning(self):
        logger=sweep.DiagnosticLogger();logger.warning('PO Token needed at https://hidden.invalid?secret=private')
        self.assertEqual(logger.flags,{'po_token_required'});self.assertNotIn('private',repr(logger.flags))

if __name__=='__main__':unittest.main()
