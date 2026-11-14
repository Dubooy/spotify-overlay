# Puente con los controles multimedia de Windows (SMTC).
# Lee lo que suena en cualquier reproductor (Spotify, navegador, etc.) y
# escribe una línea JSON por cada cambio. Recibe órdenes por stdin:
#   toggle | next | prev | seek <ms>
$ErrorActionPreference = 'Continue'
trap { [Console]::Error.WriteLine('ERROR: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.ScriptLineNumber); continue }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(3000)
  if ($task.IsCompleted) { return $task.Result }
  return $null
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream,Windows.Storage.Streams,ContentType=WindowsRuntime]

[Console]::Error.WriteLine('INFO: helper arrancado, PowerShell ' + $PSVersionTable.PSVersion)
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
if (-not $mgr) { Write-Output '{"error":"NO_SMTC"}'; exit 1 }

function Read-Thumbnail($props) {
  try {
    if (-not $props.Thumbnail) { return $null }
    $ras = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if (-not $ras) { return $null }
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead([Windows.Storage.Streams.IInputStream]$ras)
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $net.Dispose(); $ms.Dispose()
    return 'data:image/png;base64,' + $b64
  } catch { return $null }
}

$lastKey = ''
$lastArt = $null
$artId = 0
$lastJson = ''
$lastSent = [DateTime]::MinValue
$reader = [Console]::In
$readTask = $reader.ReadLineAsync()

while ($true) {
  # --- órdenes desde la app ---
  while ($readTask.IsCompleted) {
    $cmd = $readTask.Result
    if ($null -eq $cmd) { exit 0 }
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $parts = $cmd.Trim().Split(' ')
      switch ($parts[0]) {
        'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
        'seek'   { $ticks = [int64]$parts[1] * 10000; $null = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool]) }
      }
      $lastJson = ''  # fuerza enviar el estado nuevo enseguida
    }
    $readTask = $reader.ReadLineAsync()
  }

  # --- estado actual ---
  $s = $mgr.GetCurrentSession()
  if (-not $s) {
    $json = '{"active":false}'
  } else {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $title = if ($props) { $props.Title } else { '' }
    $artist = if ($props) { $props.Artist } else { '' }
    $key = "$title|$artist"
    if ($key -ne $lastKey) {
      $lastKey = $key
      Start-Sleep -Milliseconds 250   # la portada llega un instante después del título
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $lastArt = Read-Thumbnail $props
      $artId++
      $artLine = [ordered]@{ type = 'art'; artId = $artId; art = $lastArt } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($artLine)
      [Console]::Out.Flush()
    }
    $obj = [ordered]@{
      active   = $true
      app      = $s.SourceAppUserModelId
      title    = $title
      artist   = $artist
      album    = if ($props) { $props.AlbumTitle } else { '' }
      playing  = ("$($info.PlaybackStatus)" -eq 'Playing')
      position = [int64]$tl.Position.TotalMilliseconds
      duration = [int64]$tl.EndTime.TotalMilliseconds
      updated  = [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
      canSeek  = [bool]$info.Controls.IsPlaybackPositionEnabled
      artId    = $artId
    }
    $json = $obj | ConvertTo-Json -Compress
  }

  $now = [DateTime]::UtcNow
  if ($json -ne $lastJson -or ($now - $lastSent).TotalSeconds -ge 5) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $lastJson = $json
    $lastSent = $now
  }
  Start-Sleep -Milliseconds 200
}
