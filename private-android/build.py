#!/usr/bin/env python3
"""Package the local playback-gate bundle into the existing private Cobalt APK. No deployment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from manifest import add_loader

ANDROID = 'http://schemas.android.com/apk/res/android'
PACKAGE = 'io.gh.akshat.tizentube.cobalt'
OLD_URL = b'https://cdn.jsdelivr.net/gh/akshatagarwl/TizenTube@c382127/tube.js'
HEAD_SCRIPT = """fetch('http://127.0.0.1:8107/tube.js',{method:'HEAD'}).then(r=>{
if(!r.ok)throw Error('Local bundle unavailable')}).catch(e=>{
console.error('Playback protection unavailable',e);
document.addEventListener('play',e=>e.target.pause(),true);
document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.removeAttribute('src');v.load()});
window.stop();document.body.textContent='Playback protection unavailable. Please exit the app.';
});"""


def run(*command):
    subprocess.run([str(part) for part in command], check=True)


def manifest_with_provider(manifest):
    root = ET.fromstring(manifest)
    if root.get('package') != PACKAGE:
        raise ValueError('Not the existing private package')
    root = ET.Element('manifest', {'package': PACKAGE})
    ET.SubElement(root, 'uses-sdk', {f'{{{ANDROID}}}minSdkVersion': '24'})
    application = ET.SubElement(root, 'application', {f'{{{ANDROID}}}usesCleartextTraffic': 'true'})
    ET.SubElement(application, 'provider', {
        f'{{{ANDROID}}}name': 'io.gh.akshat.tizentube.gate.BundleProvider',
        f'{{{ANDROID}}}authorities': PACKAGE + '.playback.bundle',
        f'{{{ANDROID}}}exported': 'false',
        f'{{{ANDROID}}}initOrder': '100',
    })
    ET.register_namespace('android', ANDROID)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def patch_loader(native):
    url = OLD_URL + b'?v='
    if native.count(url) != 1 or native.count(OLD_URL) != 2:
        raise ValueError('Native library is not the pinned c382127 loader')
    prefix = b'http://127.0.0.1:8107/tube.js?build=playback-gate'
    replacement = prefix + b'0' * (len(url) - len(prefix) - 3) + b'&v='
    native = native.replace(url, replacement)
    position = native.index(OLD_URL)
    start = native.rfind(b'\0', 0, position) + 1
    end = native.index(b'\0', position)
    script = HEAD_SCRIPT.encode()
    if len(script) > end - start:
        raise ValueError('Local availability check exceeds native string slot')
    native = native[:start] + script.ljust(end - start, b' ') + native[end:]
    if OLD_URL in native:
        raise ValueError('Remote loader survived patching')
    return native


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline_apk', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--sdk', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    bundle = root.parent / 'dist/userScript.js'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    tools = args.sdk / 'build-tools/35.0.0'
    android = args.sdk / 'platforms/android-36/android.jar'
    javac = Path(os.environ['JAVA_HOME']) / 'bin/javac'
    classes = output / 'classes'
    dex = output / 'dex'
    classes.mkdir(exist_ok=True)
    dex.mkdir(exist_ok=True)

    run(javac, '--release', '8', '-classpath', android,
        '-d', classes, *sorted((root / 'src').rglob('*.java')))
    run(tools / 'd8', '--lib', android, '--min-api', '24', '--output', dex,
        *sorted(classes.rglob('*.class')))
    manifest = subprocess.check_output([
        str(args.sdk / 'cmdline-tools/latest/bin/apkanalyzer'),
        'manifest', 'print', str(args.baseline_apk),
    ])
    edited_manifest = output / 'manifest.xml'
    edited_manifest.write_bytes(manifest_with_provider(manifest))
    manifest_apk = output / 'manifest.apk'
    run(tools / 'aapt2', 'link', '--manifest', edited_manifest, '-I', android, '-o', manifest_apk)
    with zipfile.ZipFile(manifest_apk) as compiled:
        with zipfile.ZipFile(args.baseline_apk) as baseline:
            binary_manifest = add_loader(baseline.read('AndroidManifest.xml'),
                                         compiled.read('AndroidManifest.xml'))
    unsigned = output / 'playback-gate-unsigned.apk'
    with zipfile.ZipFile(args.baseline_apk) as source, zipfile.ZipFile(unsigned, 'w') as target:
        dex_names = [name for name in source.namelist()
                     if name.startswith('classes') and name.endswith('.dex')]
        extra_dex = f'classes{len(dex_names) + 1}.dex'
        for entry in source.infolist():
            if entry.filename.startswith('META-INF/'):
                continue
            content = source.read(entry.filename)
            if entry.filename == 'AndroidManifest.xml':
                content = binary_manifest
            if entry.filename == 'lib/armeabi-v7a/libchrobalt.so':
                content = patch_loader(content)
            target.writestr(entry, content)
        target.writestr(extra_dex, (dex / 'classes.dex').read_bytes())
        target.writestr('assets/playback-gate.js', bundle.read_bytes())
    aligned = output / 'playback-gate-aligned.apk'
    run(tools / 'zipalign', '-f', '-P', '16', '4', unsigned, aligned)
    artifact = aligned
    if os.environ.get('KEYSTORE_FILE') and os.environ.get('KEYSTORE_PASSWORD'):
        artifact = output / 'tizentube-playback-gate.apk'
        run(tools / 'apksigner', 'sign', '--ks', os.environ['KEYSTORE_FILE'],
            '--ks-pass', 'env:KEYSTORE_PASSWORD', '--out', artifact, aligned)
        run(tools / 'apksigner', 'verify', artifact)
    hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in [args.baseline_apk, bundle, artifact]}
    (output / 'hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    print(json.dumps({'artifact': str(artifact), 'sha256': hashes[str(artifact)]}, indent=2))


if __name__ == '__main__':
    main()
