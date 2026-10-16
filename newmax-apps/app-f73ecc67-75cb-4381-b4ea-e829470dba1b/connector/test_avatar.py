"""频道头像专项，使用隔离临时资料库，不访问网络。"""
import copy
import tempfile
import unittest

from connector import server, yt_worker

CID = 'UC' + 'A' * 22
AVATAR = 'https://yt3.googleusercontent.com/avatar=s160-c-k-c0x00ffffff-no-rj'


class AvatarTests(unittest.TestCase):
    def test_avatar_selected_not_banner_or_video(self):
        info = {'channel_id': CID, 'entries': [], 'thumbnails': [
            {'id': 'banner_uncropped', 'url': 'https://yt3.ggpht.com/banner=s0', 'preference': -5},
            {'id': 'avatar_uncropped', 'url': AVATAR},
            {'url': 'https://i.ytimg.com/vi/test/mqdefault.jpg', 'width': 320, 'height': 180},
        ]}
        self.assertEqual(yt_worker.channel_result(info)['avatar'], AVATAR)

    def test_square_fallback_and_missing_metadata(self):
        self.assertEqual(yt_worker.channel_avatar({'thumbnails': [{'url': AVATAR, 'width': 160, 'height': 160}]}), AVATAR)
        self.assertEqual(yt_worker.channel_avatar({}), '')
        self.assertEqual(yt_worker.channel_avatar({'thumbnails': [{'url': AVATAR, 'id': 'banner', 'width': 160, 'height': 160}]}), '')

    def test_unsafe_urls_rejected(self):
        for url in ['javascript:alert(1)', 'http://yt3.ggpht.com/a', 'https://yt3.ggpht.com.evil.test/a',
                    'https://user:pass@yt3.ggpht.com/a', 'https://yt3.ggpht.com:8443/a',
                    'https://yt3.ggpht.com/\na', None, 'file:///x']:
            with self.subTest(url=url):
                self.assertFalse(yt_worker.safe_avatar_url(url))
        self.assertTrue(yt_worker.safe_avatar_url(AVATAR))

    def test_invalid_dimensions_and_unsafe_avatar_do_not_fail_channel(self):
        for width in [None, '160', float('nan'), True]:
            info = {'channel_id': CID, 'thumbnails': [{'width': width, 'height': 160, 'url': AVATAR}]}
            self.assertEqual(yt_worker.channel_result(info)['avatar'], '')
        info = {'channel_id': CID, 'thumbnails': [{'id': 'avatar_uncropped', 'url': 'https://evil.test/image'}]}
        self.assertEqual(yt_worker.channel_result(info)['avatar'], '')

    def test_avatar_persisted_updated_and_missing_sync_keeps_prior(self):
        class Backend:
            result = {'youtubeId': CID, 'title': '头像临时测试', 'avatar': AVATAR, 'videos': []}
            def channel(self, url):
                return copy.deepcopy(self.result)
        backend = Backend()
        with tempfile.TemporaryDirectory(prefix='yingdu-avatar-test-') as path:
            library = server.Library(path, backend=backend)
            channel = library.add_channel('@avatar-test')['channel']
            library.process_next()
            self.assertEqual(library.snapshot()['channels'][0]['avatar'], AVATAR)
            restored = server.Library(path, backend=backend)
            self.assertEqual(restored.snapshot()['channels'][0]['avatar'], AVATAR)
            backend.result['avatar'] = ''
            restored._process_channel(channel['id'])
            self.assertEqual(restored.snapshot()['channels'][0]['avatar'], AVATAR)
            backend.result['avatar'] = AVATAR.replace('avatar=', 'new-avatar=')
            restored._process_channel(channel['id'])
            self.assertEqual(restored.snapshot()['channels'][0]['avatar'], backend.result['avatar'])


if __name__ == '__main__':
    unittest.main()
