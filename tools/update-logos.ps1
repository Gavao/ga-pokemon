# Rigenera js/logos.js: per ogni set senza logo italiano funzionante su TCGdex
# cerca un'alternativa (logo inglese TCGdex, logo da pokemontcg.io scaricato in logos/, simbolo del set).
# Da rilanciare quando escono nuovi set:  powershell -ExecutionPolicy Bypass -File tools\update-logos.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logoDir = Join-Path $root 'logos'
New-Item -ItemType Directory -Force $logoDir | Out-Null

# Id TCGdex -> id pokemontcg.io, per i set che TCGdex non copre.
$ptcg = @{
  'tk-ex-latia' = 'tk1a'; 'tk-ex-latio' = 'tk1b'; 'tk-ex-p' = 'tk2a'; 'tk-ex-m' = 'tk2b'
  '2011bw' = 'mcd11'; '2012bw' = 'mcd12'; '2014xy' = 'mcd14'; '2015xy' = 'mcd15'; '2016xy' = 'mcd16'
  '2017sm' = 'mcd17'; '2018sm' = 'mcd18'; '2019sm' = 'mcd19'; '2021swsh' = 'mcd21'; '2022swsh' = 'mcd22'
  'sm3.5' = 'sm35'; 'sm7.5' = 'sm75'; 'sma' = 'sma'; 'swsh4.5sv' = 'swsh45sv'; 'cel25cc' = 'cel25c'
  'swsh9tg' = 'swsh9tg'; 'swsh10tg' = 'swsh10tg'; 'swsh11tg' = 'swsh11tg'; 'swsh12tg' = 'swsh12tg'
  'swsh12.5gg' = 'swsh12pt5gg'; 'sve' = 'sve'; 'svp' = 'svp'; 'sv05' = 'sv5'
}

# Set senza un logo proprio (trainer kit, promo, energie): si riusa quello del set "padre".
$parent = @{
  'wp' = 'basep'; 'exu' = 'ex10'; 'xya' = 'xy1'; 'mee' = 'me01'; 'mep' = 'me01'
  'tk-dp-l' = 'dp1'; 'tk-dp-m' = 'dp1'; 'tk-hs-r' = 'hgss1'; 'tk-hs-g' = 'hgss1'
  'tk-xy-sy' = 'xy1'; 'tk-xy-n' = 'xy1'; 'tk-xy-b' = 'xy1'; 'tk-xy-w' = 'xy1'
  'tk-xy-latia' = 'xy1'; 'tk-xy-latio' = 'xy1'; 'tk-xy-su' = 'xy1'; 'tk-xy-p' = 'xy1'
  'tk-sm-l' = 'sm1'; 'tk-sm-r' = 'sm1'
}

function Test-Url($url) {
  try { (Invoke-WebRequest $url -Method Head -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } catch { $false }
}

$it = Invoke-RestMethod 'https://api.tcgdex.net/v2/it/sets'
$en = @{}
foreach ($s in (Invoke-RestMethod 'https://api.tcgdex.net/v2/en/sets')) { $en[$s.id] = $s }
$pocket = (Invoke-RestMethod 'https://api.tcgdex.net/v2/it/series/tcgp').sets.id

$map = [ordered]@{}
$none = @()
foreach ($s in $it) {
  if ($pocket -contains $s.id) { continue }
  if ($s.logo -and (Test-Url "$($s.logo).webp")) { continue }   # logo italiano ok: niente da fare

  $candidates = @()
  if ($s.logo) { $candidates += "$($s.logo).png" }
  if ($en[$s.id].logo) { $candidates += "$($en[$s.id].logo).webp", "$($en[$s.id].logo).png" }
  $found = $candidates | Where-Object { Test-Url $_ } | Select-Object -First 1

  if (-not $found -and $ptcg[$s.id]) {
    $file = Join-Path $logoDir "$($s.id).png"
    try {
      Invoke-WebRequest "https://images.pokemontcg.io/$($ptcg[$s.id])/logo.png" -OutFile $file -UseBasicParsing -TimeoutSec 30
      $found = "logos/$($s.id).png"
    } catch { }
  }
  if (-not $found -and (Test-Path (Join-Path $logoDir "$($s.id).png"))) { $found = "logos/$($s.id).png" }  # logo messo a mano
  if (-not $found -and $s.symbol) {
    $found = "$($s.symbol).webp", "$($s.symbol).png" | Where-Object { Test-Url $_ } | Select-Object -First 1
  }

  if ($found) { $map[$s.id] = $found } else { $none += $s }
}

$itLogo = @{}
foreach ($s in $it) { if ($s.logo) { $itLogo[$s.id] = "$($s.logo).webp" } }
$none = @(foreach ($s in $none) {
  $p = $parent[$s.id]
  $url = if ($p) { if ($map[$p]) { $map[$p] } else { $itLogo[$p] } }
  if ($url) { $map[$s.id] = $url } else { "$($s.id)  $($s.name)" }
})

$lines = $map.GetEnumerator() | ForEach-Object { "  '$($_.Key)': '$($_.Value)'," }
$js = @"
// Generato da tools/update-logos.ps1: loghi alternativi per i set senza logo italiano su TCGdex.
// Per aggiungerne uno a mano: metti il file in logos/<id-set>.png e rilancia lo script.
export const LOGOS = {
$($lines -join "`n")
};
"@
[IO.File]::WriteAllText((Join-Path $root 'js\logos.js'), $js + "`n", (New-Object Text.UTF8Encoding $false))

"Loghi alternativi trovati: $($map.Count)"
"Senza alcun logo ($($none.Count)):"
$none
