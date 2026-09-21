// Installed-app discovery for the distraction list.
//
// Asking someone to type "brave.exe" from memory is asking them to know a thing
// they have no reason to know — and one wrong guess means punishment mode
// quietly kills nothing. So we read what's actually on the machine and let them
// tick it off a list instead.
//
// Two sources, merged: Start Menu shortcuts (everything installed, with the
// friendly name the writer would recognise) and processes that currently own a
// window (portable apps and anything that never made a shortcut).
const { execFile } = require('child_process');
const fs = require('fs');

const PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$found = @{}',
  '$shell = New-Object -ComObject WScript.Shell',
  "$roots = @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'))",
  'foreach ($root in $roots) {',
  '  if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }',
  '  foreach ($lnk in Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk) {',
  '    $target = $null',
  '    try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { }',
  "    if (-not $target -or ($target -notlike '*.exe')) { continue }",
  '    $exe = [IO.Path]::GetFileName($target)',
  '    $key = $exe.ToLower()',
  '    if ($found.ContainsKey($key)) { continue }',
  '    $found[$key] = @{ exe = $exe; name = $lnk.BaseName; path = $target }',
  '  }',
  '}',
  // Store/UWP apps (WhatsApp and friends) have no Start Menu shortcut pointing
  // at an .exe — the Start entry is an AppID. Get-StartApps gives the friendly
  // name and that AppID, and the package manifest turns the AppID's Application
  // id into the executable taskkill will actually need.
  '$packages = @{}',
  'foreach ($pkg in Get-AppxPackage) {',
  '  if ($pkg.PackageFamilyName -and $pkg.InstallLocation) { $packages[$pkg.PackageFamilyName] = $pkg.InstallLocation }',
  '}',
  'foreach ($startApp in Get-StartApps) {',
  "  if ($startApp.AppID -notlike '*!*') { continue }",
  "  $parts = $startApp.AppID.Split('!')",
  '  $location = $packages[$parts[0]]',
  '  if (-not $location) { continue }',
  "  $manifest = Join-Path $location 'AppxManifest.xml'",
  '  if (-not (Test-Path -LiteralPath $manifest)) { continue }',
  '  $xml = $null',
  '  try { $xml = [xml](Get-Content -LiteralPath $manifest -Raw) } catch { }',
  '  if (-not $xml) { continue }',
  '  foreach ($application in $xml.Package.Applications.Application) {',
  '    if ($application.Id -ne $parts[1] -or -not $application.Executable) { continue }',
  '    $exe = [IO.Path]::GetFileName($application.Executable)',
  '    $key = $exe.ToLower()',
  '    if ($found.ContainsKey($key)) { continue }',
  // A Store app's exe carries no icon of its own — the tile art it shows in the
  // Start menu is a loose PNG, shipped in a dozen scaled variants. Pick the one
  // closest to the size the list draws at.
  '    $logo = $null',
  '    $declared = $application.VisualElements.Square44x44Logo',
  '    if (-not $declared) { $declared = $application.VisualElements.Square150x150Logo }',
  '    if ($declared) {',
  '      $full = Join-Path $location $declared',
  '      $folder = Split-Path $full -Parent',
  '      $stem = [IO.Path]::GetFileNameWithoutExtension($full)',
  "      $variants = @(Get-ChildItem -LiteralPath $folder -Filter ($stem + '*.png'))",
  '      foreach ($want in @("targetsize-48_altform-unplated", "targetsize-44_altform-unplated", "targetsize-32_altform-unplated", "targetsize-48", "targetsize-44", "scale-200", "scale-100")) {',
  '        $hit = $variants | Where-Object { $_.Name -like ("*" + $want + "*") } | Select-Object -First 1',
  '        if ($hit) { $logo = $hit.FullName; break }',
  '      }',
  '      if (-not $logo -and $variants.Count -gt 0) { $logo = $variants[0].FullName }',
  '    }',
  '    $found[$key] = @{ exe = $exe; name = $startApp.Name; path = (Join-Path $location $application.Executable); logo = $logo }',
  '  }',
  '}',
  '$live = @{}',
  'foreach ($p in Get-Process) {',
  "  $exe = $p.ProcessName + '.exe'",
  '  $key = $exe.ToLower()',
  '  $live[$key] = $true',
  '  if (-not $p.MainWindowTitle -or $found.ContainsKey($key)) { continue }',
  '  $name = $p.Description',
  '  if (-not $name) { $name = $p.ProcessName }',
  '  $found[$key] = @{ exe = $exe; name = $name; path = $p.Path }',
  '}',
  'ConvertTo-Json -Compress -Depth 4 -InputObject @{ apps = @($found.Values); running = @($live.Keys) }'
].join('\n');

