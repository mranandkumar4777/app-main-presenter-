// In-app updates for the Android remote.
//  - Web files (this launcher + built-in remote): silent over-the-air update via @capgo/capacitor-updater.
//  - New APK: "Update Available" popup -> downloads the APK and opens Android's installer (no uninstall).
// Both read mobile-version.json from the rolling GitHub release "mobile-latest" (written by android.yml).
(function(){
  var REPO = 'mranandkumar4777/p1-app-pc';
  var MANIFEST = 'https://github.com/' + REPO + '/releases/download/mobile-latest/mobile-version.json';
  var P = (window.Capacitor && window.Capacitor.Plugins) || {};
  var Upd = P.CapacitorUpdater, AppP = P.App, Apk = P.ApkInstaller, Http = P.CapacitorHttp;

  // Must run on every start, or Capgo assumes the new web bundle is broken and rolls back.
  if(Upd){ try{ Upd.notifyAppReady(); }catch(e){} }
  if(!Upd && !Apk) return;            // opened in a normal browser: nothing to update

  function cmp(a, b){
    var pa = String(a).replace(/^v/, '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
    var pb = String(b).replace(/^v/, '').split('.').map(function(n){ return parseInt(n, 10) || 0; });
    for(var i = 0; i < Math.max(pa.length, pb.length); i++){ var d = (pa[i] || 0) - (pb[i] || 0); if(d) return d > 0 ? 1 : -1; }
    return 0;
  }
  // Native HTTP when available: github.com release downloads redirect and send no CORS headers,
  // so a plain fetch() from the WebView is blocked.
  async function getJson(url){
    url += '?t=' + Date.now();
    if(Http && Http.get){
      var r = await Http.get({ url: url, responseType: 'json', headers: { 'Cache-Control': 'no-cache' }, connectTimeout: 8000, readTimeout: 8000 });
      if(r.status !== 200) throw new Error('HTTP ' + r.status);
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }
    var f = await fetch(url, { cache: 'no-store' });
    if(!f.ok) throw new Error('HTTP ' + f.status);
    return f.json();
  }
  async function localBundleVersion(){
    try{ var r = await fetch('bundle-version.json', { cache: 'no-store' }); return (await r.json()).version || '0.0.0'; }catch(e){ return '0.0.0'; }
  }

  // ---- "Update Available" popup -------------------------------------------------------------
  function popup(m, required){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(5,9,18,.78)';
    var box = document.createElement('div');
    box.style.cssText = 'width:100%;max-width:360px;background:#131c30;border:1px solid #2a3858;border-radius:18px;padding:20px;color:#e8eefc;font:16px/1.4 system-ui,sans-serif';
    var h = document.createElement('div'); h.textContent = 'Update Available'; h.style.cssText = 'font-size:20px;font-weight:800;margin-bottom:6px';
    var t = document.createElement('div'); t.style.cssText = 'color:#8b9bbd;font-size:14px;margin-bottom:14px;white-space:pre-wrap';
    t.textContent = 'PRESENTER Remote ' + (m.version || '') + ' is ready.' + (required ? '\nThis update is needed for the app to keep working.' : '') + (m.notes ? '\n' + String(m.notes).slice(0, 300) : '');
    var msg = document.createElement('div'); msg.style.cssText = 'min-height:1.3em;font-size:14px;color:#ffc766;margin-bottom:10px';
    var go = document.createElement('button'); go.textContent = 'Update now';
    go.style.cssText = 'width:100%;min-height:52px;border-radius:14px;border:1px solid #ffc766;background:linear-gradient(#ffb02e,#e8780a);color:#2a1600;font:inherit;font-weight:800;margin-bottom:8px';
    var later = document.createElement('button'); later.textContent = 'Later';
    later.style.cssText = 'width:100%;min-height:46px;border-radius:14px;border:1px solid #2a3858;background:#1a2540;color:inherit;font:inherit;font-weight:700';
    box.appendChild(h); box.appendChild(t); box.appendChild(msg); box.appendChild(go); box.appendChild(later); wrap.appendChild(box); document.body.appendChild(wrap);
    later.onclick = function(){ try{ localStorage.setItem('pr_apk_later', String(m.versionCode)); }catch(e){} wrap.remove(); };
    go.onclick = async function(){
      go.disabled = true; later.disabled = true; msg.textContent = 'Downloading\u2026';
      var sub = null;
      try{
        if(Apk.addListener) sub = await Apk.addListener('progress', function(p){ msg.textContent = 'Downloading\u2026 ' + p.percent + '%'; });
        var r = await Apk.install({ url: m.apkUrl });
        if(r && r.needsPermission){
          await Apk.openInstallSettings();
          msg.textContent = 'Allow "Install unknown apps" for PRESENTER Remote, come back, then tap Update now again.';
        } else msg.textContent = 'Tap Install on the Android screen.';
      }catch(e){ msg.textContent = 'Update failed: ' + (e && e.message || e); }
      if(sub && sub.remove) sub.remove();
      go.disabled = false; later.disabled = false;
    };
  }

  // ---- main check (once per start) -----------------------------------------------------------
  async function run(){
    var m = await getJson(MANIFEST);
    var native = 0;
    if(AppP && AppP.getInfo){ try{ native = parseInt((await AppP.getInfo()).build, 10) || 0; }catch(e){} }
    var apkNewer = !!(Apk && m.apkUrl && native && native < (m.versionCode || 0));
    var required = !!(Apk && m.apkUrl && native && native < (m.minNativeVersionCode || 0));

    // 1) web update, silently - but not when this APK is too old to run the new web files
    if(Upd && !required && m.bundleUrl && m.bundleVersion){
      var local = await localBundleVersion();
      var tried = null; try{ tried = localStorage.getItem('pr_ota_try'); }catch(e){}
      if(cmp(m.bundleVersion, local) > 0 && tried !== m.bundleVersion){   // 'tried' stops a rollback loop
        try{
          var b = await Upd.download({ url: m.bundleUrl, version: m.bundleVersion });
          try{ localStorage.setItem('pr_ota_try', m.bundleVersion); }catch(e){}
          await Upd.set(b);                                               // reloads into the new web files
          return;
        }catch(e){}
      }
    }
    // 2) new APK -> popup (a "Later" answer is remembered for that version, unless it is required)
    var later = null; try{ later = localStorage.getItem('pr_apk_later'); }catch(e){}
    if(required || (apkNewer && later !== String(m.versionCode))) popup(m, required);
  }
  window.addEventListener('load', function(){ setTimeout(function(){ run().catch(function(){}); }, 800); });
})();
