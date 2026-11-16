import os
from pathlib import Path
import subprocess
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASELINE = os.environ.get('PLAYBACK_BASELINE_APK')
CANDIDATE = os.environ.get('PLAYBACK_CANDIDATE_APK')
SDK = os.environ.get('ANDROID_SDK_ROOT')


@unittest.skipUnless(BASELINE and CANDIDATE and SDK, 'Set the two private APK paths and ANDROID_SDK_ROOT')
class ApkIntegrityTests(unittest.TestCase):
    def test_manifest_only_adds_the_nonexported_provider_and_loader_policy(self):
        analyzer = str(Path(SDK) / 'cmdline-tools/latest/bin/apkanalyzer')
        before = ET.fromstring(subprocess.check_output([analyzer, 'manifest', 'print', BASELINE]))
        after = ET.fromstring(subprocess.check_output([analyzer, 'manifest', 'print', CANDIDATE]))
        application = after.find('application')
        self.assertEqual(application.attrib.pop('usesCleartextTraffic'), 'true')
        providers = [item for item in application.findall('provider')
                     if item.get('name') == 'io.gh.akshat.tizentube.gate.BundleProvider']
        self.assertEqual(len(providers), 1)
        self.assertEqual(providers[0].get('exported'), 'false')
        application.remove(providers[0])
        def structure(element):
            return (element.tag, sorted(element.attrib.items()),
                    tuple(structure(child) for child in element))
        self.assertEqual(structure(before), structure(after))

    def test_no_existing_resources_or_classes_change(self):
        with zipfile.ZipFile(BASELINE) as source, zipfile.ZipFile(CANDIDATE) as candidate:
            changed = []
            for name in source.namelist():
                if name.startswith('META-INF/'):
                    continue
                if source.read(name) != candidate.read(name):
                    changed.append(name)
            self.assertEqual(sorted(changed), ['AndroidManifest.xml', 'lib/armeabi-v7a/libchrobalt.so'])
            added = set(candidate.namelist()) - set(source.namelist())
            added = {name for name in added if not name.startswith('META-INF/')}
            self.assertEqual(added, {'assets/playback-gate.js', 'classes4.dex'})
            self.assertEqual(candidate.read('assets/playback-gate.js'),
                             (ROOT.parent / 'dist/userScript.js').read_bytes())

    def test_native_loader_is_local_and_preserves_library_layout(self):
        with zipfile.ZipFile(BASELINE) as source, zipfile.ZipFile(CANDIDATE) as candidate:
            name = 'lib/armeabi-v7a/libchrobalt.so'
            before = source.read(name)
            after = candidate.read(name)
            self.assertEqual(len(before), len(after))
            self.assertNotIn(b'https://cdn.jsdelivr.net/gh/akshatagarwl/TizenTube@c382127/tube.js', after)
            self.assertIn(b'http://127.0.0.1:8107/tube.js?build=playback-gate', after)
            self.assertIn(b'Playback protection unavailable', after)


if __name__ == '__main__':
    unittest.main()
