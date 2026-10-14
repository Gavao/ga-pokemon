# Copia dentro l'app (cartella img/) le immagini alternative che arrivano da Limitless e TCGplayer.
# Quei server non permettono all'app di salvarle per l'uso offline; servite da GitHub Pages insieme
# all'app invece si salvano come tutto il resto, e si caricano anche più in fretta.
# Lo lancia da solo tools\update-images.ps1 alla fine; si può usare anche da solo.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$imgDir = Join-Path $root 'img'
New-Item -ItemType Directory -Force $imgDir | Out-Null
$file = Join-Path $root 'js\images.js'
$text = [IO.File]::ReadAllText($file)

Add-Type -AssemblyName System.Net.Http
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(60)
$http.DefaultRequestHeaders.UserAgent.ParseAdd('Mozilla/5.0')

# Voci da copiare: 'id': 'https://…limitlesstcg…' oppure 'https://product-images.tcgplayer.com/…'
$entries = [regex]::Matches($text, "'([^']+)': '(https://(?:limitlesstcg[^']+|product-images\.tcgplayer\.com/[^']+))'") |
  ForEach-Object { [pscustomobject]@{ id = $_.Groups[1].Value; url = $_.Groups[2].Value } }
"Da copiare: $($entries.Count)"

$failed = 0
for ($i = 0; $i -lt $entries.Count; $i += 16) {
  $batch = $entries[$i..([Math]::Min($i + 15, $entries.Count - 1))]
  $jobs = foreach ($e in $batch) {
    $ext = if ($e.url -match '\.jpg$') { 'jpg' } else { 'png' }
    $name = "$($e.id).$ext"
    $e | Add-Member -Force local "img/$name"
    $target = Join-Path $imgDir $name
    if (Test-Path $target) { $null; continue }
    # TCGplayer: la versione 437x437 basta (la scheda carta la mostra a 260 px).
    $src = if ($e.url -match 'tcgplayer') { $e.url -replace '\.com/', '.com/fit-in/437x437/' } else { $e.url }
    [pscustomobject]@{ e = $e; target = $target; task = $http.GetByteArrayAsync($src) }
  }
  $jobs = @($jobs | Where-Object { $_ })
  if ($jobs.Count) { try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]($jobs.task)) } catch { } }
  foreach ($j in $jobs) {
    if ($j.task.Status -eq 'RanToCompletion') { [IO.File]::WriteAllBytes($j.target, $j.task.Result) }
    else { $failed++; $j.e.local = $null }
  }
}

# Nel file restano gli indirizzi originali solo per le immagini non scaricate.
foreach ($e in $entries) {
  if ($e.local) { $text = $text.Replace("'$($e.id)': '$($e.url)'", "'$($e.id)': '$($e.local)'") }
}
[IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false))
$size = (Get-ChildItem $imgDir | Measure-Object Length -Sum).Sum
"Copiate: $($entries.Count - $failed)  non riuscite: $failed  cartella img: $([math]::Round($size / 1MB, 1)) MB"
