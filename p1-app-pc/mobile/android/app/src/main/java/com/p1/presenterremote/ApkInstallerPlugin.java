package com.p1.presenterremote;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads a new APK (from a GitHub release) and hands it to Android's package installer.
 * Android never allows a silent install: the user taps "Update" once on the system screen.
 * The new APK installs over the old one (no uninstall) as long as it has the same signing key
 * and a higher versionCode.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", canInstall());
        call.resolve(r);
    }

    /** Opens the "Install unknown apps" screen for this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings: " + e.getMessage());
        }
    }

    /** install({ url }) - emits "progress" { percent } while downloading, then opens the installer. */
    @PluginMethod
    public void install(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("A https:// url is required."); return; }
        if (!canInstall()) {
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);   // JS then calls openInstallSettings() and asks the user to try again
            return;
        }
        new Thread(() -> {
            try {
                Context ctx = getContext();
                File dir = new File(ctx.getCacheDir(), "updates");
                if (!dir.exists()) dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                File apk = new File(dir, "PresenterRemote.apk");

                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);   // GitHub redirects release downloads (https -> https)
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("Download failed (HTTP " + code + ")");
                long total = c.getContentLengthLong();
                long done = 0; int lastPct = -1;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[32 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct != lastPct) { lastPct = pct; JSObject p = new JSObject(); p.put("percent", pct); notifyListeners("progress", p); }
                        }
                    }
                }
                if (apk.length() < 100 * 1024) throw new Exception("Downloaded file is too small to be the app.");

                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                JSObject r = new JSObject();
                r.put("started", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed." : e.getMessage());
            }
        }).start();
    }
}
