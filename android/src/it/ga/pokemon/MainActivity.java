package it.ga.pokemon;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Guscio Android di GA Pokémon: una WebView che mostra l'app web pubblicata su GitHub Pages.
 * Così ogni modifica pubblicata arriva sul telefono alla riapertura, senza reinstallare l'APK;
 * il service worker dell'app la tiene in memoria per l'uso offline. Qui resta solo ciò che
 * il browser da solo non sa fare: backup in Download, selettore di file, tasto Indietro.
 */
public class MainActivity extends Activity {
    private static final String HOST = "gavao.github.io";
    private static final String HOME = "https://" + HOST + "/ga-pokemon/";
    private static final String OFFLINE_PAGE = "<html><body style='background:#14161c;color:#eceef3;"
            + "font-family:sans-serif;text-align:center;padding:40% 24px'>"
            + "<p>Per il primo avvio GA Pokémon ha bisogno della connessione a internet.</p>"
            + "<p><a href='" + HOME + "' style='color:#ffcb05'>Riprova</a></p></body></html>";
    private static final String BACKUP_DIR = Environment.DIRECTORY_DOWNLOADS + "/GAPokemon";
    private static final String BACKUP_NAME = "ga-pokemon-backup.json";
    private static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(0xFF14161C);
        getWindow().setNavigationBarColor(0xFF1E212A);

        web = new WebView(this);
        web.setBackgroundColor(0xFF14161C);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);

        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());   // l'app non naviga mai fuori da sé
            }

            // Solo se l'app non è mai stata aperta online: dopo, la serve il service worker.
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) view.loadDataWithBaseURL(HOME, OFFLINE_PAGE, "text/html", "utf-8", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // <input type="file">: serve per "Ripristina da un backup".
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try {
                    startActivityForResult(pick, PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        web.loadUrl(HOME);
    }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE || fileCallback == null) return;
        Uri picked = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(picked == null ? null : new Uri[]{picked});
        fileCallback = null;
    }

    /** Tasto Indietro: prima chiude la scheda carta, poi torna alla pagina precedente, infine esce. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.appBack ? window.appBack() : false", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    /** Funzioni native richiamabili dall'app web come window.Android. */
    private class Bridge {
        /**
         * Scrive la copia di sicurezza in Download/GAPokemon, una cartella che resta anche se
         * l'app viene disinstallata. Restituisce il percorso, oppure una stringa vuota se fallisce.
         */
        @JavascriptInterface
        public String saveBackup(String json) {
            try {
                ContentResolver resolver = getContentResolver();
                Uri downloads = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                Uri target = null;
                try (Cursor c = resolver.query(downloads, new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                        new String[]{BACKUP_NAME, "%GAPokemon%"}, null)) {
                    if (c != null && c.moveToFirst()) target = ContentUris.withAppendedId(downloads, c.getLong(0));
                }
                if (target == null) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, BACKUP_NAME);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, BACKUP_DIR);
                    target = resolver.insert(downloads, values);
                }
                try (OutputStream out = resolver.openOutputStream(target, "wt")) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
                return "Download/GAPokemon/" + BACKUP_NAME;
            } catch (Exception e) {
                return "";
            }
        }
    }
}
