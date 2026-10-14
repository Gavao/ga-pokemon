# Rigenera js/images.js: per ogni carta senza immagine italiana su TCGdex cerca un'alternativa, in ordine:
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
    foreach ($c in (Invoke-RestMethod "$api/$lang/sets/$([uri]::EscapeDataString($setId))").cards) {
      if ($c.image) { $m[$c.localId] = $c.image }
    }
  } catch { }
  $m
}

$setIds = (Invoke-RestMethod "$api/it/series").id | Where-Object { $_ -ne 'tcgp' } |
  ForEach-Object { (Invoke-RestMethod "$api/it/series/$_").sets.id }

$map = [ordered]@{}
$report = @()
foreach ($id in $setIds) {
  $set = Invoke-RestMethod "$api/it/sets/$([uri]::EscapeDataString($id))"
  $missing = @($set.cards | Where-Object { -not $_.image })
  if (-not $missing.Count) { continue }

  $code = $set.abbreviation.official
  # Niente Limitless per i sotto-set (gallerie, tesori lucenti), che numera in altro modo, e per la
  # Collezione Classica del 30°, che su TCGdex ha la stessa sigla del set principale (immagini sbagliate).
  if ($code -match ':' -or $id -eq '30th-c') { $code = $null }
  $sid = if ($scrydexId[$id]) { $scrydexId[$id] } else { $id }
  $en = Get-Images 'en' $id
  $others = $null
  $count = @{ it = 0; en = 0; altro = 0; nessuna = 0 }
  foreach ($c in $missing) {
    $url = $null
    $digits = $c.localId -replace '\D', ''
    if ($code -and $digits) {
      $candidate = "$limitless/$code/${code}_$($digits.PadLeft(3, '0'))_R_IT_SM.png"
      if (Test-Url $candidate) { $url = $candidate; $count.it++ }
    }
    if (-not $url -and $en[$c.localId]) { $url = $en[$c.localId]; $count.en++ }
    if (-not $url) {
      $n = if ($c.localId -match '^\d+$') { [int]$c.localId } else { $c.localId }
      $len = Get-Length "$scrydex/$sid-$n/small"
      if ($len -gt 0 -and $len -ne $placeholder) { $url = "$scrydex/$sid-$n"; $count.en++ }
    }
    if (-not $url) {
      if ($null -eq $others) { $others = 'fr', 'es', 'de', 'pt' | ForEach-Object { , (Get-Images $_ $id) } }
      $url = $others | ForEach-Object { $_[$c.localId] } | Where-Object { $_ } | Select-Object -First 1
      if ($url) { $count.altro++ }
    }
    if (-not $url) {
      # Ultima spiaggia: la foto prodotto di TCGplayer (inglese), tramite l'id che TCGdex riporta per la carta.
      try {
        $d = Invoke-RestMethod "$api/en/cards/$([uri]::EscapeDataString($c.id))"
        $tp = @($d.thirdParty.tcgplayer) + @($d.variants_detailed.thirdParty.tcgplayer) | Where-Object { $_ } | Select-Object -First 1
        if ($tp -and (Test-Url "https://product-images.tcgplayer.com/$tp.jpg")) {
          $url = "https://product-images.tcgplayer.com/$tp.jpg"; $count.en++
        }
      } catch { }
    }
    if ($url) { $map[$c.id] = $url } else { $count.nessuna++ }
  }
  $report += "{0,-12} {1,-44} mancanti={2,-4} italiano={3,-4} inglese={4,-4} altre lingue={5,-3} nessuna={6}" -f `
    $id, $set.name, $missing.Count, $count.it, $count.en, $count.altro, $count.nessuna
}

$lines = $map.GetEnumerator() | ForEach-Object { "  '$($_.Key)': '$($_.Value)'," }
$js = @"
// Generato da tools/update-images.ps1: immagini alternative per le carte senza immagine italiana su TCGdex.
export const IMAGES = {
$($lines -join "`n")
};
"@
[IO.File]::WriteAllText((Join-Path $root 'js\images.js'), $js + "`n", (New-Object Text.UTF8Encoding $false))

"Immagini alternative trovate: $($map.Count)"
$report