// Real entries that nobody means by "this app distracts me" — Windows plumbing,
// and the Start Menu clutter that ships alongside an actual app.
const NOISE_EXE = new Set([
  'explorer.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'regedit.exe', 'control.exe',
  'mmc.exe', 'rundll32.exe', 'wscript.exe', 'cscript.exe', 'taskmgr.exe', 'dwm.exe',
  'svchost.exe', 'sihost.exe', 'ctfmon.exe', 'applicationframehost.exe', 'searchhost.exe',
  'textinputhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe',
  'systemsettings.exe', 'lockapp.exe', 'msiexec.exe', 'conhost.exe', 'werfault.exe'
]);
const NOISE_EXE_PATTERN = /(^unins|uninstall|^setup|[ _-]setup\.exe$|^install|crashpad|crashhandler|_helper|^update|updater)/i;
const NOISE_NAME_PATTERN = /(uninstall|read ?me|release notes|documentation|^help\b|license|^visit |^website|^报|command prompt|powershell)/i;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    // -EncodedCommand instead of -Command: the script has quotes and braces in
    // it, and Windows argument quoting is not a fight worth having.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 45000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
    );
  });
}

// Everything the Start Menu files under "Windows Tools" — Disk Cleanup, Steps
// Recorder, the ODBC panel. They live in the Windows directory, and nobody has
// ever lost a writing night to Steps Recorder.
const WINDOWS_DIR = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();

function isNoise(entry) {
  const exe = entry.exe.toLowerCase();
  if (NOISE_EXE.has(exe)) return true;
  if (NOISE_EXE_PATTERN.test(exe)) return true;
  if (NOISE_NAME_PATTERN.test(entry.name || '')) return true;
  if (entry.path && entry.path.toLowerCase().startsWith(WINDOWS_DIR)) return true;
  return false;
}

// A name and an exe are enough to be correct, but a list of sixty text rows is
// enough to be read wrong. The icon is what people actually recognise, so pull
// the real one: Windows keeps it inside the .exe, and Electron can dig it out.
// A Store app's icon is a loose PNG next to the package instead.
async function iconFor(entry) {
  if (entry.logo) {
    try {
      return 'data:image/png;base64,' + fs.readFileSync(entry.logo).toString('base64');
    } catch { /* package art we can't read — fall through to the exe */ }
  }
  if (!entry.path) return null;
  try {
    const { app } = require('electron');
    const image = await app.getFileIcon(entry.path, { size: 'small' });
    if (image && !image.isEmpty()) return image.toDataURL();
  } catch { /* no Electron (tests), or a path we can't touch — the row just loses its icon */ }
  return null;
}

// `exclude` keeps Write or Else itself off the list — being able to tick the
// thing that does the killing would be a funny bug exactly once.
async function listInstalledApps(exclude = []) {
  if (process.platform !== 'win32') {
    return { ok: false, apps: [], error: 'App scanning is only available on Windows.' };
  }
  let raw;
  try {
    raw = await runPowerShell(PS_SCRIPT);
  } catch (err) {
    return { ok: false, apps: [], error: err.message || 'Could not read the installed app list.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, apps: [], error: 'Could not read the installed app list.' };
  }

  const skip = new Set(exclude.map(e => String(e).toLowerCase()));
  const running = new Set((parsed.running || []).map(r => String(r).toLowerCase()));
  const apps = (parsed.apps || [])
    .filter(a => a && a.exe)
    .map(a => ({
      exe: a.exe,
      name: (a.name || a.exe).trim(),
      path: a.path || '',
      logo: a.logo || '',
      running: running.has(a.exe.toLowerCase())
    }))
    .filter(a => !skip.has(a.exe.toLowerCase()) && !isNoise(a))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const icons = await Promise.all(apps.map(iconFor));
  apps.forEach((a, i) => {
    a.icon = icons[i] || '';
    delete a.logo; // a path on disk, of no use to the renderer once it has the image
  });

  return { ok: true, apps };
}

module.exports = { listInstalledApps };
