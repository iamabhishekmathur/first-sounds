package ca.firstsounds.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/** Full-screen WebView wrapper for the First Sounds site, with a TTS bridge. */
public class MainActivity extends Activity {
    private static final String HOST = "first-sounds-two.vercel.app";
    private static final String START_URL = "https://" + HOST + "/?tv=1";
    private static final String UA_SUFFIX = " FirstSoundsTV/1";

    private WebView webView;
    private TextView errorView;
    private final Handler main = new Handler(Looper.getMainLooper());

    // Written on the UI thread, read on the JS bridge thread.
    private volatile boolean trustedPage = false;
    private boolean loadFailed = false;

    // Text to speech
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile boolean ttsFailed = false;
    private String pendingSpeech; // guarded by this

    static boolean isTrusted(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            return "https".equals(u.getScheme()) && HOST.equalsIgnoreCase(u.getHost()) && u.getPort() == -1;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.cream));

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.cream));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = new TextView(this);
        errorView.setText(R.string.offline_message);
        errorView.setTextColor(getColor(R.color.brown));
        errorView.setBackgroundColor(getColor(R.color.cream));
        errorView.setTextSize(36f);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(120, 60, 120, 60);
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new Client());
        webView.addJavascriptInterface(new Bridge(), "FirstSoundsTV");

        initTts();
        webView.loadUrl(START_URL);
        webView.requestFocus();
    }

    // ---- WebView client ----
    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            // Stay on our origin; ignore everything else.
            return !isTrusted(r.getUrl().toString());
        }

        @Override
        public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
            trustedPage = isTrusted(url);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            trustedPage = isTrusted(url) && !loadFailed;
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame()) showError();
        }

        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
            if (r.isForMainFrame() && resp.getStatusCode() >= 500) showError();
        }

        @Override
        public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler h, android.net.http.SslError e) {
            h.cancel();
            showError();
        }
    }

    private void showError() {
        loadFailed = true;
        trustedPage = false;
        errorView.setVisibility(View.VISIBLE);
        errorView.requestFocus();
    }

    private void retry() {
        loadFailed = false;
        errorView.setVisibility(View.GONE);
        webView.loadUrl(START_URL);
        webView.requestFocus();
    }

    // ---- JS bridge (only speak) ----
    private class Bridge {
        @JavascriptInterface
        public void speak(String text) {
            if (!trustedPage || text == null) return; // ignore calls from other origins
            if (text.length() > 300) text = text.substring(0, 300);
            doSpeak(text);
        }
    }

    private void initTts() {
        try {
            tts = new TextToSpeech(getApplicationContext(), status -> {
                if (status != TextToSpeech.SUCCESS) {
                    ttsFailed = true;
                    return;
                }
                try {
                    tts.setLanguage(Locale.ENGLISH);
                    tts.setSpeechRate(0.85f);
                } catch (Exception ignored) { }
                String p;
                synchronized (MainActivity.this) {
                    ttsReady = true;
                    p = pendingSpeech;
                    pendingSpeech = null;
                }
                if (p != null) doSpeak(p);
            });
        } catch (Exception e) {
            ttsFailed = true;
        }
    }

    private void doSpeak(String text) {
        try {
            synchronized (this) {
                if (ttsFailed || tts == null) return;
                if (!ttsReady) { pendingSpeech = text; return; } // queue one
            }
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "fs");
        } catch (Exception ignored) { }
    }

    // ---- Keys ----
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (errorView.getVisibility() == View.VISIBLE) {
            if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER
                    || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                retry();
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                if (event.getRepeatCount() == 0) finish();
                return true;
            }
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.getRepeatCount() == 0) handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) return true;
        return super.onKeyUp(keyCode, event);
    }

    private void handleBack() {
        if (!trustedPage) { finish(); return; }
        final AtomicBoolean done = new AtomicBoolean(false);
        final Runnable fallback = () -> { if (done.compareAndSet(false, true)) finish(); };
        main.postDelayed(fallback, 1500);
        try {
            webView.evaluateJavascript(
                    "(function(){try{return (window.FirstSoundsTV_onBack && window.FirstSoundsTV_onBack()) === true;}catch(e){return false;}})()",
                    result -> {
                        if (!done.compareAndSet(false, true)) return;
                        main.removeCallbacks(fallback);
                        if (!"true".equals(result)) finish();
                    });
        } catch (Exception e) {
            if (done.compareAndSet(false, true)) { main.removeCallbacks(fallback); finish(); }
        }
    }

    // ---- Lifecycle / window ----
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    // Reload when the app comes back after a while in the background, so the TV picks up
    // new versions of the site without a force-stop. A short pause (under 10 minutes) keeps
    // the current page, so a game in progress is not interrupted.
    private static final long RELOAD_AFTER_MS = 10 * 60 * 1000L;
    private long pausedAt = 0L;

    @Override protected void onResume() {
        super.onResume();
        webView.onResume();
        if (pausedAt > 0 && android.os.SystemClock.elapsedRealtime() - pausedAt > RELOAD_AFTER_MS) {
            webView.reload();
        }
        pausedAt = 0L;
    }
    @Override protected void onPause() {
        pausedAt = android.os.SystemClock.elapsedRealtime();
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignored) { }
        if (webView != null) { webView.removeJavascriptInterface("FirstSoundsTV"); webView.destroy(); }
        super.onDestroy();
    }
}
