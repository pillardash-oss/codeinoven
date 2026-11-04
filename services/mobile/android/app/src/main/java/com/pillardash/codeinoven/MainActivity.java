package com.pillardash.codeinoven;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    /**
     * The shell draws edge to edge, under the status and navigation bars.
     *
     * A sheet's scrim is the whole screen or it is a bug: an app inset by the
     * system bars can only dim down to them, which reads as the overlay stopping
     * at the notification panel. Capacitor pads the WebView on WebView versions
     * before Chromium 140 and reports zero insets, so this activity takes the
     * insets itself: the decor no longer fits system windows, the page is handed
     * the bar heights as the same CSS variables Capacitor would otherwise inject,
     * and the keyboard keeps the room the old adjustResize gave it.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        final float density = getResources().getDisplayMetrics().density;
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());

            // The page keeps the keyboard's height as real layout space, which is
            // what adjustResize used to give it; the bars stay CSS variables.
            view.setPadding(0, 0, 0, keyboardVisible ? keyboard.bottom : 0);

            String script = String.format(
                Locale.US,
                "document.documentElement.style.setProperty('--safe-area-inset-top','%dpx');" +
                "document.documentElement.style.setProperty('--safe-area-inset-right','%dpx');" +
                "document.documentElement.style.setProperty('--safe-area-inset-bottom','%dpx');" +
                "document.documentElement.style.setProperty('--safe-area-inset-left','%dpx');",
                Math.round(bars.top / density),
                Math.round(bars.right / density),
                Math.round(bars.bottom / density),
                Math.round(bars.left / density)
            );
            webView.evaluateJavascript(script, null);
            return windowInsets;
        });
        // The page is a fresh document after every load, so the variables have to
        // be written again once it commits: the listener above only fires when the
        // window changes.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                super.onPageLoaded(view);
                view.requestApplyInsets();
            }
        });
        webView.requestApplyInsets();
    }
}
