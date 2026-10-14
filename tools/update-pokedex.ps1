# Rigenera js/pokedex.js: nome di ogni Pokémon per numero di Pokédex, ricavato dalle carte di TCGdex
# (prima in italiano, altrimenti in inglese). Serve all'album Pokédex per i posti dei Pokémon mancanti.
# Per ogni numero si prendono i nomi delle sue carte, si tolgono le aggiunte ("ex", "V", "di Ash",
# "Oscuro"…) e si sceglie il nome più frequente.
# Da rilanciare quando escono nuovi Pokémon:  powershell -ExecutionPolicy Bypass -File tools\update-pokedex.ps1
param([int]$Max = 1025)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Add-Type -AssemblyName System.Net.Http
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(60)

# Parti del nome della carta che non fanno parte del nome del Pokémon.
$suffix = '(\s+(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|Prime|LEGEND|Star|δ|☆|◇|C|G|GL|FB|4|E))+$'
function Clean([string]$name) {
  $n = $name -replace '-(ex|EX|GX)$', ''
  $n = $n -replace $suffix, ''
  $n = $n -replace '^(Mega|M|Dark|Light|Shining|Radiant|Rocket''s|Team Rocket''s|Alolan|Galarian|Hisuian|Paldean|Origin Forme)\s+', ''
  $n = $n -replace '\s+(Oscuro|Oscura|Luminoso|Luminosa|Lucente|Radioso|Radiosa|di Alola|di Galar|di Hisui|di Paldea|del Team Rocket|di .+)$', ''
  $n -replace "^.+'s\s+", ''
}

function Get-Names($lang, $dex) {
  $t = $http.GetByteArrayAsync("https://api.tcgdex.net/v2/$lang/cards?dexId=eq:$dex")
  $t
}

$names = @{}
for ($id = 1; $id -le $Max; $id += 20) {
  $ids = $id..([Math]::Min($id + 19, $Max))
  foreach ($lang in 'it', 'en') {
    foreach ($round in 1..3) {
      $todo = @($ids | Where-Object { -not $names[$_] })
      if (-not $todo.Count) { break }
      $tasks = @{}
      foreach ($i in $todo) { $tasks[$i] = Get-Names $lang $i }
      try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($tasks.Values)) } catch { }
      $empty = 0
      foreach ($i in $todo) {
        $t = $tasks[$i]
        if ($t.Status -ne 'RanToCompletion') { continue }
        $cards = @([Text.Encoding]::UTF8.GetString($t.Result) | ConvertFrom-Json | ForEach-Object { $_ })
        if (-not $cards.Count) { $empty++; continue }
        $clean = @($cards | ForEach-Object { Clean $_.name } | Where-Object { $_ })
        if (-not $clean.Count) { continue }
        # Parole iniziali comuni a tutti i nomi: toglie le forme ("Calyrex Cavaliere Glaciale" -> "Calyrex")
        # ma tiene i nomi di più parole ("Tapu Koko", "Mr. Mime").
        $common = @($clean[0] -split ' ')
        foreach ($c in $clean) {
          $w = @($c -split ' ')
          $k = 0
          while ($k -lt $common.Count -and $k -lt $w.Count -and $common[$k] -eq $w[$k]) { $k++ }
          $common = if ($k) { $common[0..($k - 1)] } else { @() }
        }
        $names[$i] = if ($common.Count) { $common -join ' ' } else {
          ($clean | Group-Object | Sort-Object @{ e = 'Count'; Descending = $true }, @{ e = { $_.Name.Length } } | Select-Object -First 1).Name
        }
      }
      if ($empty -eq $todo.Count) { break }   # nessuna carta in questa lingua: inutile riprovare
    }
  }
  Write-Host -NoNewline "."
}
""
# Pokémon di cui esistono solo carte con la forma nel nome: il nome della specie si fissa qui.
$forms = @{ 892 = 'Urshifu'; 898 = 'Calyrex'; 901 = 'Ursaluna'; 1017 = 'Ogerpon' }
foreach ($k in $forms.Keys) { if ($k -le $Max) { $names[$k] = $forms[$k] } }
$missing = @(1..$Max | Where-Object { -not $names[$_] })
"Nomi trovati: $($Max - $missing.Count)/$Max" + $(if ($missing.Count) { "  senza carte: $($missing -join ', ')" })

$list = (1..$Max | ForEach-Object { if ($names[$_]) { "'" + $names[$_].Replace("'", "\'") + "'" } else { 'null' } }) -join ', '
$js = @"
// Generato da tools/update-pokedex.ps1: nome di ogni Pokémon per numero di Pokédex (POKEDEX[25] = Pikachu),
// ricavato dalle carte di TCGdex. null = nessuna carta di quel Pokémon nel catalogo.
export const POKEDEX = [null, $list];

// Generazioni: primo e ultimo numero di Pokédex.
export const GENERATIONS = [[1, 151], [152, 251], [252, 386], [387, 493], [494, 649], [650, 721], [722, 809], [810, 905], [906, $Max]];
"@
[IO.File]::WriteAllText((Join-Path $root 'js\pokedex.js'), $js + "`n", (New-Object Text.UTF8Encoding $false))
"Scritto js/pokedex.js"
