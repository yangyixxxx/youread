"""临时视频隔离回归：不访问网络或真实资料。"""
import copy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from connector import server as s
from connector import yt_worker as yt
from connector import test_server as base
FakeBackend, VID, CID = base.FakeBackend, base.VID, base.CID

class Backend(FakeBackend):
    def metadata(self, identifier):
        return {"title":"真实格式视频", "channelTitle":"来源频道", "youtubeId":CID,
                "duration":123, "publishedAt":"2026-11-05T01:00:00Z", "datePrecision":"second"}

class TemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.backend=Backend()
        self.lib=s.Library(self.temp.name,self.backend)
    def tearDown(self):
        self.lib.close();self.temp.cleanup()
    def test_url_normalization(self):
        for url in [f'https://youtu.be/{VID}?si=x',f'https://youtube.com/watch?v={VID}&list=x',f'https://youtube.com/shorts/{VID}',f'https://m.youtube.com/live/{VID}']:
            self.assertEqual(s.normalize_video(url),VID)
        for url in [None,{},'https://youtube.com/@Example','https://youtube.com/playlist?list=x',f'https://youtube.com.evil.test/watch?v={VID}',f'https://youtube.com/watch?v={VID}&v=12345678901',f'https://youtu.be/{VID}/extra',f'https://u@youtube.com/watch?v={VID}']:
            with self.assertRaises(s.ConnectorError):s.normalize_video(url)
    def test_add_fetch_and_persist(self):
        result=self.lib.add_video(f'https://youtu.be/{VID}')
        self.assertFalse(result['duplicate']);self.assertEqual(len(self.lib.snapshot()['channels']),0)
        self.assertTrue(self.lib.process_next());self.assertTrue(self.lib.process_next())
        video=self.lib.snapshot()['videos'][0]
        self.assertEqual((video['title'],video['infoStatus'],video['transcriptStatus']),('真实格式视频','ready','ready'))
        self.assertEqual(self.lib.get_transcript(VID)['segments'][0]['text'],'测试字幕')
        other=s.Library(self.temp.name,Backend());self.assertTrue(other.snapshot()['videos'][0]['temporary']);other.close()
    def test_duplicate_preserves_captions_and_channel(self):
        self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next();self.lib.process_next()
        video=self.lib._video(VID);video['channelId']='existing';before=copy.deepcopy(video)
        result=self.lib.add_video(f'https://youtube.com/watch?v={VID}&t=3')
        self.assertTrue(result['duplicate']);self.assertEqual(video,before)
        self.assertEqual(len(self.lib.snapshot()['videos']),1);self.assertFalse(self.lib.process_next())
        self.assertEqual(self.backend.caption_calls,[VID])
    def test_duplicate_while_pending_fetches_once(self):
        for _ in range(3):self.lib.add_video(f'https://youtu.be/{VID}')
        while self.lib.process_next():pass
        self.assertEqual(self.backend.caption_calls,[VID]);self.assertEqual(len(self.lib.snapshot()['videos']),1)
    def test_existing_channel_video_gets_captions_without_subscription(self):
        self.lib.state['videos'].append({'id':VID,'title':'原有标题','channelId':'existing-channel','channelTitle':'原频道','transcriptStatus':'none','transcriptError':None})
        self.lib._save();self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next()
        video=self.lib._video(VID);self.assertEqual(video['channelId'],'existing-channel');self.assertEqual(video['title'],'原有标题')
        self.assertEqual(video['transcriptStatus'],'ready');self.assertEqual(self.lib.snapshot()['channels'],[])
    def test_remove_keeps_data(self):
        self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next();self.lib.process_next()
        self.lib.remove_temporary(VID)
        self.assertFalse(self.lib._video(VID)['temporary']);self.assertEqual(len(self.lib.get_transcript(VID)['segments']),1)
    def test_failed_metadata_manual_retry(self):
        with patch.object(self.backend,'metadata',side_effect=s.ConnectorError('NETWORK_ERROR','网络失败',502)):
            self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next()
        self.assertEqual(self.lib._video(VID)['infoStatus'],'error');self.assertFalse(self.lib.process_next())
        self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next();self.lib.process_next()
        self.assertEqual(self.lib._video(VID)['infoStatus'],'ready')
    def test_storage_failure_does_not_enqueue(self):
        with patch.object(self.lib,'_save',side_effect=OSError('test')):
            with self.assertRaises(OSError):self.lib.add_video(f'https://youtu.be/{VID}')
        self.assertEqual(self.lib.snapshot()['videos'],[]);self.assertFalse(self.lib.process_next())
    def test_restart_resumes_metadata_once(self):
        self.lib.add_video(f'https://youtu.be/{VID}')
        other=s.Library(self.temp.name,Backend());other.process_next();other.process_next()
        self.assertEqual(other._video(VID)['transcriptStatus'],'ready');self.assertFalse(other.process_next());other.close()
    def test_subtitle_failure_keeps_metadata(self):
        self.backend.caption_error=s.ConnectorError('RATE_LIMITED','YouTube限流',429)
        self.lib.add_video(f'https://youtu.be/{VID}');self.lib.process_next();self.lib.process_next()
        video=self.lib._video(VID);self.assertEqual(video['infoStatus'],'ready');self.assertEqual(video['transcriptStatus'],'error')
        self.assertEqual(video['transcriptErrorCode'],'RATE_LIMITED')
    def test_worker_metadata(self):
        result=yt.video_metadata({'title':'标题','uploader':'来源','duration':float('nan'),'upload_date':'20261105'})
        self.assertEqual(result['title'],'标题');self.assertIsNone(result['duration']);self.assertTrue(result['publishedAt'])

class TemporaryHTTPTests(base.AuthHTTPTests):
    def test_temporary_routes(self):
        self.assertEqual(self.request('POST','/videos',{'url':f'https://youtu.be/{VID}'},auth=False)[0],401)
        self.assertEqual(self.request('PATCH',f'/videos/{VID}',{'temporary':False},auth=False)[0],401)
        status,result,_=self.request('POST','/videos',{'url':f'https://youtu.be/{VID}'})
        self.assertEqual(status,202);self.assertTrue(result['video']['temporary'])
        self.assertEqual(self.request('POST','/videos',{'url':'https://example.com/'})[0],400)
        self.assertEqual(self.request('POST','/videos',{'url':f'https://youtu.be/{VID}','command':'x'})[0],400)
        self.assertEqual(self.request('PATCH',f'/videos/{VID}',{'temporary':False})[0],200)
        self.assertEqual(self.request('PATCH',f'/videos/{VID}',{'temporary':True})[0],400)
        self.assertEqual(sum(v['id']==VID for v in self.library.snapshot()['videos']),1)

if __name__=='__main__':unittest.main()
