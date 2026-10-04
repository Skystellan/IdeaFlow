import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { values } = parseArgs({ options: {
  python: { type: 'string', default: 'python3' },
  toolchain: { type: 'string' },
  'electron-zip-dir': { type: 'string' },
  out: { type: 'string', default: path.join(tmpdir(), 'ideaflow-release') },
} });
if (process.platform !== 'darwin') throw new Error('This packaging script currently builds macOS apps.');
const require = createRequire(values.toolchain ? path.join(path.resolve(values.toolchain), 'package.json') : import.meta.url);
const { packager } = await import(pathToFileURL(require.resolve('@electron/packager')).href);
const manifest = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const build = path.join(here, 'build');
await mkdir(build, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit',
    env: { ...process.env, PYINSTALLER_CONFIG_DIR: path.join(build, 'pyinstaller-cache') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

run(values.python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
  '--name', 'workbench-backend', '--distpath', path.join(build, 'backend'),
  '--workpath', path.join(build, 'python'), '--specpath', build,
  '--paths', root, '--add-data', `${path.join(root, 'idea_workbench/static')}:idea_workbench/static`,
  path.join(root, 'idea_workbench/desktop_backend.py'),
]);
const iconset = path.join(build, 'Workbench.iconset');
await mkdir(iconset, { recursive: true });
run('/usr/bin/swift', ['-module-cache-path', path.join(build, 'swift-cache'), path.join(here, 'icon.swift'), iconset]);
const icon = path.join(build, 'Workbench.icns');
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);

const stage = await mkdtemp(path.join(tmpdir(), 'ideaflow-'));
try {
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({
    name: manifest.name, productName: manifest.productName, version: manifest.version,
    main: 'main.mjs', type: 'module', description: manifest.description,
  }));
  for (const file of ['main.mjs', 'preload.cjs', 'welcome.html', 'welcome.css', 'welcome.js']) {
    await cp(path.join(here, file), path.join(stage, file));
  }
  const outputs = await packager({
    dir: stage, out: path.resolve(values.out), overwrite: true,
    name: manifest.productName, appBundleId: 'org.ideaworkbench.desktop',
    platform: 'darwin', arch: process.arch, electronVersion: manifest.devDependencies.electron,
    electronZipDir: values['electron-zip-dir'], icon, asar: false,
    extendInfo: { NSHighResolutionCapable: true, NSHumanReadableCopyright: manifest.productName },
  });
  for (const output of outputs) {
    const bundle = path.join(output, `${manifest.productName}.app`);
    // Packager's extraResource copy can absolutize PyInstaller's framework links.
    // Preserve their relative targets so the app remains portable after moving.
    await cp(path.join(build, 'backend/workbench-backend'), path.join(bundle, 'Contents/Resources/workbench-backend'), {
      recursive: true, verbatimSymlinks: true,
    });
    // Finder/iCloud metadata on generated bundles is rejected by codesign.
    run('/usr/bin/xattr', ['-cr', bundle]);
    // Local ad-hoc signing; public distribution still needs Developer ID + notarization.
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    console.log(`\nApp ready: ${bundle}`);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
