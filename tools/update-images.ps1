# Rigenera js/images.js: per ogni carta senza immagine su TCGdex, o con un'immagine dichiarata che
# sul server non esiste, cerca un'alternativa, in ordine:
#   1. Limitless TCG, in italiano   2. TCGdex in inglese   3. Scrydex, in inglese   4. TCGdex in altre lingue
#   5. foto prodotto di TCGplayer, in inglese
# Da rilanciare quando escono nuovi set:  powershell -ExecutionPolicy Bypass -File tools\update-images.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$api = 'https://api.tcgdex.net/v2'
$limitless = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci'
$scrydex = 'https://images.scrydex.com/pokemon'

# Id TCGdex -> id Scrydex, dove sono diversi.
$scrydexId = @{
  'sm7.5' = 'sm75'; 'sm3.5' = 'sm35'; 'swsh4.5sv' = 'swsh45sv'; 'cel25cc' = 'cel25c'; 'swsh12.5gg' = 'swsh12pt5gg'
  '2011bw' = 'mcd11'; '2012bw' = 'mcd12'; '2014xy' = 'mcd14'; '2015xy' = 'mcd15'; '2016xy' = 'mcd16'
  '2017sm' = 'mcd17'; '2018sm' = 'mcd18'; '2019sm' = 'mcd19'; '2021swsh' = 'mcd21'; '2022swsh' = 'mcd22'
  '2023sv' = 'mcd23'; '2024sv' = 'mcd24'
}

# Chiamata all'API di TCGdex con nuovi tentativi: ogni tanto risponde "no available server" o
# "occupato" per qualche secondo, e senza riprovare lo script si fermava a metà.
function Get-Json($url) {
  for ($try = 1; ; $try++) {
    try { return Invoke-RestMethod $url -TimeoutSec 60 }
    catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 404 -or $try -ge 6) { throw }
      Start-Sleep -Seconds (5 * $try)
    }
  }
}

function Get-Length($url) {
  try { [long](Invoke-WebRequest $url -Method Head -UseBasicParsing -TimeoutSec 20 -UserAgent 'Mozilla/5.0').Headers['Content-Length'] } catch { 0 }
}
function Test-Url($url) { (Get-Length $url) -gt 0 }

# Scrydex risponde 200 con un'immagine segnaposto anche per le carte che non ha: la si riconosce dal peso.
$placeholder = Get-Length "$scrydex/zzzz-1/small"

# Immagini di un set in un'altra lingua: localId -> url base.
function Get-Images($lang, $setId) {
  $m = @{}
  try {
    foreach ($c in (Get-Json "$api/$lang/sets/$([uri]::EscapeDataString($setId))").cards) {
      if ($c.image) { $m[$c.localId] = $c.image }
    }
  } catch { }
  $m
}

# Controllo in parallelo di molti indirizzi: url -> $true se l'immagine c'è davvero.
Add-Type -AssemblyName System.Net.Http
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(40)
$http.DefaultRequestHeaders.UserAgent.ParseAdd('Mozilla/5.0')
function Test-Urls([string[]]$urls) {
  $ok = @{}
  foreach ($round in 1..2) {   # il secondo giro riprova quelli falliti: spesso sono errori di rete passeggeri
    $todo = @($urls | Where-Object { -not $ok[$_] })
    for ($i = 0; $i -lt $todo.Count; $i += 32) {
      $batch = $todo[$i..([Math]::Min($i + 31, $todo.Count - 1))]
      $tasks = foreach ($u in $batch) { $http.SendAsync((New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Head), $u)) }
      try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks) } catch { }
      for ($j = 0; $j -lt $batch.Count; $j++) {
        $t = $tasks[$j]
        $ok[$batch[$j]] = $t.Status -eq 'RanToCompletion' -and $t.Result.IsSuccessStatusCode
      }
    }
  }
  $ok
}

$setIds = (Get-Json "$api/it/series").id | Where-Object { $_ -ne 'tcgp' } |
  ForEach-Object { (Get-Json "$api/it/series/$_").sets.id }

