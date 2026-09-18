// UI language: English or Korean. Shared by the widget and the status panel
// (both load this before their own script).
//
// The English text is the key, so code reads t('Log in') and English needs no
// table at all. Static markup opts in with attributes instead:
//   data-i18n         the element's own text
//   data-i18n-title   its title (tooltip)
// The English original is captured the first time an element is translated,
// so switching back to English needs nothing stored anywhere.
//
// Deliberately left English in every language: the usage labels (Current
// Session, Weekly, Resets...), everything in the docked bar, and the CPU/GPU
// hover detail. The bar's widths are measured to the pixel against these exact
// strings (see CLAUDE.md), and the rest reads as data, not prose.

const I18N_KO = {
    // Loading / login
    'Loading usage data...': '사용량을 불러오는 중...',
    'Connect to Claude.ai': 'Claude.ai에 연결',
    'Log in to your Claude account': 'Claude 계정으로 로그인하세요',
    "If auto-login doesn't work, use Manual to paste your session key — Claude.ai may block embedded browsers.":
        '로그인이 안 되면 "직접 입력"으로 세션 키를 붙여 넣으세요. Claude.ai가 앱 안의 브라우저를 막을 수 있어요.',
    'Only tracking Codex?': 'Codex만 쓰나요?',
    'Change what to track': '추적 대상 바꾸기',
    'Log in': '로그인',
    'Manual →': '직접 입력 →',
    'Paste your Session Key': '세션 키 붙여넣기',
    'Open claude.ai': 'claude.ai 열기',
    'Connect': '연결',
    '← Back': '← 뒤로',
    'Waiting...': '기다리는 중...',
    'Validating...': '확인 중...',
    'Login failed': '로그인 실패',
    'Login window closed': '로그인 창이 닫혔어요',
    'Session invalid. Try again or use Manual →': '세션이 유효하지 않아요. 다시 시도하거나 "직접 입력"을 쓰세요 →',
    'Please paste your session key': '세션 키를 붙여 넣어 주세요',
    'Invalid session key': '잘못된 세션 키',
    'Connection failed. Check your key.': '연결 실패. 키를 확인하세요.',

    // First-run chooser
    'What do you want to track?': '무엇을 추적할까요?',
    'You can change this later in Settings.': '나중에 설정에서 바꿀 수 있어요.',
    'Both': '둘 다',

    // Title bar and control tooltips
    'Settings': '설정',
    'Refresh': '새로고침',
    'Toggle Usage Graph': '사용량 그래프',
    'Dock to screen edge': '화면 끝에 붙이기',
    'Minimise to System Tray': '최소화',
    'Exit Application': '종료',
    'Compact mode': '컴팩트 모드',
    'Normal mode': '일반 모드',
    'Undock (back to widget)': '위젯으로 돌아가기',
    'Refresh Claude usage': 'Claude 사용량 새로고침',
    'System details': '시스템 정보',

    // Codex
    'Codex is signed in, but no usage is recorded yet.': 'Codex에 로그인돼 있지만 아직 사용 기록이 없어요.',
    'Codex is not set up on this PC.': '이 PC에 Codex가 설정돼 있지 않아요.',
    'No Codex usage on this PC yet.': '이 PC에 아직 Codex 사용 기록이 없어요.',
    'No Codex usage yet — connect ChatGPT in Settings, or use Codex on this PC.':
        '아직 Codex 사용 기록이 없어요 — 설정에서 ChatGPT를 연결하거나 이 PC에서 Codex를 쓰세요.',
    'Connecting…': '연결 중…',
    'ChatGPT connected': 'ChatGPT 연결됨',
    'Reconnect ChatGPT': 'ChatGPT 다시 연결',
    'Connect ChatGPT': 'ChatGPT 연결',
    'Hide Codex': 'Codex 숨기기',
    'This plan has no 5-hour limit, only the weekly one.': '이 요금제는 5시간 한도 없이 주간 한도만 있어요.',
    'Track Claude only. Change it back in Settings → Track.': 'Claude만 추적해요. 설정 → 추적에서 되돌릴 수 있어요.',
    'Codex limits come live from your ChatGPT account. Click to disconnect.':
        'Codex 한도를 ChatGPT 계정에서 실시간으로 가져와요. 클릭하면 연결을 끊어요.',
    'The ChatGPT sign-in expired. Click to sign in again.': 'ChatGPT 로그인이 만료됐어요. 클릭해서 다시 로그인하세요.',
    'Sign in to ChatGPT in your browser so Codex limits show here without running Codex.':
        '브라우저에서 ChatGPT에 로그인하면 Codex를 실행하지 않아도 여기서 한도를 볼 수 있어요.',
    'Disconnect ChatGPT?\n\nThe Codex rows will hide unless Codex is signed in on this PC.':
        'ChatGPT 연결을 끊을까요?\n\n이 PC에 Codex가 로그인돼 있지 않으면 Codex 줄이 사라져요.',
    'OpenAI Codex{plan}': 'OpenAI Codex{plan}',
    ' ({plan} plan)': ' ({plan} 요금제)',
    'via your connected ChatGPT account': '연결한 ChatGPT 계정',
    'via the Codex sign-in on this PC': '이 PC의 Codex 로그인',
    'Live from chatgpt.com ({via}), checked {at}': 'chatgpt.com 실시간 ({via}), 확인 {at}',
    'Includes use on other devices and the web.': '다른 기기와 웹에서 쓴 양도 포함돼요.',
    'As of the last Codex turn on this PC: {at}': '이 PC의 마지막 Codex 사용 기준: {at}',
    'ChatGPT sign-in expired — reconnect in Settings.': 'ChatGPT 로그인이 만료됐어요 — 설정에서 다시 연결하세요.',
    'Connect ChatGPT in Settings to include other devices.': '다른 기기 사용량도 보려면 설정에서 ChatGPT를 연결하세요.',

    // Reset countdowns (tooltips only — the countdowns themselves stay English)
    'Starts when a message is sent': '메시지를 보내면 시작돼요',
    'Not started — the window starts with your next message': '시작 전 — 다음 메시지부터 시작돼요',
    'Resets in {time}': '{time} 후 초기화',

    // Service status
    'Status': '상태',
    'All systems operational': '모든 서비스 정상',
    'Status unavailable': '상태 확인 불가',
    '{name} status unavailable': '{name} 상태 확인 불가',
    'Click for details': '클릭하면 자세히 보기',
    'Operational': '정상',
    'Degraded': '성능 저하',
    'Partial outage': '부분 장애',
    'Major outage': '전체 장애',
    'Maintenance': '점검 중',
    'Unknown': '알 수 없음',
    'Checking…': '확인 중…',
    'Claude service status': 'Claude 서비스 상태',
    'Codex service status': 'Codex 서비스 상태',
    'All operational': '모두 정상',
    '{failing} of {total} affected': '{total}개 중 {failing}개 문제',
    'Updated {time}': '업데이트 {time}',
    ' · refresh failed': ' · 새로고침 실패',

    // Settings. Labels sit in a 90px column (styles.css .settings-col
    // .settings-row-label): about 8 Hangul at 11px before they wrap.
    'Done': '완료',
    'Unofficial tool — not affiliated with Anthropic.': '비공식 도구 — Anthropic과 관련 없어요.',
    'Launch at startup': '시작할 때 실행',
    'Hide from taskbar': '작업 표시줄 숨김',
    'Hide from Dock': 'Dock에서 숨기기',
    'Always on top': '항상 위에',
    'Show tray stats': '트레이에 표시',
    'Track': '추적',
    'Usage Alerts': '사용량 알림',
    'Theme': '테마',
    'Dark': '다크',
    'Light': '라이트',
    'System': '시스템',
    'Organization': '조직',
    'Time format': '시간 형식',
    '12h (3:59 PM)': '12시간 (3:59 PM)',
    '24h (15:59)': '24시간 (15:59)',
    'Warn at': '경고 기준',
    'Date format': '날짜 형식',
    'Auto-refresh': '자동 새로고침',
    'Every 15s': '15초마다',
    'Every 30s': '30초마다',
    'Every 1 min': '1분마다',
    'Every 2 min': '2분마다',
    'Every 5 min': '5분마다',
    'Log Out': '로그아웃',
    'Application Version: v{version}': '버전 v{version}',
    'Not supported on Linux': 'Linux에서는 지원 안 돼요',
    'Not supported in portable mode!': '포터블 버전에서는 지원 안 돼요',
    'Windows only': 'Windows 전용',
    'Language': '언어',
    'Auto': '자동',
    ' (Team)': ' (팀)',
    ' (Personal)': ' (개인)',

    // Usage alerts (desktop notifications)
    'Current Session usage is at {pct}% — usage is extremely low': '현재 세션 사용량 {pct}% — 남은 양이 거의 없어요',
    'Current Session usage is at {pct}% — usage is low': '현재 세션 사용량 {pct}% — 남은 양이 적어요',
    'Weekly Limit usage is at {pct}% — usage is extremely low': '주간 한도 사용량 {pct}% — 남은 양이 거의 없어요',
    'Weekly Limit usage is at {pct}% — usage is low': '주간 한도 사용량 {pct}% — 남은 양이 적어요',
    'Weekly limit reached.': '주간 한도에 도달했어요.',
    'Session limit reached.': '세션 한도에 도달했어요.',
    'Usage resets on {date} at {time}.': '{date} {time}에 초기화돼요.',
    'Usage resets at {time}.': '{time}에 초기화돼요.',
    'Usage is available again.': '다시 사용할 수 있어요.',
};

let uiLang = 'en';

/** 'auto' follows the system language; anything else is taken as given. */
function resolveLang(pref) {
    if (pref === 'en' || pref === 'ko') return pref;
    return String(navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Translate one English string, filling {placeholders} from vars. */
function t(text, vars) {
    let out = uiLang === 'ko' && Object.prototype.hasOwnProperty.call(I18N_KO, text) ? I18N_KO[text] : text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return out;
}

/** Re-translate every opted-in element under root. */
function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = el.textContent.trim();
        el.textContent = t(el.dataset.i18nSrc);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        if (el.dataset.i18nTitleSrc === undefined) el.dataset.i18nTitleSrc = el.title;
        el.title = t(el.dataset.i18nTitleSrc);
    });
}

/** Switch language and repaint the static markup. */
function setUiLang(pref) {
    uiLang = resolveLang(pref);
    document.documentElement.lang = uiLang;
    applyI18n(document);
    return uiLang;
}
