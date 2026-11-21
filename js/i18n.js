// Arabic / English strings. Elements use data-i18n (text), data-i18n-ph
// (placeholder) and data-i18n-html (trusted markup from this file only).

const STR = {
  ar: {
    appName: 'نقل بالصوت',
    tabSend: 'إرسال', tabReceive: 'استقبال', tabHelp: 'طريقة الاستخدام',
    whatToSend: 'ماذا تريد أن ترسل؟',
    kindText: 'نص', kindImage: 'صور', kindFile: 'ملفات',
    textPh: 'اكتب رسالتك هنا…',
    pickImages: 'اختر صورة أو أكثر، أو التقط صورة',
    pickFiles: 'اختر ملفاً أو أكثر',
    filesHint: 'الملفات الصغيرة فقط عملية (بضعة كيلوبايت).',
    maxDim: 'أقصى بُعد', format: 'الصيغة', quality: 'الجودة', gray: 'أبيض وأسود (حجم أصغر)',
    webp: 'WebP (أصغر)', jpeg: 'JPEG (معاينة تدريجية)', px: '{n} بكسل',
    settings: 'الإعدادات', speed: 'السرعة',
    confirm: 'تأكيد الاستلام وإعادة الناقص تلقائياً',
    confirmHint: 'المستقبِل يرد بالصوت بما ينقصه. أطفئه للإرسال لعدة هواتف معاً.',
    protection: 'الحماية من الفقد', passes: 'عدد مرات الإرسال', volume: 'مستوى الصوت',
    none: 'بدون', recommended: '{n}٪ (مُوصى)', once: 'مرة واحدة', twice: 'مرتين', untilStop: 'حتى أوقفه',
    send: 'إرسال بالصوت', stop: 'إيقاف', ready: 'جاهز',
    enterSomething: 'أدخل نصاً أو اختر صوراً أو ملفات.',
    summary: '{items} · الحجم {size} · المدة المتوقعة {time}',
    items: '{n} عنصر', compressed: 'مضغوط',
    remove: 'إزالة',
    m_auto: 'تلقائي', m_robust: 'متين', m_normal: 'عادي', m_fast: 'سريع', m_turbo: 'فائق', m_ultra: 'خارق',
    h_auto: 'يختار الأسرع', h_robust: 'ضوضاء أو مسافة', h_normal: 'متوازن', h_fast: 'هاتفان قريبان',
    h_turbo: 'متلاصقان', h_ultra: 'سمّاعات جيدة',
    bps: '{n} بايت/ث',
    st_sending: 'يرسل {item} · الجولة {round} · {mode} · {sent}/{count}',
    st_sendingPass: 'يرسل {item} · الدورة {pass} · {sent}/{count}',
    st_waiting: 'بانتظار رد المستقبِل…',
    st_resending: 'ينقص المستقبِل {size} — يعيد إرسالها…',
    st_mode: 'تغيير السرعة إلى «{mode}»',
    st_done: 'وصل ✓ (أكّد المستقبِل الاستلام)',
    st_doneOneWay: 'اكتمل الإرسال ✓',
    st_allDone: 'اكتمل ✓ — وصل {n} من {total}',
    st_noReply: 'لم يصل رد من المستقبِل. تأكد أنه يستمع، قرّب الهاتفين، أو أطفئ «تأكيد الاستلام».',
    st_stopped: 'أُوقف الإرسال',
    st_failed: 'تعذّر الإرسال',
    nothingToSend: 'لا يوجد ما يُرسل', tooLarge: 'الملف كبير جداً', badImage: 'تعذّر فتح الصورة',
    listen: 'ابدأ الاستماع', stopListen: 'إيقاف الاستماع',
    rxIdle: 'اضغط «ابدأ الاستماع» ثم ابدأ الإرسال من الهاتف الآخر.',
    rxListening: 'يستمع… ابدأ الإرسال من الهاتف الآخر.',
    rxSync: 'التُقطت إشارة ({mode})…',
    rxReceiving: 'يستقبل…',
    rxBad: 'حزمة تالفة — قرّب الهاتفين أو ارفع الصوت.',
    rxReplying: 'يرسل الرد للمرسِل…',
    rxDone: 'اكتمل الاستقبال ✓',
    rxDoneErr: 'اكتمل مع خطأ: {e}',
    rxStopped: 'متوقف.',
    micInsecure: 'الميكروفون يحتاج فتح التطبيق عبر https.',
    micDenied: 'لم يُسمح باستخدام الميكروفون. فعّل الإذن من إعدادات المتصفح.',
    rxStats: 'حزم سليمة: {ok} · تالفة: {bad} · وضوح الإشارة: {q}٪',
    waitingMeta: '{n} حزمة — بانتظار معلومات الملف',
    curInfo: '{size} · {pct}٪{left}', leftAbout: ' · متبقٍ نحو {t}',
    receiving: 'جاري الاستقبال…',
    received: 'المستلَم', clearAll: 'مسح الكل', confirmClear: 'حذف كل العناصر المستلمة؟',
    empty: 'لا شيء بعد.',
    copy: 'نسخ', copied: 'نُسخ النص', save: 'حفظ', share: 'مشاركة', del: 'حذف',
    message: 'رسالة', kText: 'نص', kImage: 'صورة', kFile: 'ملف',
    errCrc: 'فشل فحص السلامة — قد يكون الملف تالفاً', errInflate: 'تعذّر فك الضغط', errNoInflate: 'المتصفح لا يدعم فك الضغط',
    b: '{n} بايت', kb: '{n} ك.ب', mb: '{n} م.ب', s: '{n} ث', m: '{m} د {s} ث', mOnly: '{m} د', h: '{h} س {m} د',
    helpHtml: `
      <h2>طريقة الاستخدام</h2>
      <ol>
        <li>افتح التطبيق على الهاتفين.</li>
        <li>على الهاتف المستقبِل: «استقبال» ← «ابدأ الاستماع» واسمح بالميكروفون.</li>
        <li>على الهاتف المرسِل: اختر نصاً أو صوراً أو ملفات ثم «إرسال بالصوت» واسمح بالميكروفون (ليسمع رد المستقبِل).</li>
        <li>ضع الهاتفين قريبين (10–30 سم)، مكبّر صوت كلٍّ منهما باتجاه الآخر.</li>
      </ol>
      <h3>تلقائي بالكامل</h3>
      <ul>
        <li><b>السرعة «تلقائي»</b> تبدأ بالسرعة التي نجحت آخر مرة، ثم ترفعها أو تخفضها حسب ما يصل فعلاً.</li>
        <li><b>تأكيد الاستلام</b>: بعد كل جولة يرد المستقبِل بالصوت بما ينقصه، فيُعاد الناقص فقط حتى يكتمل الملف.</li>
        <li>بدون تأكيد (لعدة مستقبِلين معاً) تُضاف حزم تصحيح تعيد بناء ما يضيع.</li>
      </ul>
      <h3>نصائح</h3>
      <ul>
        <li>أصغر صورة = أسرع نقل: 200 بكسل بجودة 0.4 تكفي غالباً.</li>
        <li>ارفع الصوت، وأطفئ الوضع الصامت على آيفون، واترك الشاشة مفتوحة.</li>
        <li>المستلَم يُحفظ في الهاتف ويبقى بعد إغلاق الصفحة.</li>
      </ul>`,
    howHtml: `<h3>كيف يعمل؟</h3>
      <p>تُقسَّم البيانات إلى حزم. كل حزمة تبدأ بصفّارة مزامنة، ثم نغمات متوازية في 6–48 نطاقاً ترددياً بين 1.5 و13.5 كيلوهرتز. يصحح ترميز ريد-سولومون أخطاء كل حزمة، ويتحقق CRC من سلامتها. لا يرسل التطبيق أي بيانات عبر الإنترنت.</p>`,
    thMode: 'الوضع', thSpeed: 'السرعة', thTime: 'صورة 3 ك.ب',
  },
  en: {
    appName: 'Sound Transfer',
    tabSend: 'Send', tabReceive: 'Receive', tabHelp: 'How to use',
    whatToSend: 'What do you want to send?',
    kindText: 'Text', kindImage: 'Images', kindFile: 'Files',
    textPh: 'Type your message…',
    pickImages: 'Choose one or more images, or take a photo',
    pickFiles: 'Choose one or more files',
    filesHint: 'Only small files are practical (a few kilobytes).',
    maxDim: 'Max size', format: 'Format', quality: 'Quality', gray: 'Black & white (smaller)',
    webp: 'WebP (smaller)', jpeg: 'JPEG (progressive preview)', px: '{n} px',
    settings: 'Settings', speed: 'Speed',
    confirm: 'Confirm receipt and resend missing parts',
    confirmHint: 'The receiver answers by sound with what it is missing. Turn off to send to several phones at once.',
    protection: 'Loss protection', passes: 'Times to send', volume: 'Volume',
    none: 'None', recommended: '{n}% (recommended)', once: 'Once', twice: 'Twice', untilStop: 'Until I stop',
    send: 'Send by sound', stop: 'Stop', ready: 'Ready',
    enterSomething: 'Type a message or choose images or files.',
    summary: '{items} · size {size} · about {time}',
    items: '{n} item(s)', compressed: 'compressed',
    remove: 'Remove',
    m_auto: 'Auto', m_robust: 'Robust', m_normal: 'Normal', m_fast: 'Fast', m_turbo: 'Turbo', m_ultra: 'Ultra',
    h_auto: 'picks the fastest', h_robust: 'noise or distance', h_normal: 'balanced', h_fast: 'phones close',
    h_turbo: 'phones touching', h_ultra: 'good speakers',
    bps: '{n} B/s',
    st_sending: 'Sending {item} · round {round} · {mode} · {sent}/{count}',
    st_sendingPass: 'Sending {item} · pass {pass} · {sent}/{count}',
    st_waiting: 'Waiting for the receiver to answer…',
    st_resending: 'Receiver is missing {size} — resending…',
    st_mode: 'Switching speed to “{mode}”',
    st_done: 'Delivered ✓ (receiver confirmed)',
    st_doneOneWay: 'Sent ✓',
    st_allDone: 'Done ✓ — {n} of {total} delivered',
    st_noReply: 'No answer from the receiver. Make sure it is listening, move the phones closer, or turn off “Confirm receipt”.',
    st_stopped: 'Sending stopped',
    st_failed: 'Could not send',
    nothingToSend: 'Nothing to send', tooLarge: 'File too large', badImage: 'Could not open the image',
    listen: 'Start listening', stopListen: 'Stop listening',
    rxIdle: 'Press “Start listening”, then start sending on the other phone.',
    rxListening: 'Listening… start sending on the other phone.',
    rxSync: 'Signal found ({mode})…',
    rxReceiving: 'Receiving…',
    rxBad: 'Damaged packet — move the phones closer or raise the volume.',
    rxReplying: 'Answering the sender…',
    rxDone: 'Received ✓',
    rxDoneErr: 'Finished with an error: {e}',
    rxStopped: 'Stopped.',
    micInsecure: 'The microphone needs the app to be opened over https.',
    micDenied: 'Microphone not allowed. Enable it in the browser settings.',
    rxStats: 'Good packets: {ok} · damaged: {bad} · signal clarity: {q}%',
    waitingMeta: '{n} packets — waiting for file details',
    curInfo: '{size} · {pct}%{left}', leftAbout: ' · about {t} left',
    receiving: 'Receiving…',
    received: 'Received', clearAll: 'Clear all', confirmClear: 'Delete all received items?',
    empty: 'Nothing yet.',
    copy: 'Copy', copied: 'Copied', save: 'Save', share: 'Share', del: 'Delete',
    message: 'Message', kText: 'Text', kImage: 'Image', kFile: 'File',
    errCrc: 'Integrity check failed — the file may be damaged', errInflate: 'Could not decompress', errNoInflate: 'This browser cannot decompress',
    b: '{n} B', kb: '{n} KB', mb: '{n} MB', s: '{n} s', m: '{m} min {s} s', mOnly: '{m} min', h: '{h} h {m} min',
    helpHtml: `
      <h2>How to use</h2>
      <ol>
        <li>Open the app on both phones.</li>
        <li>Receiving phone: “Receive” → “Start listening”, and allow the microphone.</li>
        <li>Sending phone: choose a message, images or files → “Send by sound”, and allow the microphone (to hear the receiver's answer).</li>
        <li>Keep the phones close (10–30 cm), speakers facing each other.</li>
      </ol>
      <h3>Fully automatic</h3>
      <ul>
        <li><b>Auto speed</b> starts at the speed that worked last time and moves up or down based on what actually arrives.</li>
        <li><b>Confirm receipt</b>: after each round the receiver answers by sound with what is missing, and only that is resent.</li>
        <li>Without confirmation (several receivers at once), extra repair packets rebuild what gets lost.</li>
      </ul>
      <h3>Tips</h3>
      <ul>
        <li>Smaller image = faster: 200 px at quality 0.4 is usually enough.</li>
        <li>Turn the volume up, switch off silent mode on iPhone, keep the screen on.</li>
        <li>Received items are stored on the phone and stay after closing the page.</li>
      </ul>`,
    howHtml: `<h3>How does it work?</h3>
      <p>Data is split into packets. Each packet starts with a sync chirp, followed by parallel tones in 6–48 frequency groups between 1.5 and 13.5 kHz. Reed–Solomon coding fixes errors in each packet and a CRC checks it. Nothing is sent over the internet.</p>`,
    thMode: 'Mode', thSpeed: 'Speed', thTime: '3 KB image',
  },
};

let lang = 'ar';
try {
  const saved = localStorage.getItem('lang');
  if (saved === 'ar' || saved === 'en') lang = saved;
  else if (!(navigator.language || '').startsWith('ar')) lang = 'en';
} catch { /* storage blocked */ }

export function getLang() {
  return lang;
}

export function t(key, vars = {}) {
  let s = STR[lang][key] ?? STR.ar[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function applyLang(root = document) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('appName');
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
}

export function setLang(l) {
  lang = l;
  try { localStorage.setItem('lang', l); } catch { /* storage blocked */ }
  applyLang();
}

export function fmtBytes(n) {
  if (n < 1024) return t('b', { n });
  if (n < 1024 * 1024) return t('kb', { n: (n / 1024).toFixed(1) });
  return t('mb', { n: (n / 1024 / 1024).toFixed(2) });
}

export function fmtTime(sec) {
  if (!isFinite(sec)) return '∞';
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return t('s', { n: sec });
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? t('m', { m, s }) : t('mOnly', { m });
  return t('h', { h: Math.floor(m / 60), m: m % 60 });
}