$map = [ordered]@{}
$report = @()
foreach ($id in $setIds) {
  # Stesso elenco che usa l'app (js/api.js, getSet): italiano, completato con l'inglese.
  $set = Get-Json "$api/it/sets/$([uri]::EscapeDataString($id))"
  $en = Get-Images 'en' $id
  $cards = @($set.cards)
  if ($cards.Count -lt $set.cardCount.total) {
    $itIds = @{}; foreach ($c in $cards) { $itIds[$c.id] = 1 }
    try {
      foreach ($c in (Get-Json "$api/en/sets/$([uri]::EscapeDataString($id))").cards) { if (-not $itIds[$c.id]) { $cards += $c } }
    } catch { }
  }
  # Come fa l'app: se manca l'immagine italiana si usa quella inglese (segnata, per cercare comunque
  # prima una versione italiana).
  foreach ($c in $cards) {
    if (-not $c.image -and $en[$c.localId]) { $c | Add-Member -Force image $en[$c.localId]; $c | Add-Member -Force fromEn $true }
  }

  # Carte senza immagine, con un'immagine dichiarata che sul server non c'è, o solo in inglese.
  $primary = @($cards | Where-Object image | ForEach-Object { "$($_.image)/low.webp" })
  $alive = if ($primary.Count) { Test-Urls $primary } else { @{} }
  $missing = @($cards | Where-Object { -not $_.image -or -not $alive["$($_.image)/low.webp"] -or $_.fromEn })
  if (-not $missing.Count) { continue }

  $code = $set.abbreviation.official
  # Niente Limitless per i sotto-set (gallerie, tesori lucenti), che numera in altro modo, e per la
  # Collezione Classica del 30°, che su TCGdex ha la stessa sigla del set principale (immagini sbagliate).
  if ($code -match ':' -or $id -eq '30th-c') { $code = $null }
  $sid = if ($scrydexId[$id]) { $scrydexId[$id] } else { $id }
  $others = $null
  $count = @{ it = 0; en = 0; altro = 0; nessuna = 0 }
  foreach ($c in $missing) {
    $url = $null
    $digits = $c.localId -replace '\D', ''
    if ($code -and $digits) {
      $candidate = "$limitless/$code/${code}_$($digits.PadLeft(3, '0'))_R_IT_SM.png"
      if (Test-Url $candidate) { $url = $candidate; $count.it++ }
    }
    # Senza versione italiana, una carta che ha già un'immagine inglese funzionante va bene così:
    # l'app la prende da sola dall'elenco inglese, non serve scriverla qui.
    if (-not $url -and $c.fromEn -and $alive["$($c.image)/low.webp"]) { $count.en++; continue }
    $enUrl = $en[$c.localId]
    if (-not $url -and $enUrl -and $enUrl -ne $c.image -and (Test-Url "$enUrl/low.webp")) { $url = $enUrl; $count.en++ }
    if (-not $url) {
      $n = if ($c.localId -match '^\d+$') { [int]$c.localId } else { $c.localId }
      $len = Get-Length "$scrydex/$sid-$n/small"
      if ($len -gt 0 -and $len -ne $placeholder) { $url = "$scrydex/$sid-$n"; $count.en++ }
    }
    if (-not $url) {
      if ($null -eq $others) { $others = 'fr', 'es', 'de', 'pt' | ForEach-Object { , (Get-Images $_ $id) } }
      $url = $others | ForEach-Object { $_[$c.localId] } | Where-Object { $_ -and (Test-Url "$_/low.webp") } | Select-Object -First 1
      if ($url) { $count.altro++ }
    }
    if (-not $url) {
      # Ultima spiaggia: la foto prodotto di TCGplayer (inglese), tramite l'id che TCGdex riporta per la carta.
      try {
        $d = Get-Json "$api/en/cards/$([uri]::EscapeDataString($c.id))"
        $tp = @($d.thirdParty.tcgplayer) + @($d.variants_detailed.thirdParty.tcgplayer) | Where-Object { $_ } | Select-Object -First 1
        if ($tp -and (Test-Url "https://product-images.tcgplayer.com/$tp.jpg")) {
          $url = "https://product-images.tcgplayer.com/$tp.jpg"; $count.en++
        }
      } catch { }
    }
    if ($url) { $map[$c.id] = $url } else { $count.nessuna++ }
  }
  $report += "{0,-12} {1,-44} carte={2,-4} da sistemare={3,-4} italiano={4,-4} inglese={5,-4} altre lingue={6,-3} nessuna={7}" -f `
    $id, $set.name, $cards.Count, $missing.Count, $count.it, $count.en, $count.altro, $count.nessuna
}

$lines = $map.GetEnumerator() | ForEach-Object { "  '$($_.Key)': '$($_.Value)'," }
$js = @"
// Generato da tools/update-images.ps1: immagini alternative per le carte senza immagine su TCGdex
// o con un'immagine dichiarata ma assente dal server.
export const IMAGES = {
$($lines -join "`n")
};
"@
[IO.File]::WriteAllText((Join-Path $root 'js\images.js'), $js + "`n", (New-Object Text.UTF8Encoding $false))

"Immagini alternative trovate: $($map.Count)"
$report
