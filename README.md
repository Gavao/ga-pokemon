# GA Pokémon

App personale per gestire una collezione di carte Pokémon: espansioni e set in italiano, copie per variante e condizione, wishlist, valore stimato.

- App web senza build (HTML, CSS, moduli JS), pubblicata su GitHub Pages: https://gavao.github.io/ga-pokemon/
- Sul telefono gira dentro un APK Android (`android/`) che carica la versione pubblicata e salva in automatico una copia della collezione in `Download/GAPokemon`.
- Catalogo, immagini e prezzi: [TCGdex](https://tcgdex.dev); immagini mancanti da Limitless TCG, Scrydex e TCGplayer (`tools/update-images.ps1`).

## Sviluppo

- Prova in locale: `powershell -ExecutionPolicy Bypass -File serve.ps1`, poi http://localhost:8080
- Pubblicare una modifica: commit e push su `main`; il telefono la riceve alla riapertura dell'app.
- Rigenerare l'APK (solo se cambia `android/`): `powershell -ExecutionPolicy Bypass -File android\build.ps1`
- Aggiornare loghi e immagini alternative dopo l'uscita di nuovi set: `tools\update-logos.ps1`, `tools\update-images.ps1`
